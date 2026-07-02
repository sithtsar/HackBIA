import random
from datetime import date

from backend.app.seed import ANOMALY_DAYS, TOTAL_DAYS, gen_customers, gen_orders, gen_tickets


def test_seed_is_deterministic():
    rng1, rng2 = random.Random(42), random.Random(42)
    today = date(2026, 7, 3)
    c1 = gen_customers(rng1, today)
    c2 = gen_customers(rng2, today)
    assert c1 == c2


def test_ticket_anomaly_window_spikes_volume_and_breach_rate():
    rng = random.Random(42)
    today = date(2026, 7, 3)
    customers = gen_customers(rng, today)
    customer_ids = [c["id"] for c in customers]
    orders = gen_orders(rng, today, customer_ids)
    tickets = gen_tickets(rng, today, customer_ids)

    assert len(customers) == 500
    assert len(orders) == 2000
    assert 400 <= len(tickets) <= 800

    normal = [t for t in tickets if (today - date.fromisoformat(t["created_date"])).days >= ANOMALY_DAYS]
    anomaly = [t for t in tickets if (today - date.fromisoformat(t["created_date"])).days < ANOMALY_DAYS]
    normal_daily = len(normal) / (TOTAL_DAYS - ANOMALY_DAYS)
    anomaly_daily = len(anomaly) / ANOMALY_DAYS
    assert anomaly_daily > 2.5 * normal_daily

    normal_breach = sum(t["sla_breached"] for t in normal) / len(normal)
    anomaly_breach = sum(t["sla_breached"] for t in anomaly) / len(anomaly)
    assert anomaly_breach > 2 * normal_breach

    # join-key integrity: every order/ticket customer_id must exist in customers
    cust_id_set = set(customer_ids)
    assert {o["customer_id"] for o in orders} <= cust_id_set
    assert {t["customer_id"] for t in tickets} <= cust_id_set
