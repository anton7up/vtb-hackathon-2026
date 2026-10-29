#!/usr/bin/env python
"""Синтетический датасет платежей юрлиц (ООО) и ИП.

Одна строка = один исходящий платёж клиента-бизнеса. Колонки — «сырые» данные,
которые банк знает в момент платежа (платёжка + сессия + профиль клиента):

    timestamp                  — дата и время платежа
    client_id                  — клиент-плательщик (L00001…)
    client_type                — OOO / IP
    client_balance             — остаток на счёте ДО платежа
    amount                     — сумма платежа
    receiver_inn               — ИНН получателя из платёжки
    receiver_account           — счёт получателя (20 цифр)
    receiver_type              — UL / IP / FL (юрлицо / ИП / физлицо)
    purpose                    — категория назначения: goods, services, rent, tax,
                                 salary, loan, refund, other
    channel                    — web / mobile / 1c
    device_id                  — устройство, с которого подписан платёж
    hours_since_access_change  — часов с последней смены данных доступа
                                 (телефон, пароль, новый пользователь); 9999 = не менялись
    receiver_blacklisted       — счёт получателя есть в базе ЦБ / стоп-листе банка
    is_fraud                   — ОТВЕТ: 1 — мошенничество (на нём обучаем модель)
    fraud_kind                 — тип мошенничества, только для анализа (в модель НЕ подавать)

Порядок работы (функции идут в этом же порядке):
    make_clients        — клиенты: ООО и ИП, балансы, устройства, каналы
    make_counterparties — постоянные контрагенты: поставщики, аренда, налоги, сотрудники
    plan_life_events    — «трудные» легальные события: смена устройства, смены доступа,
                          поставщик сменил банк
    gen_legit           — обычные платежи
    gen_fraud           — 5 типов мошенничества
    finalize            — сортировка по времени, балансы, итоговые колонки

Запуск: py synthetic_legal/make_legal_dataset.py
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

# ============================================================ настройки
START = pd.Timestamp("2025-01-01")
END = pd.Timestamp("2025-05-01")          # не включительно: январь–апрель
N_OOO = 180
N_IP = 120
NO_CHANGE = 9999                           # «доступ не менялся»

DAYS = pd.date_range(START, END - pd.Timedelta(days=1), freq="D")
# новогодние каникулы 1–8 января банк-клиенты почти не платят
HOLIDAY = {d for d in DAYS if d.month == 1 and d.day <= 8}
WORKDAYS = [d for d in DAYS if d.dayofweek < 5 and d not in HOLIDAY]
OFFDAYS = [d for d in DAYS if d not in set(WORKDAYS)]

# Распределение часов: у ООО рабочий день, у ИП шире и с вечером.
HOUR_OOO = np.array([0.02, 0.01, 0.01, 0.01, 0.01, 0.02, 0.05, 0.2, 1.2, 3.0, 3.6, 3.6,
                     3.0, 3.2, 3.5, 3.4, 3.0, 2.2, 1.0, 0.4, 0.2, 0.1, 0.05, 0.03])
HOUR_IP = np.array([0.05, 0.03, 0.02, 0.02, 0.02, 0.05, 0.2, 0.6, 1.4, 2.4, 2.8, 2.8,
                    2.5, 2.6, 2.7, 2.6, 2.4, 2.0, 1.6, 1.4, 1.2, 0.8, 0.4, 0.15])
HOUR_OOO /= HOUR_OOO.sum()
HOUR_IP /= HOUR_IP.sum()

# Доли типов фрода — по СТРОКАМ. Инцидент drain даёт 3–8 платежей, bec — 1–2,
# поэтому выбираем тип с учётом того, сколько строк ему ещё не хватает.
FRAUD_KINDS = {"bec": 0.25, "dbo_takeover": 0.22, "drain": 0.25,
               "ceo_fraud": 0.13, "ip_social": 0.15}


# ============================================================ вспомогательное
class Ids:
    """Уникальные ИНН, счета и устройства. Всё синтетическое."""

    def __init__(self, rng: np.random.Generator):
        self.rng = rng
        self.used: set[str] = set()
        self.n_dev = 0

    def _unique(self, make) -> str:
        while True:
            v = make()
            if v not in self.used:
                self.used.add(v)
                return v

    def inn(self, kind: str) -> str:
        # у юрлица 10 цифр, у ИП и физлица 12
        n = 10 if kind == "UL" else 12
        return self._unique(lambda: str(self.rng.integers(10 ** (n - 1), 10 ** n)))

    def account(self, kind: str) -> str:
        # первые цифры счёта показывают тип владельца: 40702 юрлицо, 40802 ИП, 40817 физлицо
        prefix = {"UL": "40702810", "IP": "40802810", "FL": "40817810",
                  "TAX": "03100643"}[kind]
        return self._unique(lambda: prefix + f"{self.rng.integers(0, 10 ** 12):012d}")

    def device(self, attacker: bool = False) -> str:
        self.n_dev += 1
        return f"{'X' if attacker else 'D'}{self.n_dev:05d}"


def at(day: pd.Timestamp, rng, hours_p=None, hour: int | None = None) -> pd.Timestamp:
    """Случайное время внутри дня."""
    if hour is None:
        hour = int(rng.choice(24, p=hours_p))
    return day + pd.Timedelta(hours=hour, minutes=int(rng.integers(0, 60)),
                              seconds=int(rng.integers(0, 60)))


def workday_near(year: int, month: int, day: int) -> pd.Timestamp:
    """Рабочий день на дату или ближайший перед ней (зарплату переносят раньше)."""
    d = pd.Timestamp(year=year, month=month, day=day)
    while d not in set(WORKDAYS):
        d -= pd.Timedelta(days=1)
        if d < START:
            return WORKDAYS[0]
    return d


def maybe_round(amount: float, rng, p: float) -> float:
    """Часть платежей — круглыми суммами (счёт на 50 000, аренда и т.п.)."""
    if rng.random() < p:
        step = 1000 if amount >= 10_000 else 100
        return max(step, round(amount / step) * step)
    return amount


# ============================================================ 1. клиенты
def make_clients(rng, ids: Ids) -> list[dict]:
    clients = []
    for i in range(1, N_OOO + N_IP + 1):
        is_ooo = i <= N_OOO
        ctype = "OOO" if is_ooo else "IP"
        if is_ooo:
            balance = rng.lognormal(np.log(1_200_000), 0.7)
            per_month = int(rng.integers(12, 46))
            n_emp = int(rng.integers(2, 26))
            salary_project = rng.random() < 0.6     # зарплата одним реестром через банк
            n_dev = int(rng.integers(1, 4))          # бухгалтер, директор, ещё кто-то
            channel = str(rng.choice(["1c", "web", "mobile"], p=[0.5, 0.45, 0.05]))
        else:
            balance = rng.lognormal(np.log(150_000), 0.7)
            per_month = int(rng.integers(3, 16))
            n_emp = int(rng.choice([0, 0, 0, 1, 2, 3]))
            salary_project = False
            n_dev = int(rng.integers(1, 3))
            channel = str(rng.choice(["mobile", "web"], p=[0.55, 0.45]))
        clients.append({
            "client_id": f"L{i:05d}",
            "client_type": ctype,
            "inn": ids.inn("UL" if is_ooo else "IP"),
            "balance0": round(float(balance), 2),
            # «масштаб» клиента: во сколько раз он крупнее медианного своего типа
            "scale": float(balance) / (1_200_000 if is_ooo else 150_000),
            "per_month": per_month,
            "n_employees": n_emp,
            "salary_project": bool(salary_project),
            "channel": channel,
            # история устройств: список (с какого момента, набор устройств)
            "devices": [(START, [ids.device() for _ in range(n_dev)])],
            "access_changes": [],
        })
    return clients


# ============================================================ 2. контрагенты
def make_counterparties(rng, ids: Ids, clients: list[dict]) -> dict:
    # общий пул компаний: одни и те же поставщики обслуживают многих клиентов
    pool = []
    for _ in range(1400):
        kind = "UL" if rng.random() < 0.7 else "IP"
        pool.append({
            "inn": ids.inn(kind), "type": kind,
            "accounts": [(START, ids.account(kind))],   # счёт может смениться — см. план событий
            "purpose": "goods" if rng.random() < 0.65 else "services",
            "typical": float(rng.lognormal(np.log(60_000 if kind == "UL" else 25_000), 0.8)),
        })
    tax = {"inn": ids.inn("UL"), "type": "UL", "accounts": [(START, ids.account("TAX"))]}
    bank = {"inn": ids.inn("UL"), "type": "UL", "accounts": [(START, ids.account("UL"))]}

    for c in clients:
        ooo = c["client_type"] == "OOO"
        k = int(rng.integers(3, 11) if ooo else rng.integers(2, 7))
        idx = rng.choice(len(pool), size=k, replace=False)
        # Ципф: одному-двум поставщикам платят чаще всего
        w = 1 / np.arange(1, k + 1)
        c["suppliers"] = [{"cp": pool[j], "w": float(wj),
                           "amount": pool[j]["typical"] * c["scale"] ** 0.6
                           * (1 if ooo else 0.35)}
                          for j, wj in zip(idx, w)]
        c["rent"] = None
        if rng.random() < (0.85 if ooo else 0.5):
            cp = pool[int(rng.integers(len(pool)))]
            c["rent"] = {"cp": cp, "amount": round(float(
                rng.lognormal(np.log(120_000 if ooo else 35_000), 0.5) * c["scale"] ** 0.4), -2)}
        c["employees"] = [{"inn": ids.inn("FL"), "account": ids.account("FL"),
                           "salary": float(rng.lognormal(np.log(60_000), 0.35))}
                          for _ in range(c["n_employees"])]
        c["loan"] = round(float(rng.lognormal(np.log(80_000), 0.6) * c["scale"] ** 0.5), 2) \
            if ooo and rng.random() < 0.3 else None
        c["refunds"] = ooo and rng.random() < 0.15        # розница: возвраты покупателям
        # самозанятые (физлица): дизайнер, курьер, репетитор — у 35% клиентов
        c["freelancers"] = [{"inn": ids.inn("FL"), "account": ids.account("FL")}
                            for _ in range(int(rng.integers(1, 4)))] \
            if rng.random() < 0.35 else []
        if not ooo:
            c["own_card"] = ids.account("FL")            # личная карта владельца ИП
    return {"pool": pool, "tax": tax, "bank": bank}


def account_at(cp: dict, ts: pd.Timestamp) -> str:
    acc = cp["accounts"][0][1]
    for since, a in cp["accounts"]:
        if since <= ts:
            acc = a
    return acc


def devices_at(c: dict, ts: pd.Timestamp) -> list[str]:
    devs = c["devices"][0][1]
    for since, d in c["devices"]:
        if since <= ts:
            devs = d
    return devs


# ============================================================ 3. трудные легальные события
def plan_life_events(rng, ids: Ids, clients: list[dict], world: dict) -> None:
    """Легальные события, которые внешне похожи на признаки фрода."""
    for c in clients:
        # новый компьютер / новый бухгалтер: 12% клиентов
        if rng.random() < 0.12:
            t = at(WORKDAYS[int(rng.integers(5, len(WORKDAYS) - 5))], rng, HOUR_OOO)
            old = devices_at(c, t)
            new = old[1:] + [ids.device()] if len(old) > 1 else [ids.device()]
            c["devices"].append((t, new))
            # чаще всего вместе с этим меняют и доступ
            if rng.random() < 0.6:
                c["access_changes"].append(t - pd.Timedelta(hours=float(rng.uniform(0.2, 30))))
        # отдельно — смена телефона или пароля: ещё ~12%
        if rng.random() < 0.12:
            c["access_changes"].append(at(DAYS[int(rng.integers(len(DAYS)))], rng, HOUR_IP))

    # 4% поставщиков легально сменили банк: тот же ИНН, новый счёт
    for cp in world["pool"]:
        if rng.random() < 0.04:
            t = at(WORKDAYS[int(rng.integers(10, len(WORKDAYS) - 10))], rng, HOUR_OOO)
            cp["accounts"].append((t, ids.account(cp["type"])))


# ============================================================ 4. обычные платежи
def gen_legit(rng, clients: list[dict], world: dict) -> list[dict]:
    events: list[dict] = []
    months = [(d.year, d.month) for d in pd.date_range(START, END, freq="MS")][:-1]

    def emit(c, ts, receiver_inn, account, rtype, purpose, amount=None, frac=None,
             round_p=0.25):
        if amount is not None:
            amount = maybe_round(float(amount), rng, round_p)
        devs = devices_at(c, ts)
        channel = c["channel"] if rng.random() < 0.88 else \
            str(rng.choice(["web", "mobile", "1c"] if c["client_type"] == "OOO" else ["web", "mobile"]))
        events.append({
            "timestamp": ts, "client_id": c["client_id"], "amount": amount, "frac": frac,
            "receiver_inn": receiver_inn, "receiver_account": account, "receiver_type": rtype,
            "purpose": purpose, "channel": channel, "device_id": str(rng.choice(devs)),
            "is_fraud": 0, "fraud_kind": "none",
        })

    for c in clients:
        ooo = c["client_type"] == "OOO"
        hours = HOUR_OOO if ooo else HOUR_IP
        for (y, m) in months:
            month_work = [d for d in WORKDAYS if d.year == y and d.month == m]
            month_off = [d for d in OFFDAYS if d.year == y and d.month == m]

            # --- зарплата: аванс ~20-го (40%), зарплата ~5-го (60%) — всем в один день
            if c["employees"]:
                for pay_day, share in ((5, 0.6), (20, 0.4)):
                    day = workday_near(y, m, pay_day)
                    t0 = at(day, rng, hour=int(rng.integers(10, 16)))
                    if c["salary_project"]:
                        total = sum(e["salary"] for e in c["employees"]) * share
                        bank = world["bank"]
                        emit(c, t0, bank["inn"], account_at(bank, t0), "UL", "salary",
                             amount=total, round_p=0)
                    else:
                        for e in c["employees"]:
                            t = t0 + pd.Timedelta(minutes=float(rng.uniform(0, 40)))
                            emit(c, t, e["inn"], e["account"], "FL", "salary",
                                 amount=e["salary"] * share * rng.uniform(0.97, 1.03), round_p=0.5)

            # --- аренда: одна и та же сумма в начале месяца
            if c["rent"]:
                day = month_work[int(rng.integers(0, min(4, len(month_work))))]
                t = at(day, rng, HOUR_OOO)
                cp = c["rent"]["cp"]
                emit(c, t, cp["inn"], account_at(cp, t), cp["type"], "rent",
                     amount=c["rent"]["amount"], round_p=0)

            # --- налоги: ООО каждый месяц ~28-го (в апреле — за квартал),
            #     ИП — взносы в январе и налог за квартал в апреле
            tax = world["tax"]
            base_tax = sum(s["amount"] * s["w"] for s in c["suppliers"]) * c["per_month"] * 0.05
            if ooo or m in (1, 4):
                day = workday_near(y, m, 28 if ooo else 25)
                t = at(day, rng, HOUR_OOO)
                k = 3.0 if m == 4 else 1.0
                emit(c, t, tax["inn"], account_at(tax, t), "UL", "tax",
                     amount=base_tax * k * rng.uniform(0.7, 1.3), round_p=0.1)

            # --- кредит банку
            if c["loan"]:
                day = workday_near(y, m, 15)
                bank = world["bank"]
                t = at(day, rng, HOUR_OOO)
                emit(c, t, bank["inn"], account_at(bank, t), "UL", "loan",
                     amount=c["loan"], round_p=0)

            # --- поставщики и подрядчики: основная масса
            for _ in range(int(rng.poisson(c["per_month"]))):
                off = rng.random() < (0.03 if ooo else 0.12)
                day = (month_off if off and month_off else month_work)
                day = day[int(rng.integers(len(day)))]
                t = at(day, rng, hours)
                new_supplier = rng.random() < (0.04 if ooo else 0.06)
                if new_supplier:
                    # легально: новый контрагент, первый платёж часто крупнее
                    cp = world["pool"][int(rng.integers(len(world["pool"])))]
                    s = {"cp": cp, "w": 0.3,
                         "amount": cp["typical"] * c["scale"] ** 0.6 * (1 if ooo else 0.35)}
                    c["suppliers"].append(s)
                    amount = s["amount"] * rng.lognormal(0.4, 0.5)
                else:
                    w = np.array([s["w"] for s in c["suppliers"]])
                    s = c["suppliers"][int(rng.choice(len(w), p=w / w.sum()))]
                    amount = s["amount"] * rng.lognormal(0, 0.35)
                cp = s["cp"]
                emit(c, t, cp["inn"], account_at(cp, t), cp["type"], cp["purpose"],
                     amount=amount, round_p=0.3)

            # --- ИП переводит себе на личную карту (это норма)
            if not ooo:
                for _ in range(int(rng.integers(1, 5))):
                    day = DAYS[int(rng.integers(len(DAYS)))]
                    while day.month != m:
                        day = DAYS[int(rng.integers(len(DAYS)))]
                    t = at(day, rng, HOUR_IP)
                    # иногда почти весь остаток — трудный легальный случай
                    frac = rng.uniform(0.8, 0.95) if rng.random() < 0.06 else rng.uniform(0.1, 0.5)
                    emit(c, t, c["inn"], c["own_card"], "FL", "other", frac=frac)

            # --- самозанятые: физлица-исполнители, иногда новый человек
            for _ in range(int(rng.poisson(1.0)) if c["freelancers"] else 0):
                day = month_work[int(rng.integers(len(month_work)))]
                t = at(day, rng, hours)
                if rng.random() < 0.3:
                    f = {"inn": f"{rng.integers(10 ** 11, 10 ** 12)}",
                         "account": "40817810" + f"{rng.integers(0, 10 ** 12):012d}"}
                    c["freelancers"].append(f)
                else:
                    f = c["freelancers"][int(rng.integers(len(c["freelancers"])))]
                emit(c, t, f["inn"], f["account"], "FL", "services",
                     amount=rng.lognormal(np.log(15_000), 0.6) * (1 if ooo else 0.6), round_p=0.6)

            # --- возвраты покупателям-физлицам (каждый раз новый человек)
            if c["refunds"]:
                for _ in range(int(rng.integers(0, 4))):
                    day = month_work[int(rng.integers(len(month_work)))]
                    t = at(day, rng, hours)
                    emit(c, t, f"{rng.integers(10 ** 11, 10 ** 12)}",
                         "40817810" + f"{rng.integers(0, 10 ** 12):012d}", "FL", "refund",
                         amount=rng.lognormal(np.log(4_000), 0.8), round_p=0.2)

        # --- крупная разовая закупка у нового поставщика (оборудование, партия товара):
        #     новый получатель + большая доля остатка, но всё легально. У 35% клиентов.
        if rng.random() < 0.35:
            day = WORKDAYS[int(rng.integers(len(WORKDAYS)))]
            t = at(day, rng, HOUR_OOO)
            cp = world["pool"][int(rng.integers(len(world["pool"])))]
            emit(c, t, cp["inn"], account_at(cp, t), cp["type"], "goods",
                 frac=rng.uniform(0.2, 0.6))
    return events


# ============================================================ 5. мошенничество
def gen_fraud(rng, ids: Ids, clients: list[dict], target_rows: int) -> tuple[list[dict], set]:
    # пул счетов дропов: однодневки, подставные ИП, карты физлиц
    mules = []
    for kind, n in (("UL", 50), ("IP", 30), ("FL", 70)):
        for _ in range(n):
            mules.append({"inn": ids.inn(kind), "account": ids.account(kind), "type": kind})
    # Ципф: несколько «популярных» дропов получают деньги от многих жертв
    mw = 1 / np.arange(1, len(mules) + 1) ** 0.7
    rng.shuffle(mules)
    blacklist = {m["account"] for m in mules if rng.random() < 0.3}

    ooo = [c for c in clients if c["client_type"] == "OOO"]
    ips = [c for c in clients if c["client_type"] == "IP"]
    kinds = list(FRAUD_KINDS)
    goal = {k: share * target_rows for k, share in FRAUD_KINDS.items()}
    made = {k: 0 for k in kinds}
    events: list[dict] = []
    incident = 0

    def mule(types=("UL", "IP", "FL")) -> dict:
        cand = [i for i, m in enumerate(mules) if m["type"] in types]
        p = mw[cand] / mw[cand].sum()
        return mules[cand[int(rng.choice(len(cand), p=p))]]

    def emit(c, kind, ts, inn, account, rtype, purpose, device, channel,
             amount=None, frac=None):
        events.append({
            "timestamp": ts, "client_id": c["client_id"], "amount": amount, "frac": frac,
            "receiver_inn": inn, "receiver_account": account, "receiver_type": rtype,
            "purpose": purpose, "channel": channel, "device_id": device,
            "is_fraud": 1, "fraud_kind": kind, "incident": incident,
        })

    while len(events) < target_rows:
        incident += 1
        need = np.array([max(goal[k] - made[k], 0.01) for k in kinds])
        kind = str(rng.choice(kinds, p=need / need.sum()))
        rows_before = len(events)
        if kind == "ip_social":
            c = ips[int(rng.integers(len(ips)))]
        elif kind in ("bec", "ceo_fraud"):
            c = ooo[int(rng.integers(len(ooo)))] if rng.random() < 0.85 or kind == "ceo_fraud" \
                else ips[int(rng.integers(len(ips)))]
        else:
            c = clients[int(rng.integers(len(clients)))]
        own_dev = lambda t: str(rng.choice(devices_at(c, t)))  # noqa: E731

        if kind == "bec":
            # подмена реквизитов: письмо «у нас сменился счёт» от знакомого поставщика
            w = np.array([s["w"] for s in c["suppliers"]])
            s = c["suppliers"][int(rng.choice(len(w), p=w / w.sum()))]
            cp = s["cp"]
            acc = ids.account(cp["type"])
            if rng.random() < 0.15:
                blacklist.add(acc)
            # не в первые недели: подменяют реквизиты того, кому клиент уже платил
            t = at(WORKDAYS[int(rng.integers(15, len(WORKDAYS)))], rng, HOUR_OOO)
            for _ in range(1 if rng.random() < 0.7 else 2):
                emit(c, kind, t, cp["inn"], acc, cp["type"], cp["purpose"], own_dev(t),
                     c["channel"], amount=s["amount"] * rng.lognormal(0.3, 0.4))
                t = t + pd.Timedelta(days=float(rng.uniform(1, 6)))

        elif kind == "ceo_fraud":
            # «директор» в мессенджере: срочно оплатить новому контрагенту
            m = mule(("UL", "FL") if rng.random() < 0.4 else ("UL",))
            t = at(WORKDAYS[int(rng.integers(len(WORKDAYS)))], rng, hour=int(rng.integers(10, 18)))
            purpose = str(rng.choice(["other", "loan", "services"], p=[0.5, 0.3, 0.2]))
            for _ in range(1 if rng.random() < 0.8 else 2):
                emit(c, kind, t, m["inn"], m["account"], m["type"], purpose, own_dev(t),
                     c["channel"], frac=rng.uniform(0.2, 0.6))
                t = t + pd.Timedelta(hours=float(rng.uniform(0.5, 5)))

        elif kind == "dbo_takeover":
            # захват интернет-банка: сменили доступ, вошли с нового устройства, чаще вечером
            if rng.random() < 0.6:
                day = DAYS[int(rng.integers(len(DAYS)))]
                hour = int(rng.choice([19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5]))
            else:
                day = WORKDAYS[int(rng.integers(len(WORKDAYS)))]
                hour = int(rng.integers(9, 19))
            t = at(day, rng, hour=hour)
            c["access_changes"].append(t - pd.Timedelta(hours=float(rng.uniform(0.3, 48))))
            dev = ids.device(attacker=True)
            for j in range(int(rng.integers(1, 4))):
                m = mule(("FL", "IP") if rng.random() < 0.6 else ("UL",))
                emit(c, kind, t, m["inn"], m["account"], m["type"],
                     str(rng.choice(["other", "services", "goods"])), dev, "web",
                     frac=rng.uniform(0.4, 0.9) if j == 0 else rng.uniform(0.5, 0.95))
                t = t + pd.Timedelta(minutes=float(rng.uniform(3, 40)))

        elif kind == "drain":
            # вывод остатка пачкой: много новых получателей за час-два
            day = DAYS[int(rng.integers(len(DAYS)))]
            t = at(day, rng, hour=int(rng.integers(8, 23)))
            if rng.random() < 0.5:
                dev = ids.device(attacker=True)
                c["access_changes"].append(t - pd.Timedelta(hours=float(rng.uniform(1, 72))))
            else:
                dev = own_dev(t)        # вредонос или удалённый доступ на компьютере бухгалтера
            k = int(rng.integers(3, 9))
            for j in range(k):
                m = mule(("FL",) if rng.random() < 0.8 else ("UL", "IP"))
                frac = 1 / (k - j) * rng.uniform(0.85, 1.0)
                amount_round = rng.random() < 0.5
                emit(c, kind, t, m["inn"], m["account"], m["type"],
                     "salary" if m["type"] == "FL" and rng.random() < 0.4 else "other",
                     dev, c["channel"] if c["channel"] != "1c" else "web", frac=frac)
                if amount_round:
                    events[-1]["round"] = True
                t = t + pd.Timedelta(minutes=float(rng.uniform(2, 20)))

        else:  # ip_social — владельцу ИП звонит «служба безопасности банка»
            m = mule(("FL",))
            day = DAYS[int(rng.integers(len(DAYS)))]
            t = at(day, rng, hour=int(rng.integers(9, 22)))
            if rng.random() < 0.25:
                c["access_changes"].append(t - pd.Timedelta(hours=float(rng.uniform(0.2, 24))))
            for j in range(int(rng.integers(1, 4))):
                emit(c, kind, t, m["inn"], m["account"], "FL", "other", own_dev(t),
                     "mobile" if rng.random() < 0.7 else c["channel"],
                     frac=rng.uniform(0.5, 1.0) if j == 0 else rng.uniform(0.6, 1.0))
                t = t + pd.Timedelta(minutes=float(rng.uniform(5, 120)))

        made[kind] += len(events) - rows_before

    return events, blacklist


# ============================================================ 6. сборка
def finalize(rng, events: list[dict], clients: list[dict], blacklist: set) -> pd.DataFrame:
    df = pd.DataFrame(events)
    df = df[(df["timestamp"] >= START) & (df["timestamp"] < END)]
    df = df.sort_values(["client_id", "timestamp"]).reset_index(drop=True)
    by_id = {c["client_id"]: c for c in clients}
    period = (END - START).total_seconds()

    balances, amounts, hours_access = [], [], []
    for cid, g in df.groupby("client_id", sort=False):
        c = by_id[cid]
        # входящие деньги (оплаты от покупателей) в выгрузку не попадают —
        # моделируем их равномерным притоком, чтобы остаток не уходил в ноль
        legit_out = g.loc[g.is_fraud == 0, "amount"].fillna(0).sum()
        rate = legit_out / period * rng.uniform(1.05, 1.2)
        bal, prev = c["balance0"], START
        changes = sorted(c["access_changes"])
        for row in g.itertuples():
            bal += rate * (row.timestamp - prev).total_seconds()
            prev = row.timestamp
            amount = row.amount if pd.notna(row.amount) else bal * row.frac
            if getattr(row, "round", False) is True and amount > 2000:
                amount = np.floor(amount / 1000) * 1000
            if amount > bal:
                if row.is_fraud:
                    amount = bal * rng.uniform(0.9, 1.0)     # мошенник забирает что есть
                else:
                    bal = amount * rng.uniform(1.1, 1.6)     # пришла оплата от покупателя
            amount = round(max(amount, 1.0), 2)
            balances.append(round(bal, 2))
            amounts.append(amount)
            bal -= amount
            past = [t for t in changes if t <= row.timestamp]
            hours_access.append(round((row.timestamp - past[-1]).total_seconds() / 3600, 1)
                                if past else NO_CHANGE)

    df["client_balance"] = balances
    df["amount"] = amounts
    df["hours_since_access_change"] = hours_access
    df["client_type"] = df["client_id"].map(lambda x: by_id[x]["client_type"])
    df["receiver_blacklisted"] = df["receiver_account"].isin(blacklist).astype(int)
    # редкие ложные срабатывания базы: легальный счёт, попавший в стоп-лист
    legit_accounts = df.loc[df.is_fraud == 0, "receiver_account"].unique()
    false_bl = set(rng.choice(legit_accounts, size=max(1, len(legit_accounts) // 500), replace=False))
    df.loc[df["receiver_account"].isin(false_bl), "receiver_blacklisted"] = 1

    df = df.sort_values("timestamp", kind="stable").reset_index(drop=True)
    return df[["timestamp", "client_id", "client_type", "client_balance", "amount",
               "receiver_inn", "receiver_account", "receiver_type", "purpose", "channel",
               "device_id", "hours_since_access_change", "receiver_blacklisted",
               "is_fraud", "fraud_kind"]]


def build(fraud_share: float, seed: int) -> tuple[pd.DataFrame, dict]:
    rng = np.random.default_rng(seed)
    ids = Ids(rng)
    clients = make_clients(rng, ids)
    world = make_counterparties(rng, ids, clients)
    plan_life_events(rng, ids, clients, world)
    legit = gen_legit(rng, clients, world)
    target = int(len(legit) * fraud_share / (1 - fraud_share))
    fraud, blacklist = gen_fraud(rng, ids, clients, target)
    df = finalize(rng, legit + fraud, clients, blacklist)

    fr = df[df.is_fraud == 1]
    stats = {
        "rows": int(len(df)),
        "period": f"{df.timestamp.min():%Y-%m-%d %H:%M:%S} — {df.timestamp.max():%Y-%m-%d %H:%M:%S}",
        "clients": {"OOO": N_OOO, "IP": N_IP},
        "rows_by_client_type": df.client_type.value_counts().to_dict(),
        "fraud_rows": int(len(fr)),
        "fraud_rate": round(float(df.is_fraud.mean()), 4),
        "fraud_kinds_rows": fr.fraud_kind.value_counts().to_dict(),
        "fraud_by_month": fr.timestamp.dt.month.value_counts().sort_index()
                            .rename(lambda m: f"2025-{m:02d}").to_dict(),
        "purpose_share": df.purpose.value_counts(normalize=True).round(4).to_dict(),
        "receiver_type_share": df.receiver_type.value_counts(normalize=True).round(4).to_dict(),
        "seed": seed,
        "note": "Синтетика. Пороги продакшна на ней не настраивать.",
    }
    return df, stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fraud-share", type=float, default=0.01)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", default="synthetic_legal/legal_transfers.csv")
    args = ap.parse_args()

    df, stats = build(args.fraud_share, args.seed)

    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    out = df.copy()
    out["timestamp"] = out["timestamp"].dt.strftime("%Y-%m-%d %H:%M:%S")
    out.to_csv(path, index=False, encoding="utf-8")
    (path.parent / "metadata.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Файл: {path.resolve()}")
    print(f"Строк: {len(df):,} | период: {stats['period']}")
    print(f"Фрод: {stats['fraud_rows']:,} ({stats['fraud_rate']:.2%})")
    print("\nСтроки по типу клиента:", stats["rows_by_client_type"])
    print("\nТипы фрода (строки):")
    for k, v in stats["fraud_kinds_rows"].items():
        print(f"  {k:<13} {v}")
    print("\nФрод по месяцам:", stats["fraud_by_month"])
    print("\nПервые строки:")
    print(out.head(6).to_string(index=False))


if __name__ == "__main__":
    main()
