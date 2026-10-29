#!/usr/bin/env python
"""
Пайплайн обучения модели фрода: от CSV до метрик и артефактов.

Запуск:
    py pipeline/train_fraud.py

Что делает по шагам:
    1. Загружает synthetic/bank_transfers.csv
    2. Считает признаки из истории (только по прошлому, без утечки)
    3. Делит данные по времени: январь-февраль -> обучение, март -> проверка
    4. Обучает модель и калибрует вероятности
    5. Подбирает пороги 0/1/2 по стоимости ошибок
    6. Считает метрики на марте и сохраняет артефакты

Результат в pipeline/artifacts/:
    fraud_model.joblib  — модель (загружается одной строкой)
    thresholds.json     — пороги и входные стоимости
    metrics.json        — метрики в машинном виде
    predictions.csv     — по одной строке на операцию теста
    report.md           — человекочитаемый отчёт

Структура папки:
    features.py         — расчёт 13 признаков (общий код для обучения и прода)
    policy.py           — вероятность -> решение 0/1/2
    train_fraud.py      — этот файл: обучение и артефакты
    predict_example.py  — пример применения модели (то, что нужно бэкенду)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import (average_precision_score, brier_score_loss,
                             confusion_matrix, precision_score, recall_score,
                             roc_auc_score)
from sklearn.model_selection import StratifiedKFold, cross_val_predict

# Признаки и политика решений живут в отдельных модулях: тот же код
# используется при предсказании, иначе train и прод разойдутся.
# sys.path нужен, чтобы скрипт работал и как `py pipeline/train_fraud.py`,
# и при импорте из другой папки.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from features import (FEATURES, FEATURE_DESCRIPTIONS, add_features,  # noqa: E402
                      load_operations)
from policy import make_decision  # noqa: E402

# ────────────────────────────────────────────────────────────────────────────
# НАСТРОЙКИ — всё, что может захотеть поменять человек, живёт здесь
# ────────────────────────────────────────────────────────────────────────────

SEED = 42

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_PATH = BASE_DIR / "synthetic" / "bank_transfers.csv"
ARTIFACTS_DIR = Path(__file__).resolve().parent / "artifacts"

# Граница сплита: всё раньше — обучение, всё позже — проверка
TEST_START = pd.Timestamp("2025-03-01")

# Список признаков и их описания — в features.py (общий контракт с продом).
# Здесь только то, что относится к обучению.

COSTS = {
    "review": 50,        # ручная проверка одной операции, ₽
    "false_block": 500,  # ложная блокировка: компенсация, разбор, репутация
    "catch_rate": 0.9,   # какую долю фрода ловит оператор при проверке
}


def split_by_time(df: pd.DataFrame, test_start: pd.Timestamp):
    train = df[df["timestamp"] < test_start].copy()
    test = df[df["timestamp"] >= test_start].copy()

    if train["is_fraud"].sum() < 20 or test["is_fraud"].sum() < 5:
        raise ValueError("Слишком мало фрода в одной из частей — сдвиньте TEST_START")

    return train, test


def build_model() -> CalibratedClassifierCV:
    base = HistGradientBoostingClassifier(
        max_iter=300,
        learning_rate=0.06,
        max_leaf_nodes=15,
        min_samples_leaf=20,
        l2_regularization=1.0,
        class_weight="balanced",
        random_state=SEED,
    )
    return CalibratedClassifierCV(estimator=base, method="sigmoid", cv=3)


# ────────────────────────────────────────────────────────────────────────────
# ШАГ 5. Метрики и стоимость решений
# ────────────────────────────────────────────────────────────────────────────

def binary_metrics(y_true, proba) -> dict:
    return {
        "pr_auc": round(float(average_precision_score(y_true, proba)), 4),
        "roc_auc": round(float(roc_auc_score(y_true, proba)), 4),
        "brier": round(float(brier_score_loss(y_true, proba)), 4),
        "base_rate": round(float(np.mean(y_true)), 4),
    }


# make_decision живёт в policy.py: это бизнес-правило, а не часть обучения.
# Пороги в него приходят из artifacts/thresholds.json.


def decision_cost(y_true, amount, decision, costs: dict) -> float:
    is_fraud = y_true == 1
    is_legit = ~is_fraud
    reviewed = decision == 1
    blocked = decision == 2
    passed = decision == 0

    cost = reviewed.sum() * costs["review"]
    cost += (blocked & is_legit).sum() * costs["false_block"]
    cost += amount[passed & is_fraud].sum()
    cost += (1 - costs["catch_rate"]) * amount[reviewed & is_fraud].sum()
    return float(cost)


def decision_report(y_true, amount, decision) -> dict:
    is_fraud = y_true == 1
    passed = decision == 0
    reviewed = decision == 1
    blocked = decision == 2

    blocked_true = int((blocked & is_fraud).sum())
    blocked_false = int((blocked & ~is_fraud).sum())
    passed_fraud = int((passed & is_fraud).sum())
    reviewed_fraud = int((reviewed & is_fraud).sum())

    fraud_amount = float(amount[is_fraud].sum())
    return {
        "passed": int(passed.sum()),
        "reviewed": int(reviewed.sum()),
        "blocked": int(blocked.sum()),
        "fraud_total": int(is_fraud.sum()),
        "blocked_true": blocked_true,
        "blocked_false": blocked_false,
        "reviewed_fraud": reviewed_fraud,
        "missed_fraud": passed_fraud,          # именно пропущено, а не «не заблокировано»
        "precision_block": round(blocked_true / max(blocked_true + blocked_false, 1), 3),
        "recall_block": round(blocked_true / max(blocked_true + passed_fraud
                                                 + reviewed_fraud, 1), 3),
        "alerts": int(reviewed.sum() + blocked.sum()),
        "fraud_amount": round(fraud_amount, 2),
        "blocked_amount": round(float(amount[blocked & is_fraud].sum()), 2),
        "reviewed_amount": round(float(amount[reviewed & is_fraud].sum()), 2),
        "missed_amount": round(float(amount[passed & is_fraud].sum()), 2),
        "cost": None,  # заполним ниже
    }


def choose_thresholds(y_true, proba, amount, costs: dict, n_days: int) -> dict:
    results = []
    for t_review in np.arange(0.02, 0.61, 0.02):
        for t_block in np.arange(0.30, 0.96, 0.02):
            if t_block <= t_review:
                continue
            decision = make_decision(proba, t_review, t_block)
            total = decision_cost(y_true, amount, decision, costs)
            results.append({
                "t_review": round(float(t_review), 2),
                "t_block": round(float(t_block), 2),
                "cost_total": round(total, 2),
                "cost_per_day": round(total / n_days, 2),
                "alerts_per_day": round(float((decision > 0).sum()) / n_days, 2),
                "blocked": int((decision == 2).sum()),
                "reviewed": int((decision == 1).sum()),
            })

    table = pd.DataFrame(results).sort_values("cost_total")
    best = table.iloc[0].to_dict()
    return {"t_review": best["t_review"], "t_block": best["t_block"],
            "table": table.head(10)}


# ────────────────────────────────────────────────────────────────────────────
# ШАГ 6. Сохранение артефактов
# ────────────────────────────────────────────────────────────────────────────

def md_table(rows: list[list], headers: list[str]) -> str:
    """Простая markdown-таблица из списка строк."""
    out = ["| " + " | ".join(headers) + " |",
           "|" + "|".join(["---"] * len(headers)) + "|"]
    out += ["| " + " | ".join(str(c) for c in row) + " |" for row in rows]
    return "\n".join(out)


def save_artifacts(model, thresholds, cost_table, metrics, decisions,
                   predictions, train, test, cv_metrics) -> None:
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)

    joblib.dump(model, ARTIFACTS_DIR / "fraud_model.joblib")

    thresholds_payload = {
        "thresholds": {k: v for k, v in thresholds.items() if k != "table"},
        "cost_inputs": COSTS,
        "chosen_on": "кросс-валидация по обучающему периоду",
        "metrics_at_thresholds": decisions,
        "source": str(DATA_PATH),
        "seed": SEED,
    }
    (ARTIFACTS_DIR / "thresholds.json").write_text(
        json.dumps(thresholds_payload, ensure_ascii=False, indent=2),
        encoding="utf-8")

    # 3. Метрики в машинном виде
    (ARTIFACTS_DIR / "metrics.json").write_text(
        json.dumps({"test": metrics, "cv_train": cv_metrics,
                    "decisions": decisions}, ensure_ascii=False, indent=2),
        encoding="utf-8")

    # 4. Журнал по каждой операции теста
    predictions.to_csv(ARTIFACTS_DIR / "predictions.csv", index=False,
                       encoding="utf-8-sig")

    # 5. Отчёт для человека
    report = f"""# Модель фрода: отчёт

## Данные
- Источник: `{DATA_PATH.name}`
- Обучение: {train["timestamp"].min():%d.%m.%Y} — {train["timestamp"].max():%d.%m.%Y}, строк {len(train):,}
- Проверка: {test["timestamp"].min():%d.%m.%Y} — {test["timestamp"].max():%d.%m.%Y}, строк {len(test):,}
- Фрод: в обучении {int(train["is_fraud"].sum())}, в проверке {int(test["is_fraud"].sum())} ({test["is_fraud"].mean():.2%})

## Модель
`HistGradientBoosting` + калибровка `sigmoid`. Классы взвешены (`class_weight="balanced"`),
поэтому вероятности дополнительно калибруются — иначе 0.8 не означало бы 80%.

## Качество на отложенном периоде
| Метрика | Значение |
|---|---|
| PR-AUC | {metrics["pr_auc"]:.4f} |
| ROC-AUC | {metrics["roc_auc"]:.4f} |
| Brier (меньше = лучше) | {metrics["brier"]:.4f} |
| Базовая доля фрода | {metrics["base_rate"]:.2%} |

## Пороги (выбраны по стоимости ошибок)
Стоимость: проверка {COSTS["review"]} ₽, ложная блокировка {COSTS["false_block"]} ₽,
оператор ловит {COSTS["catch_rate"]:.0%} ущерба.

| Параметр | Значение |
|---|---|
| t_review | {thresholds["t_review"]:.2f} |
| t_block | {thresholds["t_block"]:.2f} |

## Решения на проверочном периоде
| Показатель | Значение |
|---|---|
| Пропущено (0) | {decisions["passed"]:,} |
| На проверку (1) | {decisions["reviewed"]:,} |
| Заблокировано (2) | {decisions["blocked"]:,} |
| Всего фрода | {decisions["fraud_total"]} на {decisions["fraud_amount"]:,.0f} ₽ |
| Поймано блокировкой | {decisions["blocked_true"]} на {decisions["blocked_amount"]:,.0f} ₽ |
| Ушло на проверку | {decisions["reviewed_fraud"]} на {decisions["reviewed_amount"]:,.0f} ₽ |
| Пропущено (прошло) | {decisions["missed_fraud"]} на {decisions["missed_amount"]:,.0f} ₽ |
| Ложных блокировок | {decisions["blocked_false"]} |
| Precision блокировки | {decisions["precision_block"]:.1%} |
| Recall блокировки | {decisions["recall_block"]:.1%} |
| Доля ущерба остановлена | {decisions["blocked_amount"] / max(decisions["fraud_amount"], 1):.1%} |
| Алертов в день | {(decisions["alerts"] / 31):.1f} |
| Стоимость решений, ₽ | {decisions["cost"]:,.0f} |

## Ближайшие альтернативы порогов
Ниже — стоимость на **обучающем** периоде (кросс-валидация), а не на марте:
пороги выбираются без подсматривания в тест.
{cost_table}

## Признаки
{md_table([[f"`{f}`", FEATURE_DESCRIPTIONS[f]] for f in FEATURES], ["Признак", "Смысл"])}

## Как применять
Готовый пример — `pipeline/predict_example.py`. Коротко:

```python
import json, joblib
from features import add_features, feature_matrix
from policy import make_decision

model = joblib.load("pipeline/artifacts/fraud_model.joblib")
t = json.load(open("pipeline/artifacts/thresholds.json", encoding="utf-8"))["thresholds"]

scored = add_features(df)                       # df — операции по времени
p = model.predict_proba(feature_matrix(scored))[:, 1]
decision = make_decision(p, t["t_review"], t["t_block"])
```

Признаки считаются тем же `add_features()`, что и при обучении: копия формулы
в бэкенде рано или поздно разойдётся с моделью.

## Ограничения
- Данные синтетические, 9 тыс. строк, 36 фродов на проверке — цифры оптимистичнее реальных.
- Precision 100% на марте — следствие «чистой» генерации, а не гарантия для банка.
- Пороги посчитаны на допущениях о стоимости ошибок; при других числах они сдвинутся.
- Ни одна цифра отсюда не является основанием для реальных блокировок без проверки
  на исторических данных банка и согласования с комплаенсом.

## Файлы
- `fraud_model.joblib` — модель
- `thresholds.json` — пороги и стоимости
- `metrics.json` — метрики
- `predictions.csv` — по строке на операцию
- `report.md` — этот отчёт
"""
    (ARTIFACTS_DIR / "report.md").write_text(report, encoding="utf-8")

def main() -> None:
    print("=" * 72)
    print("1. Загрузка данных")
    df = load_operations(DATA_PATH, require_labels=True)
    print(f"   строк: {len(df):,} | фрод: {df['is_fraud'].sum()} "
          f"({df['is_fraud'].mean():.2%})")

    print("\n2. Расчёт признаков")
    df = add_features(df)
    print(f"   признаков: {len(FEATURES)}")
    print(f"   новых получателей: {df['is_new_payee'].mean():.1%}")

    print("\n3. Сплит по времени")
    train, test = split_by_time(df, TEST_START)
    print(f"   обучение: {len(train):,} строк, фрод {int(train.is_fraud.sum())}")
    print(f"   проверка: {len(test):,} строк, фрод {int(test.is_fraud.sum())}")

    print("\n4. Обучение модели")
    model = build_model()
    model.fit(train[FEATURES], train["is_fraud"])
    proba_test = model.predict_proba(test[FEATURES])[:, 1]
    print("   готово")

    print("\n5. Метрики на отложенном периоде")
    metrics = binary_metrics(test["is_fraud"], proba_test)
    for k, v in metrics.items():
        print(f"   {k:<10} {v}")

    print("\n6. Подбор порогов по стоимости ошибок")
    oof = cross_val_predict(
        build_model(), train[FEATURES], train["is_fraud"],
        cv=StratifiedKFold(n_splits=4, shuffle=True, random_state=SEED),
        method="predict_proba")[:, 1]
    oof_metrics = binary_metrics(train["is_fraud"].values, oof)
    thresholds = choose_thresholds(
        train["is_fraud"].values, oof, train["amount"].values,
        COSTS, n_days=59)
    print(f"   t_review = {thresholds['t_review']:.2f}, "
          f"t_block = {thresholds['t_block']:.2f}")

    print("\n7. Применение порогов к проверочному периоду")
    decision = make_decision(proba_test, thresholds["t_review"],
                             thresholds["t_block"])
    decisions = decision_report(test["is_fraud"].values,
                                test["amount"].values, decision)
    decisions["cost"] = round(decision_cost(
        test["is_fraud"].values, test["amount"].values, decision, COSTS), 2)
    for k in ("passed", "reviewed", "blocked", "blocked_true",
              "blocked_false", "reviewed_fraud", "missed_fraud",
              "missed_amount", "precision_block", "recall_block",
              "alerts", "cost"):
        print(f"   {k:<16} {decisions[k]}")

    print("\n8. Сохранение артефактов")
    predictions = pd.DataFrame({
        "timestamp": test["timestamp"].dt.strftime("%Y-%m-%d %H:%M:%S"),
        "sender_id": test["sender_id"],
        "receiver_id": test["receiver_id"],
        "amount": test["amount"],
        "sender_balance": test["sender_balance"],
        "p_fraud": proba_test.round(4),
        "decision": decision,
        "is_fraud": test["is_fraud"],
        "is_new_payee": test["is_new_payee"],
        "amount_ratio": test["amount_ratio"].round(3),
        "night": test["night"],
    }).sort_values("p_fraud", ascending=False)

    cost_table = md_table(
        [[r["t_review"], r["t_block"], f'{r["cost_total"]:,.0f}',
          r["alerts_per_day"], int(r["blocked"]), int(r["reviewed"])]
         for _, r in thresholds["table"].iterrows()],
        ["t_review", "t_block", "Стоимость, ₽", "Алертов/день",
         "Блокировок", "Проверок"])

    save_artifacts(model, thresholds, cost_table, metrics, decisions,
                   predictions, train, test, oof_metrics)

    print(f"   {ARTIFACTS_DIR}")
    print("\nГотово. Отчёт: pipeline/artifacts/report.md")


if __name__ == "__main__":
    main()
