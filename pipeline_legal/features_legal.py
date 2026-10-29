#!/usr/bin/env python
"""
Признаки модели фрода для юрлиц и ИП: единственный источник правды.

Устроен так же, как `pipeline/features.py` (физлица): признаки считаются
при обучении и при каждом предсказании, поэтому код один и живёт здесь.

Контракт
--------
Вход — DataFrame с колонками из INPUT_COLUMNS (13 «сырых» колонок, которые
банк знает в момент платежа, см. synthetic_legal/README.md).
Для обучения дополнительно нужен `is_fraud`.

Выход — те же строки плюс колонки из FEATURES.

Три правила
-----------
1. Порядок FEATURES фиксирован: модель обучена именно на нём.
2. Строки должны идти по возрастанию времени. Признаки истории смотрят
   только на предыдущие строки — при перемешанном порядке в модель
   попадёт будущее.
3. ИНН, счета и устройства — СТРОКИ. Если прочитать их как числа,
   счёт казначейства `03100643…` потеряет ведущий ноль и станет другим счётом.
   `load_operations` читает их правильно.

Идентификаторы (client_id, ИНН, счёт, устройство) в модель не идут:
сам номер ничего не значит. Из них по истории считается, что про них известно —
«видели раньше?», «сколько раз?», «сколько разных клиентов платили этому счёту?».
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

# ────────────────────────────────────────────────────────────────────────────
# КОНТРАКТ
# ────────────────────────────────────────────────────────────────────────────

INPUT_COLUMNS = [
    "timestamp", "client_id", "client_type", "client_balance", "amount",
    "receiver_inn", "receiver_account", "receiver_type", "purpose", "channel",
    "device_id", "hours_since_access_change", "receiver_blacklisted",
]
ID_COLUMNS = ["client_id", "receiver_inn", "receiver_account", "device_id"]
LABEL_COLUMNS = ["is_fraud"]

# Категории → числа. Словари фиксированы, а не `cat.codes`: коды по алфавиту
# зависели бы от того, какие значения есть в данных, и в проде могли бы сдвинуться.
# Неизвестное значение → -1.
CLIENT_TYPE = {"OOO": 0, "IP": 1}
RECEIVER_TYPE = {"UL": 0, "IP": 1, "FL": 2}
CHANNEL = {"1c": 0, "web": 1, "mobile": 2}
PURPOSE = {"goods": 0, "services": 1, "rent": 2, "tax": 3, "salary": 4,
           "loan": 5, "refund": 6, "other": 7}

ACCESS_CAP = 720          # часов; всё, что дальше месяца, — «давно»

FEATURES = [
    # --- время
    "hour",                          # час суток
    "is_weekend",                    # суббота/воскресенье
    "night",                         # 23:00–05:59
    # --- сумма
    "amount",                        # сумма платежа
    "client_balance",                # остаток до платежа
    "amount_ratio",                  # какая доля остатка уходит
    "amount_to_avg",                 # сумма / средний прошлый платёж клиента
    "is_round",                      # кратна 1000
    # --- получатель
    "is_new_receiver",               # клиент этому счёту ещё не платил
    "payee_tx_before",               # сколько раз уже платил этому счёту
    "days_since_first_payee",        # дней с первого платежа этому счёту
    "known_inn_new_account",         # ИНН знакомый, а счёт новый — подмена реквизитов
    "first_payment_to_individual",   # клиент впервые платит физлицу (кроме зарплаты)
    "receiver_senders_before",       # сколько разных клиентов уже платили этому счёту
    "receiver_age_days",             # дней с первого появления счёта в банке
    "receiver_blacklisted",          # счёт в базе ЦБ / стоп-листе
    # --- скорость
    "client_tx_last_1h",             # платежей клиента за прошлый час
    "new_receivers_last_24h",        # новых получателей за сутки (с этим платежом)
    "outflow_share_24h",             # доля остатка, ушедшая за сутки (с этим платежом)
    # --- сессия
    "is_new_device",                 # устройство у клиента впервые
    "device_age_days",               # дней с первого платежа с этого устройства
    "access_changed_48h",            # доступ меняли за последние 48 часов
    "hours_since_access_change",     # часов со смены доступа (до 720)
    # --- категории
    "client_type_code",              # 0 ООО / 1 ИП
    "receiver_type_code",            # 0 юрлицо / 1 ИП / 2 физлицо
    "purpose_code",                  # назначение платежа
    "channel_code",                  # 0 1С / 1 веб / 2 мобильный
]

FEATURE_DESCRIPTIONS = {
    "hour": "час суток от 0 до 23",
    "is_weekend": "1, если суббота или воскресенье",
    "night": "1, если платёж между 23:00 и 06:00",
    "amount": "сумма платежа",
    "client_balance": "остаток клиента до платежа",
    "amount_ratio": "amount / client_balance, доля остатка",
    "amount_to_avg": "сумма / средняя прошлая сумма клиента (1, если истории нет)",
    "is_round": "1, если сумма кратна 1000",
    "is_new_receiver": "1, если клиент раньше не платил на этот счёт",
    "payee_tx_before": "число прошлых платежей клиента на этот счёт",
    "days_since_first_payee": "дней с первого платежа клиента на этот счёт",
    "known_inn_new_account": "1, если клиент раньше платил этому ИНН, но на другой счёт",
    "first_payment_to_individual": "1, если это первый платёж клиента физлицу не по зарплате",
    "receiver_senders_before": "число разных клиентов, которые раньше платили на этот счёт",
    "receiver_age_days": "дней с первого появления счёта получателя в данных банка",
    "receiver_blacklisted": "1, если счёт получателя в базе ЦБ или стоп-листе",
    "client_tx_last_1h": "число платежей клиента за предыдущий час",
    "new_receivers_last_24h": "число новых получателей клиента за сутки, включая этот платёж",
    "outflow_share_24h": "сколько остатка ушло за сутки, включая этот платёж",
    "is_new_device": "1, если клиент впервые платит с этого устройства",
    "device_age_days": "дней с первого платежа клиента с этого устройства",
    "access_changed_48h": "1, если данные доступа меняли за последние 48 часов",
    "hours_since_access_change": "часов со смены доступа, не больше 720",
    "client_type_code": "0 — ООО, 1 — ИП",
    "receiver_type_code": "0 — юрлицо, 1 — ИП, 2 — физлицо",
    "purpose_code": "goods 0, services 1, rent 2, tax 3, salary 4, loan 5, refund 6, other 7",
    "channel_code": "0 — 1С, 1 — веб, 2 — мобильный",
}

# ────────────────────────────────────────────────────────────────────────────
# ЗАГРУЗКА
# ────────────────────────────────────────────────────────────────────────────


def load_operations(path: str | Path, require_labels: bool = False) -> pd.DataFrame:
    """Читает CSV, парсит время, ID — строками, сортирует по времени."""
    df = pd.read_csv(path, parse_dates=["timestamp"],
                     dtype={c: str for c in ID_COLUMNS})
    df = df.sort_values("timestamp", kind="stable").reset_index(drop=True)
    required = INPUT_COLUMNS + (LABEL_COLUMNS if require_labels else [])
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"В {Path(path).name} нет колонок: {', '.join(missing)}")
    return df


# ────────────────────────────────────────────────────────────────────────────
# ВСПОМОГАТЕЛЬНОЕ: окна «за последний час / сутки»
# ────────────────────────────────────────────────────────────────────────────


def _window_sum_before(times: np.ndarray, values: np.ndarray, window: np.timedelta64) -> np.ndarray:
    """Для каждой строки — сумма `values` по ПРЕДЫДУЩИМ строкам за окно `window`.

    Строки одного клиента, отсортированы по времени. Текущая строка не входит.
    Через накопленную сумму: сумма на отрезке [left, i) = cs[i] - cs[left],
    где left — первая строка не раньше `t - window` (ищем двоичным поиском).
    """
    cs = np.concatenate([[0.0], np.cumsum(values, dtype=float)])
    left = np.searchsorted(times, times - window, side="left")
    idx = np.arange(len(times))
    return cs[idx] - cs[left]


def _per_client_window(df: pd.DataFrame, column: str, window: str) -> pd.Series:
    out = pd.Series(0.0, index=df.index)
    w = np.timedelta64(pd.Timedelta(window))
    for _, g in df.groupby("client_id", sort=False):
        out.loc[g.index] = _window_sum_before(
            g["timestamp"].to_numpy(), g[column].to_numpy(dtype=float), w)
    return out


# ────────────────────────────────────────────────────────────────────────────
# ПРИЗНАКИ
# ────────────────────────────────────────────────────────────────────────────


def add_features(df: pd.DataFrame) -> pd.DataFrame:
    """Добавляет колонки FEATURES. Строки — по возрастанию времени."""
    missing = [c for c in INPUT_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"Нет колонок: {', '.join(missing)}")
    if not pd.api.types.is_datetime64_any_dtype(df["timestamp"]):
        raise TypeError(
            "timestamp должен быть datetime, а не строкой. "
            "Исправляется так: df['timestamp'] = pd.to_datetime(df['timestamp'])")
    if not df["timestamp"].is_monotonic_increasing:
        raise ValueError("Строки не отсортированы по времени — признаки истории заглянут в будущее")

    df = df.copy().reset_index(drop=True)
    for c in ID_COLUMNS:
        df[c] = df[c].astype(str)
    ts = df["timestamp"]
    days = lambda delta: delta.dt.total_seconds() / 86400  # noqa: E731

    # --- время -----------------------------------------------------------------
    df["hour"] = ts.dt.hour
    df["is_weekend"] = (ts.dt.dayofweek >= 5).astype(int)
    df["night"] = ((df["hour"] < 6) | (df["hour"] >= 23)).astype(int)

    # --- сумма -----------------------------------------------------------------
    df["amount_ratio"] = df["amount"] / df["client_balance"].clip(lower=1)
    df["is_round"] = (df["amount"] % 1000 == 0).astype(int)
    by_client = df.groupby("client_id")
    tx_before = by_client.cumcount()
    past_sum = by_client["amount"].cumsum() - df["amount"]
    df["amount_to_avg"] = (df["amount"] / (past_sum / tx_before.replace(0, np.nan))).fillna(1.0)

    # --- получатель: пара «клиент — счёт» ------------------------------------
    pair = df.groupby(["client_id", "receiver_account"])
    df["payee_tx_before"] = pair.cumcount()
    df["is_new_receiver"] = (df["payee_tx_before"] == 0).astype(int)
    df["days_since_first_payee"] = days(ts - pair["timestamp"].transform("first"))

    # Подмена реквизитов: этому ИНН клиент уже платил, а на этот счёт — нет.
    # cumcount по паре «клиент — ИНН» > 0 → ИНН знакомый.
    inn_seen = df.groupby(["client_id", "receiver_inn"]).cumcount() > 0
    df["known_inn_new_account"] = (inn_seen & (df["is_new_receiver"] == 1)).astype(int)

    # Первый платёж физлицу не по зарплате (для ООО — сильный сигнал, для ИП — слабый)
    to_fl = ((df["receiver_type"] == "FL") & (df["purpose"] != "salary")).astype(int)
    fl_before = to_fl.groupby(df["client_id"]).cumsum() - to_fl
    df["first_payment_to_individual"] = ((to_fl == 1) & (fl_before == 0)).astype(int)

    # --- получатель: сам счёт, по всем клиентам банка -------------------------
    by_account = df.groupby("receiver_account")
    # сколько РАЗНЫХ клиентов платили раньше: считаем первые платежи каждой пары
    df["receiver_senders_before"] = (
        by_account["is_new_receiver"].cumsum() - df["is_new_receiver"])
    df["receiver_age_days"] = days(ts - by_account["timestamp"].transform("first"))

    # --- скорость --------------------------------------------------------------
    df["_one"] = 1.0
    df["client_tx_last_1h"] = _per_client_window(df, "_one", "1h").astype(int)
    df["new_receivers_last_24h"] = (
        _per_client_window(df, "is_new_receiver", "24h") + df["is_new_receiver"]).astype(int)
    out_24h = _per_client_window(df, "amount", "24h")
    # остаток сутки назад ≈ текущий остаток + всё, что ушло за сутки до этого платежа
    df["outflow_share_24h"] = ((out_24h + df["amount"])
                               / (df["client_balance"] + out_24h).clip(lower=1)).clip(0, 1)

    # --- сессия ----------------------------------------------------------------
    dev = df.groupby(["client_id", "device_id"])
    df["is_new_device"] = (dev.cumcount() == 0).astype(int)
    df["device_age_days"] = days(ts - dev["timestamp"].transform("first"))
    hsac = df["hours_since_access_change"].astype(float)
    df["access_changed_48h"] = (hsac <= 48).astype(int)
    df["hours_since_access_change"] = hsac.clip(upper=ACCESS_CAP)

    # --- категории -------------------------------------------------------------
    df["client_type_code"] = df["client_type"].map(CLIENT_TYPE).fillna(-1).astype(int)
    df["receiver_type_code"] = df["receiver_type"].map(RECEIVER_TYPE).fillna(-1).astype(int)
    df["purpose_code"] = df["purpose"].map(PURPOSE).fillna(-1).astype(int)
    df["channel_code"] = df["channel"].map(CHANNEL).fillna(-1).astype(int)

    return df.drop(columns="_one")


def feature_matrix(df: pd.DataFrame) -> pd.DataFrame:
    """Ровно те колонки и в том порядке, в котором ждёт модель."""
    missing = [f for f in FEATURES if f not in df.columns]
    if missing:
        raise ValueError(f"Нет признаков: {', '.join(missing)}. Сначала вызовите add_features(df).")
    return df[FEATURES]


if __name__ == "__main__":
    # Быстрая проверка: посчитать признаки и показать, чем фрод отличается от нормы
    here = Path(__file__).resolve().parent
    data = load_operations(here.parent / "synthetic_legal" / "legal_transfers.csv",
                           require_labels=True)
    scored = add_features(data)
    print(f"Операций: {len(scored):,}, признаков: {len(FEATURES)}")
    print("\nСреднее значение признака: норма vs фрод")
    table = scored.groupby("is_fraud")[FEATURES].mean().T
    table.columns = ["норма", "фрод"]
    print(table.round(3).to_string())
    if "fraud_kind" in scored:
        print("\nКлючевые признаки по типам фрода (доля / среднее):")
        key = ["is_new_receiver", "known_inn_new_account", "is_new_device",
               "access_changed_48h", "new_receivers_last_24h", "outflow_share_24h"]
        print(scored.groupby("fraud_kind")[key].mean().round(2).to_string())
