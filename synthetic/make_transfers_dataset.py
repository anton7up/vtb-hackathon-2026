#!/usr/bin/env python
"""Синтетический датасет переводов между клиентами банка.

Колонки результата:
    timestamp       — дата и время операции
    sender_id       — отправитель
    sender_balance  — баланс отправителя ДО операции
    amount          — сумма перевода
    receiver_id     — получатель
    label           — 0 пропустили / 1 на проверку / 2 заблокировали
    is_fraud        — истинная разметка (для оценки качества, не для обучения политики)

Логика данных:
  * клиенты переводят в основном «своим» — повторяющимся получателям;
  * новый получатель + большая доля баланса + ночь повышают риск, но не гарантируют фрод;
  * фрод — 4 типологии: вывод на дропа, дробление, фишинг/захват счёта, сговор;
  * метка 0/1/2 — это ПРИМЕНЁННАЯ ПОЛИТИКА с шумом: часть фрода пропущена,
    часть легальных операций ушла на проверку или была ошибочно заблокирована.

Запуск: py synthetic/make_transfers_dataset.py
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

START = pd.Timestamp("2025-01-01 00:00:00")
DAYS = 90
HOUR_P = np.array([0.5, 0.3, 0.2, 0.15, 0.15, 0.25, 0.7, 1.3, 2.1, 3.0, 3.2,
                   3.0, 2.8, 2.6, 2.5, 2.4, 2.3, 2.3, 2.9, 3.1, 2.6, 1.8,
                   1.2, 0.8])
HOUR_P = HOUR_P / HOUR_P.sum()


def build(rows: int, fraud_share: float, seed: int) -> tuple[pd.DataFrame, dict]:
    rng = np.random.default_rng(seed)
    rows = int(rows)
    n_fraud = max(10, int(rows * fraud_share))
    n_normal = rows - n_fraud
    days = DAYS
    per_day = n_normal / days

    n_customers = 600
    cust_ids = np.array([f"C{i:05d}" for i in range(1, n_customers + 1)])
    mule_ids = [f"C{int(v):06d}" for v in
                rng.choice(np.arange(100_000, 1_000_000), size=40, replace=False)]

    # профиль клиента: типичная сумма перевода и баланс
    typical = rng.lognormal(np.log(90), 0.7, n_customers)
    balance = rng.lognormal(np.log(9000), 0.9, n_customers).round(2)
    bal = dict(zip(cust_ids, balance, strict=True))
    bal.update({m: 0.0 for m in mule_ids})   # дропы стартуют с нуля

    activity = rng.lognormal(0, 0.7, n_customers)
    activity /= activity.sum()
    cdf = np.cumsum(activity)

    # «круг общения»: у каждого 2–9 постоянных получателей
    contacts: dict[str, np.ndarray] = {}
    for cid in cust_ids:
        k = int(rng.integers(2, 10))
        contacts[cid] = rng.choice(cust_ids, size=k, replace=False)

    pair_count: dict[tuple[str, str], int] = {}

    fmt = "%Y-%m-%d %H:%M:%S"
    recs: list[dict] = []

    def pick_sender() -> str:
        return str(cust_ids[np.searchsorted(cdf, rng.random())])

    def pick_receiver(sender: str) -> tuple[str, bool]:
        if rng.random() < 0.85:
            return str(rng.choice(contacts[sender])), False
        other = str(rng.choice(cust_ids))
        while other == sender:
            other = str(rng.choice(cust_ids))
        return other, True

    def emit(ts, sender, receiver, amount, fraud, label=None, kind="-"):
        old = bal[sender]
        amount = round(min(amount, old), 2)
        if amount <= 0.01:
            return None
        bal[sender] = round(old - amount, 2)
        bal[receiver] = round(bal.get(receiver, 0.0) + amount, 2)
        key = (sender, receiver)
        novel = pair_count.get(key, 0) == 0
        pair_count[key] = pair_count.get(key, 0) + 1
        return {
            "timestamp": ts, "sender_id": sender,
            "sender_balance": old, "amount": amount,
            "receiver_id": receiver, "is_fraud": fraud,
            "novel": novel, "kind": kind, "label_raw": label,
        }

    # ---------------------------------------------------------------- легальные
    for day in range(days):
        n = int(rng.poisson(per_day))
        for _ in range(n):
            hour = int(rng.choice(24, p=HOUR_P))
            ts = (START + pd.Timedelta(days=day, hours=hour,
                                       minutes=int(rng.integers(0, 60)),
                                       seconds=int(rng.integers(0, 60))))
            sender = pick_sender()
            if bal[sender] < 100:                 # зарплата/пополнение вне выгрузки
                bal[sender] = round(float(rng.lognormal(np.log(9000), 0.5)), 2)
            receiver, is_stranger = pick_receiver(sender)
            key = (sender, receiver)
            novel = pair_count.get(key, 0) == 0

            base = typical[int(np.where(cust_ids == sender)[0][0])]
            if novel:
                amount = base * float(rng.lognormal(0.9, 0.55))   # новому — крупнее
            else:
                amount = base * float(rng.lognormal(-0.15, 0.45))

            # легальный вывод почти всего баланса знакомому (перевод на накопления)
            if not novel and rng.random() < 0.02:
                amount = bal[sender] * float(rng.uniform(0.90, 1.0))
            elif amount > 0.85 * bal[sender]:
                amount = bal[sender] * float(rng.uniform(0.15, 0.85))

            r = emit(ts, sender, receiver, amount, 0)
            if r:
                recs.append(r)

    # ---------------------------------------------------------------- фрод
    fraud_kinds = {"takeover": 0.40, "mule": 0.18, "structuring": 0.18,
                   "collusion": 0.14, "probe": 0.10}
    kinds = list(fraud_kinds)
    probs = np.array(list(fraud_kinds.values()))
    made = 0
    attempts = 0
    while made < n_fraud and attempts < n_fraud * 50:
        attempts += 1
        day = int(rng.integers(0, days))
        hour = int(rng.integers(0, 6)) if rng.random() < 0.6 else int(rng.integers(8, 22))
        sender = pick_sender()
        if bal[sender] < 1500:
            continue
        kind = str(rng.choice(kinds, p=probs))
        mule = str(rng.choice(mule_ids))
        ts = (START + pd.Timedelta(days=day, hours=hour,
                                   minutes=int(rng.integers(0, 60))))

        if kind == "takeover":
            # иногда выводят всё сразу ночью, иногда — частично и днём
            frac = (float(rng.uniform(0.85, 1.0)) if rng.random() < 0.6
                    else float(rng.uniform(0.30, 0.60)))
            r = emit(ts, sender, mule, bal[sender] * frac, 1, kind=kind)
        elif kind == "mule":
            # дроп обналичивает поступившие деньги дальше по цепочке
            r = emit(ts, mule, str(rng.choice(mule_ids)),
                     bal.get(mule, 0) * 0.8 or rng.uniform(2000, 8000), 1, kind=kind)
        elif kind == "structuring":
            pool = [m for m in mule_ids if bal.get(m, 0) == 0] or mule_ids
            dst = str(rng.choice(pool))
            r = emit(ts, sender, dst, rng.uniform(8500, 9900), 1, kind=kind)
        elif kind == "collusion":
            r = emit(ts, sender, mule, rng.uniform(1000, 5000) // 100 * 100, 1,
                     kind="collusion")
        else:  # probe — мелкий «тестовый» перевод новому лицу
            r = emit(ts, sender, str(rng.choice(mule_ids)),
                     rng.uniform(150, 600), 1, kind="probe")

        if r:
            recs.append(r)
            made += 1

    df = pd.DataFrame(recs).sort_values("timestamp").reset_index(drop=True)

    # ------------------------------------------------- метки = политика с шумом
    ratio = (df["amount"] / df["sender_balance"].clip(lower=1)).clip(0, 1)
    night = ((df["timestamp"].dt.hour < 6) | (df["timestamp"].dt.hour >= 23)).astype(int)
    is_new_payee = df["novel"].astype(int)
    z = (-4.2
         + 1.6 * is_new_payee
         + 3.0 * ratio
         + 0.8 * night
         + 0.20 * (np.log1p(df["amount"]) - 4)
         + 1.5 * df["is_fraud"]
         + rng.normal(0, 1.05, len(df)))
    risk = 1 / (1 + np.exp(-z))
    df["label"] = np.where(risk >= 0.70, 2, np.where(risk >= 0.36, 1, 0)).astype(int)
    # микроплатежи не блокируют и не отправляют на проверку — нет смысла
    df.loc[df["amount"] < 100, "label"] = 0

    df["is_new_payee"] = is_new_payee   # справочная колонка для сверки
    out = df[["timestamp", "sender_id", "sender_balance", "amount",
              "receiver_id", "label", "is_fraud"]].copy()
    out["timestamp"] = out["timestamp"].dt.strftime(fmt)

    stats = {
        "rows": int(len(out)),
        "period": f"{out['timestamp'].min()} — {out['timestamp'].max()}",
        "fraud_rows": int(out["is_fraud"].sum()),
        "fraud_rate": round(float(out["is_fraud"].mean()), 4),
        "label_share": {int(k): round(float(v), 4) for k, v in
                        out["label"].value_counts(normalize=True).sort_index().items()},
        "customers": int(out["sender_id"].nunique()),
        "recipients": int(out["receiver_id"].nunique()),
        "fraud_kinds": df.loc[df.is_fraud == 1, "kind"].value_counts().to_dict(),
        "fraud_in_label0": int(((out["is_fraud"] == 1) & (out["label"] == 0)).sum()),
        "fraud_in_label1": int(((out["is_fraud"] == 1) & (out["label"] == 1)).sum()),
        "fraud_in_label2": int(((out["is_fraud"] == 1) & (out["label"] == 2)).sum()),
        "legit_in_label2": int(((out["is_fraud"] == 0) & (out["label"] == 2)).sum()),
        "legit_in_label1": int(((out["is_fraud"] == 0) & (out["label"] == 1)).sum()),
        "note": "Синтетика. Пороги продакшна на ней не настраивать.",
    }
    return out, stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=9000)
    ap.add_argument("--fraud-share", type=float, default=0.01)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default="synthetic/bank_transfers.csv")
    args = ap.parse_args()

    df, stats = build(args.rows, args.fraud_share, args.seed)

    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False, encoding="utf-8")
    (path.parent / "metadata.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Файл: {path.resolve()}")
    print(f"Строк: {len(df):,} | период: {df.timestamp.min()} — {df.timestamp.max()}")
    print(f"Фрод: {df.is_fraud.sum():,} ({df.is_fraud.mean():.2%})")
    print("\nРаспределение целевой переменной:")
    print((df.label.value_counts(normalize=True).sort_index() * 100)
          .round(2).to_string() + "  %")
    print("\nПересечение метки и истины (строки):")
    print(pd.crosstab(df.label, df.is_fraud,
                      rownames=["label"], colnames=["is_fraud"]).to_string())
    print("\nТипологии фрода:")
    for k, v in stats["fraud_kinds"].items():
        print(f"  {k:<12} {v}")
    print("\nПервые строки:")
    print(df.head(6).to_string(index=False))


if __name__ == "__main__":
    main()
