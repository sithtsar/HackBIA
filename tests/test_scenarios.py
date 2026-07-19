import random
from datetime import timedelta

import pytest
import yaml

from backend.app import ontology as onto_mod
from backend.app import scenarios


@pytest.mark.parametrize("key", sorted(scenarios.SCENARIOS))
def test_declared_tables_match_what_build_produces(key):
    """Scenario.tables drives CSV cleanup on a scenario switch, so a drift
    between it and build() would leave a stale table loaded and let the agent
    introspect a schema that is no longer there."""
    scenario = scenarios.SCENARIOS[key]
    built = scenario.build(random.Random(42), scenarios.ANCHOR)
    assert tuple(built) == scenario.tables


@pytest.mark.parametrize("key", sorted(scenarios.SCENARIOS))
def test_every_scenario_plants_a_findable_anomaly(key):
    """The whole demo rests on the ask-agent finding something. If a
    generator's rates ever drift to noise the demo silently becomes boring,
    so assert the in-window signal is actually elevated."""
    scenario = scenarios.SCENARIOS[key]
    built = scenario.build(random.Random(42), scenarios.ANCHOR)
    cutoff = scenarios.ANCHOR - timedelta(days=scenarios.ANOMALY_DAYS)

    # (table, date column, boolean column that marks the bad outcome)
    table, date_col, flag = {
        "retail": ("tickets", "created_date", "sla_breached"),
        "supply": ("shipments", "ship_date", "delivered_late"),
        "fintech": ("transactions", "txn_date", "charged_back"),
    }[key]

    rows = built[table]
    # Supply and fintech degrade inside one segment only, so measuring the
    # whole table averages the spike away into noise (supply reads 14% vs 12%
    # in aggregate but 65% vs 12% for the culprit). Narrow to the segment the
    # demo question actually asks about.
    if scenario.focus:
        focus_table, focus_col, focus_val = scenario.focus
        assert focus_table == table
        rows = [r for r in rows if r[focus_col] == focus_val]

    inside = [r for r in rows if r[date_col] >= cutoff.isoformat()]
    outside = [r for r in rows if r[date_col] < cutoff.isoformat()]

    rate_in = sum(bool(r[flag]) for r in inside) / len(inside)
    rate_out = sum(bool(r[flag]) for r in outside) / len(outside)
    assert rate_in > rate_out * 2, f"{key}: in-window {rate_in:.3f} vs baseline {rate_out:.3f}"


def test_generated_retail_baseline_matches_the_committed_file():
    """Retail resets by copying ontology.baseline.yaml while other scenarios
    reset from baseline_for(). If those two ever disagree, switching to
    another scenario and back would silently change retail's starting state."""
    committed = yaml.safe_load(onto_mod.ONTOLOGY_BASELINE_PATH.read_text())
    generated = onto_mod.baseline_for(scenarios.SCENARIOS["retail"].tables)
    assert committed == generated


def test_retail_row_counts_are_frozen():
    """Pins retail's RNG stream. The draw ORDER defines the stream, so an
    innocuous refactor — inlining a randint into a dict literal, say —
    regenerates every row and rewrites the committed CSVs. Caught exactly
    that during the scenario refactor: tickets went 592 -> 589."""
    built = scenarios.SCENARIOS["retail"].build(random.Random(42), scenarios.ANCHOR)
    assert (len(built["customers"]), len(built["orders"]), len(built["tickets"])) == (500, 2000, 592)


def test_unknown_scenario_is_rejected_loudly():
    with pytest.raises(KeyError):
        scenarios.get("nope")


def test_get_defaults_to_retail():
    assert scenarios.get(None).key == "retail"
