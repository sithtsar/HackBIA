"""Deterministic demo data generator.

Writes customers.csv / orders.csv / tickets.csv to backend/data/ and loads
them into backend/data/foundry.duckdb. Columns line up with the joins in
data/ontology.yaml: orders.customer_id -> customers.id,
tickets.customer_id -> customers.id.

Plants the anomaly the ask-agent (Task 2) is meant to find: over the last
14 days, ticket volume runs ~3x the trailing daily rate and the SLA-breach
rate jumps from ~10% to ~40%.

Idempotent: re-run any time, files/table are fully recreated.
Run: uv run python -m backend.app.seed
"""
from __future__ import annotations

import csv
import random
from datetime import date, timedelta
from pathlib import Path

import duckdb

SEED = 42
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA_DIR / "foundry.duckdb"

N_CUSTOMERS = 500
N_ORDERS = 2000
TOTAL_DAYS = 365
ANOMALY_DAYS = 14

FIRST_NAMES = ["Alex", "Jordan", "Sam", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Drew", "Avery",
               "Cameron", "Reese", "Skyler", "Rowan", "Quinn", "Elliot", "Harper", "Finley", "Blake", "Sage"]
LAST_NAMES = ["Nguyen", "Smith", "Patel", "Garcia", "Kim", "Johnson", "Chen", "Brown", "Davis", "Lopez",
              "Martin", "Clark", "Lewis", "Walker", "Young", "King", "Wright", "Scott", "Torres", "Hill"]
SEGMENTS = ["smb", "midmarket", "enterprise"]
ORDER_STATUSES = ["completed", "completed", "completed", "pending", "cancelled"]
TICKET_CATEGORIES = ["billing", "technical", "shipping", "account"]
TICKET_PRIORITIES = ["low", "medium", "high"]


def _today() -> date:
    # Fixed anchor so seeded data (and the planted anomaly window) is
    # reproducible across runs regardless of wall-clock date.
    return date(2026, 7, 3)


def gen_customers(rng: random.Random, today: date) -> list[dict]:
    rows = []
    for i in range(1, N_CUSTOMERS + 1):
        first, last = rng.choice(FIRST_NAMES), rng.choice(LAST_NAMES)
        signup_offset = rng.randint(30, 730)
        rows.append({
            "id": f"cust_{i:04d}",
            "name": f"{first} {last}",
            "email": f"{first.lower()}.{last.lower()}{i}@example.com",
            "signup_date": (today - timedelta(days=signup_offset)).isoformat(),
            "segment": rng.choice(SEGMENTS),
        })
    return rows


def gen_orders(rng: random.Random, today: date, customer_ids: list[str]) -> list[dict]:
    rows = []
    for i in range(1, N_ORDERS + 1):
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


def _write_csv(path: Path, rows: list[dict]) -> None:
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def main() -> None:
    rng = random.Random(SEED)
    today = _today()
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    customers = gen_customers(rng, today)
    customer_ids = [c["id"] for c in customers]
    orders = gen_orders(rng, today, customer_ids)
    tickets = gen_tickets(rng, today, customer_ids)

    _write_csv(DATA_DIR / "customers.csv", customers)
    _write_csv(DATA_DIR / "orders.csv", orders)
    _write_csv(DATA_DIR / "tickets.csv", tickets)

    if DB_PATH.exists():
        DB_PATH.unlink()
    con = duckdb.connect(str(DB_PATH))
    con.execute(f"CREATE TABLE customers AS SELECT * FROM read_csv_auto('{DATA_DIR / 'customers.csv'}')")
    con.execute(f"CREATE TABLE orders AS SELECT * FROM read_csv_auto('{DATA_DIR / 'orders.csv'}')")
    con.execute(f"CREATE TABLE tickets AS SELECT * FROM read_csv_auto('{DATA_DIR / 'tickets.csv'}')")
    con.close()

    anomaly_start = today - timedelta(days=ANOMALY_DAYS)
    print(f"seeded {len(customers)} customers, {len(orders)} orders, {len(tickets)} tickets "
          f"into {DB_PATH} (anomaly window: {anomaly_start} .. {today})")


if __name__ == "__main__":
    main()
