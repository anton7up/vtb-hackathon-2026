#!/usr/bin/env python
"""
Пример применения модели юрлиц и ИП: платёж -> вероятность фрода -> решение.

Запуск:
    py pipeline_legal/predict_legal.py

Сделан по образцу `pipeline/predict_example.py`. Две функции для бэкенда:

    score_dataframe(df)              — пачка платежей (история уже внутри df)
    score_new_operation(op, history) — один новый платёж на фоне истории

И одна для сайта:

    to_site_response(p, decision)    — ответ в формате сайта
                                       {"class": "normal|review|block", "model_version": ...}
                                       (см. docs/transfer-classification.md)

Демо берёт реального клиента из датасета и разыгрывает четыре сценария
«нового» платежа 5 мая 2025 — после конца данных, так что история вся в прошлом.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
BASE_DIR = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(BASE_DIR / "pipeline"))

from features_legal import (INPUT_COLUMNS, add_features, feature_matrix,  # noqa: E402
                            load_operations)
from policy import make_decision  # noqa: E402

ARTIFACTS_DIR = HERE / "artifacts"
MODEL_FILE = "legal_model.joblib"
DATA_PATH = BASE_DIR / "synthetic_legal" / "legal_transfers.csv"
MODEL_VERSION = "legal-model-v1"

DECISION_NAMES = {0: "пропустить", 1: "проверить", 2: "заблокировать"}
SITE_CLASSES = {0: "normal", 1: "review", 2: "block"}   # контракт сайта


# ────────────────────────────────────────────────────────────────────────────
# ЗАГРУЗКА
# ────────────────────────────────────────────────────────────────────────────

def load_artifacts(artifacts_dir: Path = ARTIFACTS_DIR):
    """Возвращает (model, t_review, t_block).

    `.joblib` — это pickle: при загрузке может выполниться код.
    Загружайте только свои артефакты.
    """
    model_path = Path(artifacts_dir) / MODEL_FILE
    thresholds_path = Path(artifacts_dir) / "thresholds.json"
    if not model_path.exists():
        raise FileNotFoundError(f"Нет файла модели: {model_path}\n"
                                "Сначала обучите её: py pipeline_legal/train_legal.py")
    if not thresholds_path.exists():
        raise FileNotFoundError(f"Нет файла порогов: {thresholds_path}")
    model = joblib.load(model_path)
    t = json.loads(thresholds_path.read_text(encoding="utf-8"))["thresholds"]
    return model, float(t["t_review"]), float(t["t_block"])


# ────────────────────────────────────────────────────────────────────────────
# ПРЕДСКАЗАНИЕ
# ────────────────────────────────────────────────────────────────────────────

def score_dataframe(df: pd.DataFrame, model, t_review: float, t_block: float) -> pd.DataFrame:
    """p_fraud и decision для всех строк. `df` — сырые платежи по времени."""
    scored = add_features(df)
    proba = model.predict_proba(feature_matrix(scored))[:, 1]
    if np.isnan(proba).any():
        # NaN — ошибка в данных, а не «низкий риск». Без проверки он стал бы блокировкой.
        raise ValueError("Модель вернула NaN: проверьте пропуски в сырых колонках")
    scored["p_fraud"] = proba
    scored["decision"] = make_decision(proba, t_review, t_block)
    return scored


def score_new_operation(operation: dict, history: pd.DataFrame, model,
                        t_review: float, t_block: float) -> tuple[float, int]:
    """Оценивает один новый платёж на фоне истории.

    `operation` — словарь с ключами INPUT_COLUMNS (13 сырых полей).
    `history` — платежи, которые были ДО него (все клиенты: признаки
    получателя вроде «сколько клиентов платили на этот счёт» смотрят на весь банк).
    """
    missing = [c for c in INPUT_COLUMNS if c not in operation]
    if missing:
        raise ValueError(f"В операции нет полей: {', '.join(missing)}")

    new_row = pd.DataFrame([operation])[INPUT_COLUMNS]
    new_row["timestamp"] = pd.to_datetime(new_row["timestamp"])
    if not history.empty and new_row["timestamp"].iloc[0] < history["timestamp"].max():
        raise ValueError("В истории есть платежи позже новой операции — это будущее")

    combined = new_row if history.empty else pd.concat(
        [history[INPUT_COLUMNS], new_row], ignore_index=True)

    # Новая операция последняя: все счётчики истории увидят ровно прошлое
    last = add_features(combined).iloc[[-1]]
    proba = model.predict_proba(feature_matrix(last))[:, 1]
    if np.isnan(proba).any():
        raise ValueError("Модель вернула NaN на новой операции")
    return float(proba[0]), int(make_decision(proba, t_review, t_block)[0])


def to_site_response(p_fraud: float, decision: int) -> dict:
    """Ответ в формате, который ждёт сайт (lib/transfer-classifier.mjs).

    Обязательные поля — class и model_version; p_fraud сайт не требует,
    но его полезно видеть сотруднику.
    """
    return {"class": SITE_CLASSES[decision], "model_version": MODEL_VERSION,
            "p_fraud": round(p_fraud, 4)}


# ────────────────────────────────────────────────────────────────────────────
# ДЕМО
# ────────────────────────────────────────────────────────────────────────────

def demo_scenarios(history: pd.DataFrame) -> list[tuple[str, dict]]:
    """Четыре «новых» платежа реальных клиентов из датасета."""
    legit = history[history["is_fraud"] == 0] if "is_fraud" in history else history

    # ООО, у которого больше всего платежей одному поставщику за товар
    goods = legit[(legit.client_type == "OOO") & (legit.purpose == "goods")]
    top_pair = goods.groupby(["client_id", "receiver_account"]).size().idxmax()
    ooo_id, supplier_acc = top_pair
    sup = goods[(goods.client_id == ooo_id) & (goods.receiver_account == supplier_acc)]
    last_sup = sup.iloc[-1]
    ooo_last = history[history.client_id == ooo_id].iloc[-1]
    ooo_balance = round(float(ooo_last.client_balance - ooo_last.amount) + 300_000, 2)
    typical = round(float(sup["amount"].median()), 2)

    base = {
        "client_id": ooo_id, "client_type": "OOO", "client_balance": ooo_balance,
        "receiver_inn": last_sup.receiver_inn, "receiver_account": supplier_acc,
        "receiver_type": last_sup.receiver_type, "purpose": "goods",
        "channel": last_sup.channel, "device_id": last_sup.device_id,
        "hours_since_access_change": 9999, "receiver_blacklisted": 0,
    }
    normal = {**base, "timestamp": "2025-05-05 11:20:00", "amount": typical}

    # Тот же поставщик по ИНН, но счёт новый — письмо «у нас сменились реквизиты»
    bec = {**base, "timestamp": "2025-05-05 11:40:00", "amount": round(typical * 1.4, 2),
           "receiver_account": ("40702810" if last_sup.receiver_type == "UL" else "40802810")
                               + "999900000001"}

    # Захват ДБО: доступ сменили 3 часа назад, новое устройство, ночь, физлицо
    takeover = {**base, "timestamp": "2025-05-05 23:30:00",
                "amount": round(ooo_balance * 0.7, 2),
                "receiver_inn": "770000000001", "receiver_account": "40817810999900000002",
                "receiver_type": "FL", "purpose": "other", "channel": "web",
                "device_id": "X99999", "hours_since_access_change": 3}

    # ИП переводит себе на личную карту — норма
    own = legit[(legit.client_type == "IP") & (legit.receiver_type == "FL")
                & (legit.purpose == "other")]
    ip_id = own.client_id.value_counts().idxmax()
    ip_row = own[own.client_id == ip_id].iloc[-1]
    ip_last = history[history.client_id == ip_id].iloc[-1]
    ip_balance = round(float(ip_last.client_balance - ip_last.amount) + 80_000, 2)
    ip_self = {
        "timestamp": "2025-05-05 19:10:00", "client_id": ip_id, "client_type": "IP",
        "client_balance": ip_balance, "amount": round(ip_balance * 0.3, 2),
        "receiver_inn": ip_row.receiver_inn, "receiver_account": ip_row.receiver_account,
        "receiver_type": "FL", "purpose": "other", "channel": ip_row.channel,
        "device_id": ip_row.device_id, "hours_since_access_change": 9999,
        "receiver_blacklisted": 0,
    }
    return [
        ("ООО платит постоянному поставщику, обычная сумма", normal),
        ("Тот же ИНН поставщика, но НОВЫЙ счёт (подмена реквизитов)", bec),
        ("Ночью, новое устройство, доступ сменили 3 ч назад, 70% остатка физлицу", takeover),
        ("ИП переводит себе на личную карту", ip_self),
    ]


def main() -> None:
    model, t_review, t_block = load_artifacts()
    print(f"Модель: {MODEL_FILE} | пороги: t_review = {t_review:g}, t_block = {t_block:g}")

    history = load_operations(DATA_PATH)
    print(f"История: {len(history):,} платежей "
          f"({history['timestamp'].min():%d.%m.%Y} — {history['timestamp'].max():%d.%m.%Y})")

    print("\nЧетыре новых платежа 05.05.2025:\n")
    for title, op in demo_scenarios(history):
        p, decision = score_new_operation(op, history, model, t_review, t_block)
        print(f"• {title}")
        print(f"  {op['client_id']} → {op['receiver_type']} {op['receiver_account']}, "
              f"{op['amount']:,.0f} ₽ из {op['client_balance']:,.0f} ₽")
        print(f"  p_fraud = {p:.4f} → {decision} ({DECISION_NAMES[decision]})")
        print(f"  ответ сайту: {json.dumps(to_site_response(p, decision), ensure_ascii=False)}\n")

    print("Это демо на синтетических данных, а не основание для реальных блокировок.")


if __name__ == "__main__":
    main()
