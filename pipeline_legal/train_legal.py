#!/usr/bin/env python
"""
Обучение модели фрода для юрлиц и ИП: от CSV до метрик и артефактов.

Сделан по образцу `pipeline/train_fraud.py` (физлица): та же модель, тот же
подбор порогов по деньгам, тот же формат артефактов. Отличаются данные,
признаки (`features_legal.py`) и стоимости ошибок — у бизнеса они выше.

Запуск:
    py pipeline_legal/train_legal.py

По шагам:
    1. Загружает synthetic_legal/legal_transfers.csv
    2. Считает 27 признаков (только по прошлому)
    3. Делит по времени: январь–март -> обучение, апрель -> проверка
    4. Обучает модель и калибрует вероятности
    5. Подбирает пороги 0/1/2 по стоимости ошибок (на обучающем периоде)
    6. Применяет пороги к апрелю, считает метрики, в том числе по типам фрода
    7. Сохраняет артефакты

Результат в pipeline_legal/artifacts/:
    legal_model.joblib  — модель
    thresholds.json     — пороги и стоимости
    metrics.json        — метрики
    predictions.csv     — по строке на операцию апреля
    report.md           — отчёт для человека
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
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_predict

HERE = Path(__file__).resolve().parent
BASE_DIR = HERE.parent
sys.path.insert(0, str(HERE))
# Политика 0/1/2 общая с моделью физлиц: одно бизнес-правило на всю систему
sys.path.insert(0, str(BASE_DIR / "pipeline"))

from features_legal import (FEATURES, FEATURE_DESCRIPTIONS, add_features,  # noqa: E402
                            load_operations)
from policy import make_decision  # noqa: E402

# ────────────────────────────────────────────────────────────────────────────
# НАСТРОЙКИ
# ────────────────────────────────────────────────────────────────────────────

SEED = 42
DATA_PATH = BASE_DIR / "synthetic_legal" / "legal_transfers.csv"
ARTIFACTS_DIR = HERE / "artifacts"
MODEL_FILE = "legal_model.joblib"

TEST_START = pd.Timestamp("2025-04-01")

# Стоимости для бизнеса выше, чем у физлиц (50 / 500 ₽):
#  * проверка — оператор звонит в компанию, ищет уполномоченное лицо, сверяет счёт;
#  * ложная блокировка — сорванная оплата поставщику, пени, простой, риск ухода клиента.
COSTS = {
    "review": 300,        # ручная проверка одного платежа, ₽
    "false_block": 5000,  # ложная блокировка, ₽
    "catch_rate": 0.9,    # какую долю фрода ловит оператор при проверке
}


# ────────────────────────────────────────────────────────────────────────────
# СПЛИТ И МОДЕЛЬ
# ────────────────────────────────────────────────────────────────────────────

def split_by_time(df: pd.DataFrame, test_start: pd.Timestamp):
    train = df[df["timestamp"] < test_start].copy()
    test = df[df["timestamp"] >= test_start].copy()
    if train["is_fraud"].sum() < 20 or test["is_fraud"].sum() < 5:
        raise ValueError("Слишком мало фрода в одной из частей — сдвиньте TEST_START")
    return train, test


def build_model() -> CalibratedClassifierCV:
    # Те же параметры, что у модели физлиц
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


def n_days(part: pd.DataFrame) -> int:
    return int((part["timestamp"].max().normalize() - part["timestamp"].min().normalize()).days) + 1


# ────────────────────────────────────────────────────────────────────────────
# МЕТРИКИ И СТОИМОСТЬ
# ────────────────────────────────────────────────────────────────────────────

def binary_metrics(y_true, proba) -> dict:
    return {
        "pr_auc": round(float(average_precision_score(y_true, proba)), 4),
        "roc_auc": round(float(roc_auc_score(y_true, proba)), 4),
        "brier": round(float(brier_score_loss(y_true, proba)), 4),
        "base_rate": round(float(np.mean(y_true)), 4),
    }


def decision_cost(y_true, amount, decision, costs: dict) -> float:
    is_fraud = y_true == 1
    reviewed, blocked, passed = decision == 1, decision == 2, decision == 0
    cost = reviewed.sum() * costs["review"]
    cost += (blocked & ~is_fraud).sum() * costs["false_block"]
    cost += amount[passed & is_fraud].sum()
    cost += (1 - costs["catch_rate"]) * amount[reviewed & is_fraud].sum()
    return float(cost)


def decision_report(y_true, amount, decision) -> dict:
    is_fraud = y_true == 1
    passed, reviewed, blocked = decision == 0, decision == 1, decision == 2
    blocked_true = int((blocked & is_fraud).sum())
    blocked_false = int((blocked & ~is_fraud).sum())
    return {
        "passed": int(passed.sum()),
        "reviewed": int(reviewed.sum()),
        "blocked": int(blocked.sum()),
        "fraud_total": int(is_fraud.sum()),
        "blocked_true": blocked_true,
        "blocked_false": blocked_false,
        "reviewed_fraud": int((reviewed & is_fraud).sum()),
        "reviewed_legit": int((reviewed & ~is_fraud).sum()),
        "missed_fraud": int((passed & is_fraud).sum()),
        "precision_block": round(blocked_true / max(blocked_true + blocked_false, 1), 3),
        "recall_block": round(blocked_true / max(int(is_fraud.sum()), 1), 3),
        # «остановлен» = заблокирован или отправлен на проверку
        "recall_stopped": round(int(((blocked | reviewed) & is_fraud).sum())
                                / max(int(is_fraud.sum()), 1), 3),
        "alerts": int(reviewed.sum() + blocked.sum()),
        "fraud_amount": round(float(amount[is_fraud].sum()), 2),
        "blocked_amount": round(float(amount[blocked & is_fraud].sum()), 2),
        "reviewed_amount": round(float(amount[reviewed & is_fraud].sum()), 2),
        "missed_amount": round(float(amount[passed & is_fraud].sum()), 2),
        "cost": None,
    }


def by_fraud_kind(test: pd.DataFrame, decision) -> pd.DataFrame:
    """Сколько фрода каждого типа заблокировано / на проверке / пропущено."""
    t = test.assign(decision=decision)
    t = t[t["is_fraud"] == 1]
    out = (t.groupby("fraud_kind")["decision"]
           .value_counts().unstack(fill_value=0)
           .reindex(columns=[2, 1, 0], fill_value=0))
    out.columns = ["blocked", "reviewed", "missed"]
    out["total"] = out.sum(axis=1)
    out["stopped_share"] = ((out["blocked"] + out["reviewed"]) / out["total"]).round(2)
    return out.sort_values("stopped_share")


def choose_thresholds(y_true, proba, amount, costs: dict, days: int) -> dict:
    results = []
    # У бизнеса пропущенный фрод дорогой, поэтому порог проверки бывает очень низким —
    # сетка начинается с 0.005, а не с 0.02, как у физлиц
    grid_review = np.concatenate([[0.001, 0.002, 0.003, 0.005, 0.0075, 0.01, 0.015], np.arange(0.02, 0.61, 0.02)])
    for t_review in grid_review:
        for t_block in np.arange(0.30, 0.96, 0.02):
            if t_block <= t_review:
                continue
            decision = make_decision(proba, t_review, t_block)
            total = decision_cost(y_true, amount, decision, costs)
            results.append({
                "t_review": round(float(t_review), 4),
                "t_block": round(float(t_block), 2),
                "cost_total": round(total, 2),
                "alerts_per_day": round(float((decision > 0).sum()) / days, 2),
                "blocked": int((decision == 2).sum()),
                "reviewed": int((decision == 1).sum()),
            })
    table = pd.DataFrame(results).sort_values("cost_total", kind="stable")
    best = table.iloc[0]
    return {"t_review": float(best["t_review"]), "t_block": float(best["t_block"]),
            "table": table.head(10)}


# ────────────────────────────────────────────────────────────────────────────
# АРТЕФАКТЫ
# ────────────────────────────────────────────────────────────────────────────

def md_table(rows: list[list], headers: list[str]) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    out += ["| " + " | ".join(str(c) for c in row) + " |" for row in rows]
    return "\n".join(out)


def save_artifacts(model, thresholds, metrics, cv_metrics, decisions, kinds,
                   importance, predictions, train, test) -> None:
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, ARTIFACTS_DIR / MODEL_FILE)

    (ARTIFACTS_DIR / "thresholds.json").write_text(json.dumps({
        "thresholds": {"t_review": thresholds["t_review"], "t_block": thresholds["t_block"]},
        "cost_inputs": COSTS,
        "chosen_on": "кросс-валидация по обучающему периоду",
        "metrics_at_thresholds": decisions,
        "source": DATA_PATH.relative_to(BASE_DIR).as_posix(),
        "seed": SEED,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    (ARTIFACTS_DIR / "metrics.json").write_text(json.dumps({
        "test": metrics, "cv_train": cv_metrics, "decisions": decisions,
        "by_fraud_kind": kinds.to_dict(orient="index"),
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    predictions.to_csv(ARTIFACTS_DIR / "predictions.csv", index=False, encoding="utf-8-sig")

    test_days = n_days(test)
    cost_table = md_table(
        [[r["t_review"], r["t_block"], f'{r["cost_total"]:,.0f}', r["alerts_per_day"],
          int(r["blocked"]), int(r["reviewed"])] for _, r in thresholds["table"].iterrows()],
        ["t_review", "t_block", "Стоимость, ₽", "Алертов/день", "Блокировок", "Проверок"])
    kinds_table = md_table(
        [[f"`{k}`", int(r.total), int(r.blocked), int(r.reviewed), int(r.missed),
          f"{r.stopped_share:.0%}"] for k, r in kinds.iterrows()],
        ["Тип", "Всего", "Заблокировано", "На проверку", "Пропущено", "Остановлено"])
    imp_table = md_table(
        [[f"`{f}`", f"{v:.4f}", FEATURE_DESCRIPTIONS[f]] for f, v in importance.head(12).items()],
        ["Признак", "Важность", "Смысл"])

    report = f"""# Модель фрода для юрлиц и ИП: отчёт

## Данные
- Источник: `{DATA_PATH.name}`
- Обучение: {train["timestamp"].min():%d.%m.%Y} — {train["timestamp"].max():%d.%m.%Y}, строк {len(train):,}
- Проверка: {test["timestamp"].min():%d.%m.%Y} — {test["timestamp"].max():%d.%m.%Y}, строк {len(test):,}
- Фрод: в обучении {int(train["is_fraud"].sum())}, в проверке {int(test["is_fraud"].sum())} ({test["is_fraud"].mean():.2%})

## Модель
`HistGradientBoosting` + калибровка `sigmoid`, те же параметры, что у модели физлиц.
Признаков: {len(FEATURES)} (`features_legal.py`).

## Качество на апреле
| Метрика | Значение |
|---|---|
| PR-AUC | {metrics["pr_auc"]:.4f} |
| ROC-AUC | {metrics["roc_auc"]:.4f} |
| Brier (меньше = лучше) | {metrics["brier"]:.4f} |
| Базовая доля фрода | {metrics["base_rate"]:.2%} |

## Пороги (выбраны по стоимости ошибок на обучающем периоде)
Стоимость: проверка {COSTS["review"]} ₽, ложная блокировка {COSTS["false_block"]:,} ₽,
оператор ловит {COSTS["catch_rate"]:.0%} ущерба. У физлиц — 50 ₽ и 500 ₽.

| Параметр | Значение |
|---|---|
| t_review | {thresholds["t_review"]:g} |
| t_block | {thresholds["t_block"]:.2f} |

## Решения на апреле
| Показатель | Значение |
|---|---|
| Пропущено (0) | {decisions["passed"]:,} |
| На проверку (1) | {decisions["reviewed"]:,} (из них фрод {decisions["reviewed_fraud"]}) |
| Заблокировано (2) | {decisions["blocked"]:,} |
| Всего фрода | {decisions["fraud_total"]} на {decisions["fraud_amount"]:,.0f} ₽ |
| Поймано блокировкой | {decisions["blocked_true"]} на {decisions["blocked_amount"]:,.0f} ₽ |
| Пропущено (прошло) | {decisions["missed_fraud"]} на {decisions["missed_amount"]:,.0f} ₽ |
| Ложных блокировок | {decisions["blocked_false"]} |
| Precision блокировки | {decisions["precision_block"]:.1%} |
| Остановлено фрода (блок + проверка) | {decisions["recall_stopped"]:.1%} |
| Доля ущерба остановлена | {1 - decisions["missed_amount"] / max(decisions["fraud_amount"], 1):.1%} |
| Алертов в день | {decisions["alerts"] / test_days:.1f} |
| Стоимость решений, ₽ | {decisions["cost"]:,.0f} |

## По типам мошенничества
{kinds_table}

## Самые важные признаки
Важность — насколько падает PR-AUC на апреле, если перемешать значения признака.
{imp_table}

## Ближайшие альтернативы порогов (обучающий период)
{cost_table}

## Все признаки
{md_table([[f"`{f}`", FEATURE_DESCRIPTIONS[f]] for f in FEATURES], ["Признак", "Смысл"])}

## Ограничения
- Данные синтетические, фрод размечен по заложенным типологиям — на реальном банке
  качество будет заметно ниже.
- Результат зависит от конкретной генерации: на датасетах с seed 1, 2, 3 PR-AUC на апреле
  0,91 / 0,84 / 0,84. Seed 42 — удачный, честный ориентир — 0,84–0,96.
- Самый сильный сигнал — «получатель новый» (`days_since_first_payee`): почти весь фрод
  идёт на новые счета. Если мошенник сначала сделает пару мелких «легальных» платежей
  тому же счёту, модель его хуже увидит.
- Стоимости ошибок — допущения; при других числах пороги сдвинутся.
- Не основание для реальных блокировок без проверки на исторических данных банка.
"""
    (ARTIFACTS_DIR / "report.md").write_text(report, encoding="utf-8")


def permutation_importance_pr(model, X: pd.DataFrame, y, seed: int) -> pd.Series:
    """Важность признака = на сколько падает PR-AUC, если его перемешать."""
    rng = np.random.default_rng(seed)
    base = average_precision_score(y, model.predict_proba(X)[:, 1])
    drops = {}
    for f in X.columns:
        Xp = X.copy()
        Xp[f] = rng.permutation(Xp[f].to_numpy())
        drops[f] = base - average_precision_score(y, model.predict_proba(Xp)[:, 1])
    return pd.Series(drops).sort_values(ascending=False)


def main() -> None:
    print("=" * 72)
    print("1. Загрузка данных")
    df = load_operations(DATA_PATH, require_labels=True)
    print(f"   строк: {len(df):,} | фрод: {df['is_fraud'].sum()} ({df['is_fraud'].mean():.2%})")

    print("\n2. Расчёт признаков")
    df = add_features(df)
    print(f"   признаков: {len(FEATURES)}")

    print("\n3. Сплит по времени")
    train, test = split_by_time(df, TEST_START)
    print(f"   обучение: {len(train):,} строк, фрод {int(train.is_fraud.sum())}")
    print(f"   проверка: {len(test):,} строк, фрод {int(test.is_fraud.sum())}")

    print("\n4. Обучение модели")
    model = build_model()
    model.fit(train[FEATURES], train["is_fraud"])
    proba_test = model.predict_proba(test[FEATURES])[:, 1]
    print("   готово")

    print("\n5. Метрики на апреле")
    metrics = binary_metrics(test["is_fraud"], proba_test)
    for k, v in metrics.items():
        print(f"   {k:<10} {v}")

    print("\n6. Подбор порогов по стоимости ошибок (на обучающем периоде)")
    oof = cross_val_predict(
        build_model(), train[FEATURES], train["is_fraud"],
        cv=StratifiedKFold(n_splits=4, shuffle=True, random_state=SEED),
        method="predict_proba")[:, 1]
    cv_metrics = binary_metrics(train["is_fraud"].values, oof)
    thresholds = choose_thresholds(train["is_fraud"].values, oof, train["amount"].values,
                                   COSTS, days=n_days(train))
    print(f"   t_review = {thresholds['t_review']:g}, t_block = {thresholds['t_block']:g}")

    print("\n7. Применение порогов к апрелю")
    decision = make_decision(proba_test, thresholds["t_review"], thresholds["t_block"])
    decisions = decision_report(test["is_fraud"].values, test["amount"].values, decision)
    decisions["cost"] = round(decision_cost(test["is_fraud"].values, test["amount"].values,
                                            decision, COSTS), 2)
    for k in ("passed", "reviewed", "blocked", "blocked_true", "blocked_false",
              "reviewed_fraud", "missed_fraud", "precision_block", "recall_stopped",
              "missed_amount", "cost"):
        print(f"   {k:<16} {decisions[k]}")
    kinds = by_fraud_kind(test, decision)
    print("\n   По типам фрода:")
    print("   " + kinds.to_string().replace("\n", "\n   "))

    print("\n8. Важность признаков (перестановкой, на апреле)")
    importance = permutation_importance_pr(model, test[FEATURES], test["is_fraud"], SEED)
    print("   " + importance.head(8).round(4).to_string().replace("\n", "\n   "))

    print("\n9. Сохранение артефактов")
    predictions = pd.DataFrame({
        "timestamp": test["timestamp"].dt.strftime("%Y-%m-%d %H:%M:%S"),
        "client_id": test["client_id"],
        "client_type": test["client_type"],
        "receiver_account": test["receiver_account"],
        "receiver_type": test["receiver_type"],
        "purpose": test["purpose"],
        "amount": test["amount"],
        "client_balance": test["client_balance"],
        "p_fraud": proba_test.round(4),
        "decision": decision,
        "is_fraud": test["is_fraud"],
        "fraud_kind": test["fraud_kind"],
        "is_new_receiver": test["is_new_receiver"],
        "known_inn_new_account": test["known_inn_new_account"],
        "access_changed_48h": test["access_changed_48h"],
    }).sort_values("p_fraud", ascending=False)
    save_artifacts(model, thresholds, metrics, cv_metrics, decisions, kinds,
                   importance, predictions, train, test)
    print(f"   {ARTIFACTS_DIR}")
    print("\nГотово. Отчёт: pipeline_legal/artifacts/report.md")


if __name__ == "__main__":
    main()
