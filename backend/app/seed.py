"""Deterministic demo data generator.

Writes one CSV per table for the active scenario into backend/data/ and loads
them into backend/data/foundry.duckdb. The default scenario (retail) produces
customers.csv / orders.csv / tickets.csv, whose columns line up with the joins
in data/ontology.yaml.

Every scenario plants an anomaly for the ask-agent to find — see
scenarios.py for what each one hides.

Idempotent: re-run any time, files/table are fully recreated. Switching
scenarios drops the previous scenario's tables and CSVs so the agent never
introspects a stale schema.

Run: uv run python -m backend.app.seed [--scenario retail|supply|fintech]
"""
from __future__ import annotations

import argparse
import csv
import random
from pathlib import Path

import duckdb

from . import scenarios
# Re-exported: the historical seed API, still the retail generators.
from .scenarios import (  # noqa: F401
    ANOMALY_DAYS,
    TOTAL_DAYS,
    gen_customers,
    gen_orders,
    gen_tickets,
)

SEED = 42
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA_DIR / "foundry.duckdb"


def _today():
    return scenarios.ANCHOR


def _write_csv(path: Path, rows: list[dict]) -> None:
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def _stale_csvs(keep: set[str]) -> list[Path]:
    """CSVs from a previously seeded scenario. Left behind, they sit in the
    data directory advertising a schema that is no longer loaded. Restricted
    to table names the scenarios themselves own, so a CSV a user dropped in
    is never deleted."""
    return [DATA_DIR / f"{name}.csv" for name in scenarios.owned_tables() - keep
            if (DATA_DIR / f"{name}.csv").exists()]


def main(scenario_key: str | None = None) -> None:
    scenario = scenarios.get(scenario_key)
    rng = random.Random(SEED)
    today = _today()
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    tables = scenario.build(rng, today)

    for stale in _stale_csvs(set(tables)):
        stale.unlink()
    for name, rows in tables.items():
        _write_csv(DATA_DIR / f"{name}.csv", rows)

    if DB_PATH.exists():
        DB_PATH.unlink()
    con = duckdb.connect(str(DB_PATH))
    for name in tables:
        con.execute(f"CREATE TABLE {name} AS SELECT * FROM read_csv_auto('{DATA_DIR / f'{name}.csv'}')")
    con.close()

    counts = ", ".join(f"{len(rows)} {name}" for name, rows in tables.items())
    print(f"seeded [{scenario.key}] {counts} into {DB_PATH} ({scenario.anomaly})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--scenario", choices=sorted(scenarios.SCENARIOS), default=scenarios.DEFAULT_SCENARIO)
    main(ap.parse_args().scenario)
