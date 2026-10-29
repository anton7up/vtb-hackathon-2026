#!/usr/bin/env python
"""
Пример подключения модели: операции -> вероятность фрода -> решение.

Запуск:
    py pipeline/predict_example.py
    py pipeline/predict_example.py --csv synthetic/bank_transfers.csv --top 10

Файл задуман как образец для бэкенда сайта. Две функции, которые нужны в проде:

    score_dataframe(df)              — пачка операций (история уже внутри df)
    score_new_operation(op, history) — одна новая операция на фоне истории

Обе возвращают `p_fraud` и `decision` (0 — пропустить, 1 — проверить,
2 — заблокировать). Пороги берутся из artifacts/thresholds.json, а не из кода:
их можно менять без переобучения модели.

Что важно помнить при интеграции
--------------------------------
1. Признаки считаются ТЕМ ЖЕ кодом (`features.add_features`). Любая копия
   формулы в бэкенде рано или поздно разойдётся с обучением.
2. Для признаков истории нужны прошлые операции отправителя и получателя.
   В демо они лежат в CSV; в проде — в базе. Это самая трудоёмкая часть
   подключения, и она не про модель, а про доступ к данным.
3. `score_new_operation` пересчитывает признаки по всей истории — это O(n)
   на запрос. Для демо нормально, для прода лучше держать счётчики
   (сколько переводов было, средняя сумма, первый контакт) в базе.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

# Модули лежат рядом с этим файлом. Добавляем папку в sys.path, чтобы
# `py pipeline/predict_example.py` работал из любой текущей директории.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from features import (INPUT_COLUMNS, add_features, feature_matrix,  # noqa: E402
                      load_operations)
from policy import make_decision  # noqa: E402

ARTIFACTS_DIR = Path(__file__).resolve().parent / "artifacts"
MODEL_PATH = ARTIFACTS_DIR / "fraud_model.joblib"
THRESHOLDS_PATH = ARTIFACTS_DIR / "thresholds.json"
DATA_PATH = Path(__file__).resolve().parent.parent / "synthetic" / "bank_transfers.csv"


# ────────────────────────────────────────────────────────────────────────────
# ЗАГРУЗКА АРТЕФАКТОВ
# ────────────────────────────────────────────────────────────────────────────

def load_artifacts(artifacts_dir: Path = ARTIFACTS_DIR):
    """Загружает модель и пороги. Возвращает (model, t_review, t_block).

    `.joblib` — это pickle: файл восстанавливает Python-объекты и может
    выполнить произвольный код. Загружайте только файлы из доверенного
    места (свои артефакты), никогда — присланные кем-то «на посмотреть».
    """
    model_path = Path(artifacts_dir) / "fraud_model.joblib"
    thresholds_path = Path(artifacts_dir) / "thresholds.json"

    if not model_path.exists():
        raise FileNotFoundError(
            f"Нет файла модели: {model_path}\n"
            "Сначала обучите её: py pipeline/train_fraud.py"
        )
    if not thresholds_path.exists():
        raise FileNotFoundError(f"Нет файла порогов: {thresholds_path}")

    model = joblib.load(model_path)

    with open(thresholds_path, encoding="utf-8") as f:
        payload = json.load(f)
    t_review = float(payload["thresholds"]["t_review"])
    t_block = float(payload["thresholds"]["t_block"])

    return model, t_review, t_block


# ────────────────────────────────────────────────────────────────────────────
# ПРЕДСКАЗАНИЕ
# ────────────────────────────────────────────────────────────────────────────

def score_dataframe(df: pd.DataFrame, model, t_review: float, t_block: float) -> pd.DataFrame:
    """Считает p_fraud и decision для всех строк.

    `df` — сырые операции (колонки из INPUT_COLUMNS), отсортированные
    по времени. Функция не меняет исходный датафрейм.
    """
    scored = add_features(df)
    proba = model.predict_proba(feature_matrix(scored))[:, 1]

    # NaN в вероятности — это ошибка в признаках, а не «низкий риск».
    # Без проверки NaN молча превратился бы в решение 2 (блокировка).
    if np.isnan(proba).any():
        raise ValueError(
            "Модель вернула NaN: проверьте, что все признаки посчитаны "
            "и в данных нет пропусков в amount / sender_balance."
        )

    scored = scored.copy()
    scored["p_fraud"] = proba
    scored["decision"] = make_decision(proba, t_review, t_block)
    return scored


def score_new_operation(operation: dict, history: pd.DataFrame, model,
                        t_review: float, t_block: float) -> tuple[float, int]:
    """Оценивает одну новую операцию с учётом прошлых.

    `operation` — словарь с ключами INPUT_COLUMNS:
        {"timestamp": ..., "sender_id": ..., "sender_balance": ...,
         "amount": ..., "receiver_id": ...}

    `history` — операции, которые были ДО неё. Если передать будущие строки,
    признаки истории будут посчитаны неверно: «прошлое» в них — это порядок
    строк, а не календарь.

    Возвращает (p_fraud, decision).
    """
    new_row = pd.DataFrame([operation])
    missing = [c for c in INPUT_COLUMNS if c not in new_row.columns]
    if missing:
        raise ValueError(f"В операции нет полей: {', '.join(missing)}")

    if not history.empty and not history["timestamp"].is_monotonic_increasing:
        history = history.sort_values("timestamp")

    # Новая операция дописывается в конец: для add_features она должна быть
    # последней, тогда все счётчики увидят ровно прошлые строки.
    if history.empty:
        # concat с пустым датафреймом сделал бы timestamp типом object
        combined = new_row[INPUT_COLUMNS].copy()
    else:
        combined = pd.concat(
            [history[INPUT_COLUMNS], new_row[INPUT_COLUMNS]],
            ignore_index=True,
        )

    # Бэкенд обычно присылает время строкой из JSON — приводим к datetime здесь,
    # чтобы вызывающему коду не приходилось помнить об этом.
    combined["timestamp"] = pd.to_datetime(combined["timestamp"])

    scored = add_features(combined)
    last = scored.iloc[[-1]]

    proba = model.predict_proba(feature_matrix(last))[:, 1]
    if np.isnan(proba).any():
        raise ValueError("Модель вернула NaN на новой операции")

    return float(proba[0]), int(make_decision(proba, t_review, t_block)[0])


# ────────────────────────────────────────────────────────────────────────────
# ДЕМО В КОМАНДНОЙ СТРОКЕ
# ────────────────────────────────────────────────────────────────────────────

DECISION_NAMES = {0: "пропустить", 1: "проверить", 2: "заблокировать"}


def main() -> None:
    parser = argparse.ArgumentParser(description="Пример применения модели фрода")
    parser.add_argument("--csv", default=str(DATA_PATH),
                        help="CSV с операциями (по умолчанию synthetic/bank_transfers.csv)")
    parser.add_argument("--top", type=int, default=10,
                        help="сколько самых рискованных операций показать")
    args = parser.parse_args()

    model, t_review, t_block = load_artifacts()
    print(f"Модель: {MODEL_PATH.name}")
    print(f"Пороги: t_review = {t_review}, t_block = {t_block}")

    df = load_operations(args.csv)
    print(f"Операций: {len(df):,} ({df['timestamp'].min():%d.%m.%Y} — "
          f"{df['timestamp'].max():%d.%m.%Y})")

    scored = score_dataframe(df, model, t_review, t_block)

    counts = scored["decision"].value_counts().reindex([0, 1, 2], fill_value=0)
    print("\nРешения:")
    for code in (0, 1, 2):
        print(f"  {code} — {DECISION_NAMES[code]:<14} {counts[code]:,}")
    if Path(args.csv).resolve() == DATA_PATH.resolve():
        print("  По всему файлу: январь–февраль модель видела при обучении,")
        print("  в artifacts/report.md — только за март.")

    columns = ["timestamp", "sender_id", "receiver_id", "amount", "p_fraud", "decision"]
    if "is_fraud" in scored.columns:      # в проде этой колонки не будет
        columns.append("is_fraud")

    top = scored.nlargest(args.top, "p_fraud")[columns].copy()
    top["timestamp"] = top["timestamp"].dt.strftime("%Y-%m-%d %H:%M")
    top["p_fraud"] = top["p_fraud"].round(4)
    top["decision"] = top["decision"].map(DECISION_NAMES)

    print(f"\nТоп-{args.top} по вероятности фрода:")
    print(top.to_string(index=False))

    # Демонстрация «одна операция на фоне истории» — так это вызывается из API
    last = df.iloc[-1]
    operation = {c: last[c] for c in INPUT_COLUMNS}
    p, decision = score_new_operation(operation, df.iloc[:-1], model, t_review, t_block)
    print("\nОдна новая операция (последняя строка файла):")
    print(f"  {operation['sender_id']} -> {operation['receiver_id']}, "
          f"{operation['amount']:,.0f} ₽")
    print(f"  p_fraud = {p:.4f} -> {decision} ({DECISION_NAMES[decision]})")

    print("\nГотово. Это демо на синтетических данных, а не основание "
          "для реальных блокировок.")


if __name__ == "__main__":
    main()
