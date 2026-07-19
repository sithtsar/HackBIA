"""CLI: generate the HR attrition upload-demo CSVs.

This is the "live upload" demo pack: an HR domain (employees/reviews/exits)
the agent has never seen, with regretted attrition spiking in engineering
over the trailing 14 days (see scenarios.HR_ATTRITION's docstring). It is
deliberately NOT registered in scenarios.SCENARIOS so it is never
pre-seeded -- the CSVs this script writes are committed so they're ready to
drag into the upload demo on stage with no generation step.

Run: uv run python backend/data/upload_demo/generate.py
"""
from __future__ import annotations

import csv
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))  # repo root, for `backend.*` imports

from backend.app import scenarios  # noqa: E402

SEED = 42
OUT_DIR = Path(__file__).resolve().parent


def _write_csv(path: Path, rows: list[dict]) -> None:
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def main() -> None:
    tables = scenarios.HR_ATTRITION.build(random.Random(SEED), scenarios.ANCHOR)
    for name, rows in tables.items():
        _write_csv(OUT_DIR / f"{name}.csv", rows)
    counts = ", ".join(f"{len(rows)} {name}" for name, rows in tables.items())
    print(f"generated [hr_attrition] {counts} into {OUT_DIR} ({scenarios.HR_ATTRITION.anomaly})")


if __name__ == "__main__":
    main()
