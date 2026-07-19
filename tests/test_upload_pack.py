import random
from datetime import timedelta

from backend.app import scenarios


def test_hr_attrition_is_not_registered():
    """The whole point of the upload-demo pack is that the agent has never
    seen it. If it ever leaked into SCENARIOS it would get pre-seeded and
    the live-upload beat would be a lie."""
    assert "hr_attrition" not in scenarios.SCENARIOS
    assert scenarios.HR_ATTRITION.key == "hr_attrition"


def test_declared_tables_match_what_build_produces():
    built = scenarios.HR_ATTRITION.build(random.Random(42), scenarios.ANCHOR)
    assert tuple(built) == scenarios.HR_ATTRITION.tables


def test_build_is_deterministic():
    a = scenarios.HR_ATTRITION.build(random.Random(42), scenarios.ANCHOR)
    b = scenarios.HR_ATTRITION.build(random.Random(42), scenarios.ANCHOR)
    assert a == b


def test_committed_csvs_match_the_generator():
    """The CSVs in backend/data/upload_demo/ are committed so there's no
    generation step on stage. If they ever drift from what the generator
    produces, the drag-in demo would show stale or mismatched data."""
    import csv as csv_mod
    from pathlib import Path

    upload_dir = Path(__file__).resolve().parent.parent / "backend" / "data" / "upload_demo"
    built = scenarios.HR_ATTRITION.build(random.Random(42), scenarios.ANCHOR)
    for name, rows in built.items():
        with open(upload_dir / f"{name}.csv", newline="") as f:
            committed = list(csv_mod.DictReader(f))
        # CSV round-trips everything as strings/"" for None/bool as "True"/"False";
        # normalize the generated rows the same way before comparing.
        normalized = [{k: ("" if v is None else str(v)) for k, v in r.items()} for r in rows]
        assert committed == normalized, f"{name}.csv is stale; regenerate with backend/data/upload_demo/generate.py"


def test_regretted_attrition_is_elevated_in_engineering_in_window():
    """The planted anomaly: regretted-exit rate in engineering spikes in the
    trailing 14 days, same style as supply/fintech's focus-segment signal."""
    built = scenarios.HR_ATTRITION.build(random.Random(42), scenarios.ANCHOR)
    cutoff = scenarios.ANCHOR - timedelta(days=scenarios.ANOMALY_DAYS)

    focus_table, focus_col, focus_val = scenarios.HR_ATTRITION.focus
    assert focus_table == "exits"
    rows = [r for r in built["exits"] if r[focus_col] == focus_val]

    inside = [r for r in rows if r["exit_date"] >= cutoff.isoformat()]
    outside = [r for r in rows if r["exit_date"] < cutoff.isoformat()]
    assert inside and outside

    rate_in = sum(bool(r["regretted"]) for r in inside) / len(inside)
    rate_out = sum(bool(r["regretted"]) for r in outside) / len(outside)
    assert rate_in > rate_out * 2, f"engineering: in-window {rate_in:.3f} vs baseline {rate_out:.3f}"
