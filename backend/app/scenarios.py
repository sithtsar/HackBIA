"""Demo scenario packs.

Each scenario is a self-contained domain: a set of tables, a planted anomaly
for the ask-agent to find, and a suggested question that surfaces it. The
agent does not know any of these schemas — it introspects whatever tables
exist and drafts an ontology from them — so adding a scenario is purely a
data exercise, no agent or prompt changes.

Retail is the default and generates exactly the data the demo has always used.
"""
from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Callable

TOTAL_DAYS = 365
ANOMALY_DAYS = 14

# Fixed anchor so every scenario's data (and its anomaly window) is
# reproducible across runs regardless of wall-clock date.
ANCHOR = date(2026, 7, 3)


@dataclass(frozen=True)
class Scenario:
    key: str
    label: str
    # rng, today -> {table_name: rows}. Table names become DuckDB tables and
    # <name>.csv files; the agent discovers them by introspection.
    build: Callable[[random.Random, date], dict[str, list[dict]]]
    # Declared up front so a scenario switch knows which CSVs to clean up
    # without having to generate the data first. Must match build()'s keys —
    # test_scenarios.py asserts it.
    tables: tuple[str, ...]
    anomaly: str
    question: str
    # The planted answer, as (table, column, value), or None when the whole
    # table spikes. Supply and fintech degrade only inside one segment, so in
    # aggregate they look like noise — this records where the signal actually
    # lives, both for the demo script and so a test can assert it survives.
    focus: tuple[str, str, str] | None = None


def owned_tables() -> set[str]:
    """Every table name any scenario owns. Used to clean up a previous
    scenario's CSVs without touching files the demo did not create."""
    return {t for s in SCENARIOS.values() for t in s.tables}


# --------------------------------------------------------------------------
# retail — the original demo: SLA breaches spike in the trailing 14 days
# --------------------------------------------------------------------------

FIRST_NAMES = ["Alex", "Jordan", "Sam", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Drew", "Avery",
               "Cameron", "Reese", "Skyler", "Rowan", "Quinn", "Elliot", "Harper", "Finley", "Blake", "Sage"]
LAST_NAMES = ["Nguyen", "Smith", "Patel", "Garcia", "Kim", "Johnson", "Chen", "Brown", "Davis", "Lopez",
              "Martin", "Clark", "Lewis", "Walker", "Young", "King", "Wright", "Scott", "Torres", "Hill"]
SEGMENTS = ["smb", "midmarket", "enterprise"]
ORDER_STATUSES = ["completed", "completed", "completed", "pending", "cancelled"]
TICKET_CATEGORIES = ["billing", "technical", "shipping", "account"]
TICKET_PRIORITIES = ["low", "medium", "high"]

N_CUSTOMERS = 500
N_ORDERS = 2000


def gen_customers(rng: random.Random, today: date) -> list[dict]:
    rows = []
    for i in range(1, N_CUSTOMERS + 1):
        first, last = rng.choice(FIRST_NAMES), rng.choice(LAST_NAMES)
        rows.append({
            "id": f"cust_{i:04d}",
            "name": f"{first} {last}",
            "email": f"{first.lower()}.{last.lower()}{i}@example.com",
            "signup_date": (today - timedelta(days=rng.randint(30, 730))).isoformat(),
            "segment": rng.choice(SEGMENTS),
        })
    return rows


def gen_orders(rng: random.Random, today: date, customer_ids: list[str]) -> list[dict]:
    rows = []
    for i in range(1, N_ORDERS + 1):
        # day_offset is drawn before the dict is built, not inlined into it:
        # the draw order defines the RNG stream, so inlining it silently
        # regenerates every downstream row and changes the committed CSVs.
        day_offset = rng.randint(0, TOTAL_DAYS - 1)
        rows.append({
            "id": f"ord_{i:05d}",
            "customer_id": rng.choice(customer_ids),
            "order_date": (today - timedelta(days=day_offset)).isoformat(),
            "amount": round(rng.uniform(15, 480), 2),
            "status": rng.choice(ORDER_STATUSES),
        })
    return rows


def gen_tickets(rng: random.Random, today: date, customer_ids: list[str]) -> list[dict]:
    rows = []
    n = 0
    for day_offset in range(TOTAL_DAYS - 1, -1, -1):  # oldest -> newest
        the_day = today - timedelta(days=day_offset)
        in_anomaly = day_offset < ANOMALY_DAYS
        daily_count = rng.randint(4, 6) if in_anomaly else rng.randint(1, 2)
        breach_p = 0.40 if in_anomaly else 0.10
        for _ in range(daily_count):
            n += 1
            rows.append({
                "id": f"tkt_{n:04d}",
                "customer_id": rng.choice(customer_ids),
                "created_date": the_day.isoformat(),
                "category": rng.choice(TICKET_CATEGORIES),
                "priority": rng.choice(TICKET_PRIORITIES),
                "sla_breached": rng.random() < breach_p,
            })
    return rows


def _build_retail(rng: random.Random, today: date) -> dict[str, list[dict]]:
    customers = gen_customers(rng, today)
    customer_ids = [c["id"] for c in customers]
    return {
        "customers": customers,
        "orders": gen_orders(rng, today, customer_ids),
        "tickets": gen_tickets(rng, today, customer_ids),
    }


# --------------------------------------------------------------------------
# supply — one supplier's on-time rate collapses in the trailing 14 days
# --------------------------------------------------------------------------

SUPPLIER_NAMES = ["Meridian Parts", "Kestrel Logistics", "Orbit Components", "Halden Materials",
                  "Verity Supply", "Northwind Freight", "Ardent Industrial", "Cobalt Trading"]
REGIONS = ["emea", "apac", "namer", "latam"]
MODES = ["air", "sea", "road", "rail"]
DELAY_REASONS = ["customs", "weather", "capacity", "documentation", "mechanical"]


def _build_supply(rng: random.Random, today: date) -> dict[str, list[dict]]:
    suppliers = []
    for i, name in enumerate(SUPPLIER_NAMES, start=1):
        suppliers.append({
            "id": f"sup_{i:03d}",
            "name": name,
            "region": rng.choice(REGIONS),
            "onboarded_date": (today - timedelta(days=rng.randint(200, 1500))).isoformat(),
            "tier": rng.choice(["primary", "secondary", "backup"]),
        })
    supplier_ids = [s["id"] for s in suppliers]
    culprit = supplier_ids[2]  # planted: this one degrades sharply in-window

    shipments, delays = [], []
    n = 0
    for day_offset in range(TOTAL_DAYS - 1, -1, -1):
        the_day = today - timedelta(days=day_offset)
        in_anomaly = day_offset < ANOMALY_DAYS
        for _ in range(rng.randint(5, 8)):
            n += 1
            sup = rng.choice(supplier_ids)
            # Baseline late rate ~12%; the culprit jumps to ~65% in-window.
            is_late = rng.random() < (0.65 if (in_anomaly and sup == culprit) else 0.12)
            days_late = rng.randint(2, 11) if is_late else 0
            sid = f"shp_{n:05d}"
            shipments.append({
                "id": sid,
                "supplier_id": sup,
                "ship_date": the_day.isoformat(),
                "mode": rng.choice(MODES),
                "units": rng.randint(20, 900),
                "value": round(rng.uniform(400, 26000), 2),
                "delivered_late": is_late,
            })
            if is_late:
                delays.append({
                    "id": f"dly_{len(delays) + 1:05d}",
                    "shipment_id": sid,
                    "supplier_id": sup,
                    "reported_date": the_day.isoformat(),
                    "days_late": days_late,
                    "reason": rng.choice(DELAY_REASONS),
                    "cost_impact": round(days_late * rng.uniform(60, 340), 2),
                })

    return {"suppliers": suppliers, "shipments": shipments, "delays": delays}


# --------------------------------------------------------------------------
# fintech — chargeback rate on one channel spikes in the trailing 14 days
# --------------------------------------------------------------------------

CHANNELS = ["card_present", "ecommerce", "mobile_wallet", "bank_transfer"]
MERCHANT_CATS = ["travel", "electronics", "grocery", "gaming", "subscription"]
CHARGEBACK_REASONS = ["fraud", "product_not_received", "duplicate", "authorization", "quality"]

N_ACCOUNTS = 600


def _build_fintech(rng: random.Random, today: date) -> dict[str, list[dict]]:
    accounts = []
    for i in range(1, N_ACCOUNTS + 1):
        accounts.append({
            "id": f"acct_{i:05d}",
            "opened_date": (today - timedelta(days=rng.randint(60, 1600))).isoformat(),
            "country": rng.choice(["US", "GB", "DE", "IN", "SG", "BR"]),
            "risk_band": rng.choice(["low", "low", "medium", "high"]),
            "kyc_verified": rng.random() < 0.93,
        })
    account_ids = [a["id"] for a in accounts]

    transactions, chargebacks = [], []
    n = 0
    for day_offset in range(TOTAL_DAYS - 1, -1, -1):
        the_day = today - timedelta(days=day_offset)
        in_anomaly = day_offset < ANOMALY_DAYS
        for _ in range(rng.randint(12, 20)):
            n += 1
            channel = rng.choice(CHANNELS)
            # Baseline chargeback ~0.9%; mobile_wallet jumps to ~11% in-window.
            is_cb = rng.random() < (0.11 if (in_anomaly and channel == "mobile_wallet") else 0.009)
            tid = f"txn_{n:06d}"
            transactions.append({
                "id": tid,
                "account_id": rng.choice(account_ids),
                "txn_date": the_day.isoformat(),
                "channel": channel,
                "merchant_category": rng.choice(MERCHANT_CATS),
                "amount": round(rng.uniform(4, 1900), 2),
                "charged_back": is_cb,
            })
            if is_cb:
                chargebacks.append({
                    "id": f"cb_{len(chargebacks) + 1:05d}",
                    "transaction_id": tid,
                    "filed_date": (the_day + timedelta(days=rng.randint(1, 9))).isoformat(),
                    "reason": rng.choice(CHARGEBACK_REASONS),
                    "amount": round(rng.uniform(4, 1900), 2),
                    "resolved": rng.random() < 0.55,
                })

    return {"accounts": accounts, "transactions": transactions, "chargebacks": chargebacks}


SCENARIOS: dict[str, Scenario] = {
    "retail": Scenario(
        key="retail",
        label="Retail support operations",
        build=_build_retail,
        tables=("customers", "orders", "tickets"),
        anomaly="ticket volume ~3x and SLA breach rate 10% -> 40% over the trailing 14 days",
        question="Why did support tickets spike recently?",
    ),
    "supply": Scenario(
        key="supply",
        label="Supply chain delivery performance",
        build=_build_supply,
        tables=("suppliers", "shipments", "delays"),
        anomaly="one supplier's late-delivery rate 12% -> 65% over the trailing 14 days",
        question="Which supplier is driving our late deliveries?",
        focus=("shipments", "supplier_id", "sup_003"),
    ),
    "fintech": Scenario(
        key="fintech",
        label="Payments risk and chargebacks",
        build=_build_fintech,
        tables=("accounts", "transactions", "chargebacks"),
        anomaly="mobile_wallet chargeback rate 0.9% -> 11% over the trailing 14 days",
        question="Which payment channel is driving chargebacks?",
        focus=("transactions", "channel", "mobile_wallet"),
    ),
}

DEFAULT_SCENARIO = "retail"


def get(key: str | None) -> Scenario:
    """Resolve a scenario key, falling back to the default when unset."""
    resolved = key or DEFAULT_SCENARIO
    if resolved not in SCENARIOS:
        raise KeyError(f"unknown scenario {resolved!r}; known: {sorted(SCENARIOS)}")
    return SCENARIOS[resolved]
