#!/usr/bin/env python
"""
Признаки модели фрода: единственный источник правды.

Почему отдельный модуль
-----------------------
Признаки считаются дважды: при обучении и при каждом предсказании в сервисе.
Если код в этих двух местах разойдётся хотя бы в одной формуле, модель начнёт
тихо ошибаться — без ошибок в логах и без падений. Поэтому расчёт живёт здесь,
а `train_fraud.py` и `predict_example.py` импортируют его отсюда.

Контракт
--------
Вход — DataFrame с колонками из INPUT_COLUMNS:

    timestamp       — datetime (не строка!)
    sender_id       — счёт отправителя
    sender_balance  — баланс отправителя до операции
    amount          — сумма перевода
    receiver_id     — счёт получателя

Для обучения дополнительно нужны `label` и `is_fraud` (см. LABEL_COLUMNS).

Выход — те же строки плюс 13 колонок из FEATURES.

Два правила, которые нельзя нарушать
------------------------------------
1. Порядок FEATURES фиксирован: модель обучена именно на нём. Добавили
   признак — переобучите модель, иначе `predict_proba` упадёт или, хуже,
   молча посчитает не то.
2. Строки должны идти по возрастанию времени. Все признаки истории
   (`cumcount`, `cumsum`, `transform("first")`) смотрят на предыдущие строки:
   при перемешанном порядке «прошлое» перестаёт быть прошлым, и в модель
   попадает будущее.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

# ────────────────────────────────────────────────────────────────────────────
# КОНТРАКТ
# ────────────────────────────────────────────────────────────────────────────

# Колонки, без которых признаки не посчитать
INPUT_COLUMNS = ["timestamp", "sender_id", "sender_balance", "amount", "receiver_id"]

# Колонки, нужные только для обучения (в проде их нет)
LABEL_COLUMNS = ["label", "is_fraud"]

# Признаки в том порядке, в котором их ждёт модель.
# Порядок менять нельзя: модель обучена на этой последовательности.
FEATURES = [
    "hour",                    # час суток
    "dow",                     # день недели
    "night",                   # ночная операция (23:00–05:59)
    "amount",                  # сумма перевода
    "sender_balance",          # баланс отправителя до операции
    "amount_ratio",            # какая доля баланса уходит
    "is_new_payee",            # получатель встречается впервые
    "payee_tx_before",         # сколько раз уже переводили этому получателю
    "days_since_first_payee",  # сколько дней прошло с первого перевода ему
    "sender_tx_before",        # сколько операций было у отправителя до этой
    "amount_to_avg",           # сумма к среднему прошлому переводу отправителя
    "receiver_tx_before",      # сколько раз этот счёт получал деньги раньше
    "is_round",                # круглая сумма (кратна 100)
]

# Человеческие описания — для отчёта и документации
FEATURE_DESCRIPTIONS = {
    "hour": "час суток от 0 до 23",
    "dow": "день недели, 0 = понедельник",
    "night": "1, если операция между 23:00 и 06:00",
    "amount": "сумма перевода",
    "sender_balance": "баланс отправителя до операции",
    "amount_ratio": "amount / sender_balance, доля баланса",
    "is_new_payee": "1, если отправитель ранее не переводил этому получателю",
    "payee_tx_before": "число прошлых переводов этой пары",
    "days_since_first_payee": "дней с первого перевода этой паре",
    "sender_tx_before": "число прошлых операций отправителя",
    "amount_to_avg": "сумма / средняя прошлая сумма отправителя",
    "receiver_tx_before": "число прошлых входящих операций получателя",
    "is_round": "1, если сумма кратна 100",
}

# ────────────────────────────────────────────────────────────────────────────
# ЗАГРУЗКА
# ────────────────────────────────────────────────────────────────────────────

def load_operations(path: str | Path, require_labels: bool = False) -> pd.DataFrame:
    """Читает CSV с операциями и приводит его к виду, нужному для признаков.

    Три действия, каждое из которых важно:

    1. `parse_dates=["timestamp"]` — дата парсится сразу при чтении. Без этого
       `df["timestamp"].dt` в `add_features` упадёт: `.dt` работает только
       с datetime-колонкой.
    2. `sort_values("timestamp")` — «прошлое» в признаках означает именно
       предыдущие строки. Перемешанный файл даст утечку будущего.
    3. Проверка колонок — лучше упасть с понятным текстом, чем получить
       `KeyError` где-то в середине расчёта.

    `require_labels=True` дополнительно требует `label` и `is_fraud` —
    так обучение защищено от запуска на данных без разметки.
    """
    path = Path(path)
    df = pd.read_csv(path, parse_dates=["timestamp"])
    df = df.sort_values("timestamp").reset_index(drop=True)

    required = INPUT_COLUMNS + (LABEL_COLUMNS if require_labels else [])
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"В файле {path.name} нет колонок: {', '.join(missing)}")

    return df


# ────────────────────────────────────────────────────────────────────────────
# ПРИЗНАКИ
# ────────────────────────────────────────────────────────────────────────────

def add_features(df: pd.DataFrame) -> pd.DataFrame:
    """Добавляет 13 признаков, используя только прошлое.

    Исходный датафрейм не меняется: в начале делается копия, в конце
    возвращается новый объект.

    Каждый признак — это ответ на вопрос, который банк задал бы вручную:
    «когда», «сколько относительно обычного», «знаком ли получатель».
    Модель не получает готового правила «новый получатель + крупно = фрод»:
    она получает числа и сама находит их веса.
    """
    missing = [c for c in INPUT_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"Для расчёта признаков не хватает колонок: {', '.join(missing)}")
    if not pd.api.types.is_datetime64_any_dtype(df["timestamp"]):
        raise TypeError(
            "timestamp должен быть datetime, а не строкой. "
            "Исправляется так: df['timestamp'] = pd.to_datetime(df['timestamp'])"
        )

    df = df.copy()

    # --- время -------------------------------------------------------------
    # .dt — аксессор datetime-колонки; на строках он не работает.
    df["hour"] = df["timestamp"].dt.hour
    df["dow"] = df["timestamp"].dt.dayofweek        # понедельник = 0
    # Скобки обязательны: | связывает крепче сравнений.
    df["night"] = ((df["hour"] < 6) | (df["hour"] >= 23)).astype(int)

    # --- деньги ------------------------------------------------------------
    # clip(lower=1) защищает от деления на ноль: баланс 0 дал бы inf.
    df["amount_ratio"] = df["amount"] / df["sender_balance"].clip(lower=1)
    df["is_round"] = (df["amount"] % 100 == 0).astype(int)

    # --- история пары «отправитель → получатель» ---------------------------
    pair = ["sender_id", "receiver_id"]
    by_pair = df.groupby(pair)
    # cumcount — сколько строк этой группы было ДО текущей (нумерация с нуля)
    df["payee_tx_before"] = by_pair.cumcount()
    df["is_new_payee"] = (df["payee_tx_before"] == 0).astype(int)

    first_seen = by_pair["timestamp"].transform("first")  # первое появление пары
    df["days_since_first_payee"] = (
        (df["timestamp"] - first_seen).dt.total_seconds() / 86400
    ).round(2)

    # --- история отправителя ------------------------------------------------
    by_sender = df.groupby("sender_id")
    df["sender_tx_before"] = by_sender.cumcount()

    # cumsum включает текущую строку, поэтому вычитаем её сумму
    past_sum = by_sender["amount"].cumsum() - df["amount"]
    past_count = df["sender_tx_before"].replace(0, np.nan)  # NaN = истории нет
    # Для первой операции истории нет -> ratio 1.0 («типичная сумма»)
    df["amount_to_avg"] = (df["amount"] / (past_sum / past_count)).fillna(1.0)

    # --- история получателя -------------------------------------------------
    # 0 означает «счёт только что появился» — типичный признак дропа
    df["receiver_tx_before"] = df.groupby("receiver_id").cumcount()

    return df


def feature_matrix(df: pd.DataFrame) -> pd.DataFrame:
    """Возвращает ровно те колонки и в том порядке, в котором ждёт модель.

    Отдельная функция, чтобы порядок не собирали вручную в двух местах:
    `model.predict_proba(df[FEATURES])` в обучении и в проде должен
    получать одинаковый набор.
    """
    missing = [f for f in FEATURES if f not in df.columns]
    if missing:
        raise ValueError(
            f"Нет признаков: {', '.join(missing)}. "
            "Сначала вызовите add_features(df)."
        )
    return df[FEATURES]
