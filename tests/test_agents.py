"""Task 2 agent tests. LLM network calls are excluded from the default run
(marked @pytest.mark.llm); everything here mocks the llm_draft_metrics/
llm_ask/llm_draft_action/llm_interpret_insight seams (thin wrappers around
the generated BAML `b.*` functions — see backend/app/agents.py's module
docstring)."""
import asyncio

import pytest

from backend.app import agents, seed
from backend.app.events import EventBus
from baml_client.types import (
    ActionDraftResponse,
    AskResponse,
    DraftMetric,
    DraftMetricsResponse,
    InsightInterpretation,
)


@pytest.fixture(scope="module", autouse=True)
def _ensure_db():
    if not agents.DB_PATH.exists():
        seed.main()
    yield


# --- SQL guard regex --------------------------------------------------------

def test_guard_allows_select():
    assert agents.guard_sql("SELECT count(*) FROM customers") is None


def test_guard_allows_with():
    assert agents.guard_sql("WITH x AS (SELECT 1 AS n) SELECT n FROM x") is None


def test_guard_allows_trailing_semicolon():
    assert agents.guard_sql("SELECT 1;") is None


def test_guard_rejects_drop():
    assert agents.guard_sql("DROP TABLE customers") is not None


def test_guard_rejects_update():
    assert agents.guard_sql("UPDATE customers SET name = 'x'") is not None


def test_guard_rejects_multi_statement():
    assert agents.guard_sql("SELECT 1; DROP TABLE customers") is not None


def test_guard_rejects_embedded_ddl():
    assert agents.guard_sql("SELECT 1 FROM t; INSERT INTO t VALUES (1)") is not None


def test_guard_rejects_empty():
    assert agents.guard_sql("   ") is not None


def test_guard_rejects_lowercase_injection():
    assert agents.guard_sql("select 1; drop table x") is not None


def test_guard_rejects_comment_prefixed_dml():
    assert agents.guard_sql("/* hi */ DELETE FROM orders") is not None


# --- FK inference on the seeded duckdb --------------------------------------

def test_fk_inference_finds_the_two_known_joins():
    schema = agents.introspect()
    fks = agents.infer_fks(schema)
    pairs = {(f["from_table"], f["from_col"], f["to_table"], f["to_col"]) for f in fks}
    assert ("orders", "customer_id", "customers", "id") in pairs
    assert ("tickets", "customer_id", "customers", "id") in pairs
    assert len(fks) == 2  # no spurious joins
    for f in fks:
        assert f["confidence"] >= 0.9


# --- Prompt builder truncation ----------------------------------------------

def test_schema_prompt_caps_rows_at_10():
    schema = {
        "t": {
            "columns": [("id", "VARCHAR"), ("blob", "VARCHAR")],
            "rows": [{"id": f"r{i}", "blob": "x" * 500} for i in range(15)],
        }
    }
    prompt = agents.build_schema_prompt(schema)
    row_lines = [ln for ln in prompt.splitlines() if ln.startswith("  {")]
    assert len(row_lines) == 10  # 15 sample rows -> capped to 10
    assert "x" * 500 not in prompt  # long strings truncated


# --- Mocked-LLM run_ask end-to-end ------------------------------------------

def _collect_run(coro_factory):
    """Run an agent coroutine against a real in-memory bus, return the ordered
    list of event types published during the run."""
    bus = EventBus()
    events: list[str] = []
    bus.add_listener(lambda env: events.append(env.type))

    async def go():
        bus.bind_loop(asyncio.get_running_loop())
        await coro_factory(bus)

    asyncio.run(go())
    return events


def _patch_ontology(monkeypatch, extra_objects=None):
    """Monkeypatch onto_mod.load_ontology to return ontology with extra objects."""
    import yaml
    from backend.app.ontology import ONTOLOGY_PATH
    orig = yaml.safe_load(ONTOLOGY_PATH.read_text())
    if extra_objects:
        orig.setdefault("objects", []).extend(extra_objects)
    monkeypatch.setattr(agents.onto_mod, "load_ontology", lambda: orig)


def test_run_ask_event_sequence_mocked_llm(monkeypatch):
    _patch_ontology(monkeypatch, [
        {"id": "obj_customer", "name": "Customer", "table": "customers"},
    ])
    # Canned planner output: a valid, guard-passing, EXPLAIN-able query against
    # an approved object term. Customers question -> no ticket insight.
    def fake_llm_ask(question, approved_terms_json, schema_and_samples, retry_note):
        return AskResponse(
            sql="SELECT count(*) AS n FROM customers",
            terms_used=["obj_customer"],
            reasoning_one_line="count all customers",
        )

    def fake_llm_interpret(question, sql, result_json, terms_used_json):
        return InsightInterpretation(
            has_insight=False, text="", severity="info",
            warrants_action=False, reasoning_one_line="routine count",
        )

    monkeypatch.setattr(agents, "llm_ask", fake_llm_ask)
    monkeypatch.setattr(agents, "llm_interpret_insight", fake_llm_interpret)

    types = _collect_run(lambda bus: agents.run_ask(bus, "run_test", "How many customers do we have?"))

    assert types[0] == "run_started"
    assert types[-1] == "run_completed"
    # core sequence present and ordered
    assert "node_touched" in types
    assert types.index("sql_generated") < types.index("sql_result")
    assert types.index("sql_result") < types.index("run_completed")
    # routine query -> no insight fired
    assert "insight" not in types
    assert "action_proposed" not in types


def test_run_ask_with_insight_from_llm_interpretation(monkeypatch):
    _patch_ontology(monkeypatch, [
        {"id": "obj_ticket", "name": "Support Ticket", "table": "tickets"},
    ])
    """When the LLM interpret finds an insight, insight event fires but no
    auto-action (decoupled — user must request action via API)."""
    def fake_llm_ask(question, approved_terms_json, schema_and_samples, retry_note):
        return AskResponse(
            sql="SELECT count(*) AS n FROM tickets",
            terms_used=["obj_ticket"],
            reasoning_one_line="count tickets",
        )

    insight_called = False

    def fake_llm_interpret(question, sql, result_json, terms_used_json):
        nonlocal insight_called
        insight_called = True
        return InsightInterpretation(
            has_insight=True,
            text="Ticket volume is elevated",
            severity="critical",
            warrants_action=True,
            reasoning_one_line="spike detected",
        )

    monkeypatch.setattr(agents, "llm_ask", fake_llm_ask)
    monkeypatch.setattr(agents, "llm_interpret_insight", fake_llm_interpret)

    types = _collect_run(
        lambda bus: agents.run_ask(bus, "run_tix", "What is happening with support tickets lately?")
    )

    assert insight_called
    assert "insight" in types
    # NO auto-action — action is now user-initiated via separate endpoint
    assert "action_proposed" not in types
    assert types.index("insight") < types.index("run_completed")


def test_run_ask_retries_after_first_llm_failure(monkeypatch):
    _patch_ontology(monkeypatch, [
        {"id": "obj_customer", "name": "Customer", "table": "customers"},
    ])
    retry_notes: list[str] = []

    def fake_llm_ask(question, approved_terms_json, schema_and_samples, retry_note):
        retry_notes.append(retry_note)
        if len(retry_notes) == 1:
            raise ValueError("BAML: failed to parse into AskResponse")
        return AskResponse(sql="SELECT count(*) AS n FROM customers", terms_used=["obj_customer"], reasoning_one_line="ok")

    def fake_llm_interpret(question, sql, result_json, terms_used_json):
        return InsightInterpretation(
            has_insight=False, text="", severity="info",
            warrants_action=False, reasoning_one_line="ok",
        )

    monkeypatch.setattr(agents, "llm_ask", fake_llm_ask)
    monkeypatch.setattr(agents, "llm_interpret_insight", fake_llm_interpret)

    types = _collect_run(lambda bus: agents.run_ask(bus, "run_retry", "How many customers do we have?"))

    assert len(retry_notes) == 2
    assert retry_notes[0] == ""  # first attempt: no retry context yet
    assert "failed to validate" in retry_notes[1]  # second attempt carries the failure
    assert "error" not in types  # recovered on the second attempt
    assert types[-1] == "run_completed"
    assert "sql_generated" in types


def test_run_ask_exhausts_both_attempts_emits_error(monkeypatch):
    def fake_llm_ask(question, approved_terms_json, schema_and_samples, retry_note):
        raise ValueError("BAML: failed to parse into AskResponse")

    monkeypatch.setattr(agents, "llm_ask", fake_llm_ask)

    types = _collect_run(lambda bus: agents.run_ask(bus, "run_fail", "How many customers do we have?"))

    assert "error" in types
    assert types[-1] == "run_completed"
    assert "sql_generated" not in types


def test_run_ontology_draft_mocked_llm(monkeypatch, tmp_path):
    # Isolate ontology.yaml: copy to tmp_path and repoint load/save (their
    # `path` defaults are bound at def-time, so patch the module functions
    # rather than the ONTOLOGY_PATH constant, which reassigning wouldn't affect).
    tmp_yaml = tmp_path / "ontology.yaml"
    tmp_yaml.write_text(agents.onto_mod.ONTOLOGY_PATH.read_text())
    real_load, real_save = agents.onto_mod.load_ontology, agents.onto_mod.save_ontology
    monkeypatch.setattr(agents.onto_mod, "load_ontology", lambda path=tmp_yaml: real_load(path))
    monkeypatch.setattr(agents.onto_mod, "save_ontology", lambda onto, path=tmp_yaml: real_save(onto, path))

    baseline = real_load(tmp_yaml)
    baseline_metrics = {m["id"]: dict(m) for m in baseline["metrics"]}
    baseline_joins = {j["id"]: dict(j) for j in baseline["joins"]}

    def fake_llm_draft_metrics(schema_and_samples, inferred_joins_json):
        return DraftMetricsResponse(metrics=[
            DraftMetric(id="m_full_conf", name="Full Confidence Metric", definition="silly but valid",
                        sql="SELECT count(*) AS n FROM customers", source_tables=["customers"],
                        confidence=1.0),  # self-reported max confidence -> must be capped
            DraftMetric(id="m_bad_sql", name="Bad SQL Metric", definition="deliberately broken",
                        sql="SELECT * FROM not_a_real_table", source_tables=["customers"],
                        confidence=0.7),  # fails EXPLAIN -> forced to low confidence
        ])

    monkeypatch.setattr(agents, "llm_draft_metrics", fake_llm_draft_metrics)

    bus = EventBus()
    envs: list = []
    bus.add_listener(lambda env: envs.append(env))

    async def go():
        bus.bind_loop(asyncio.get_running_loop())
        await agents.run_ontology_draft(bus, "run_draft")

    asyncio.run(go())

    types = [e.type for e in envs]
    assert types[0] == "run_started"
    assert types[-1] == "run_completed"

    metric_terms = {
        e.payload["term"]["id"]: e.payload["term"]
        for e in envs if e.type == "ontology_term_proposed" and e.payload["term"]["kind"] == "metric"
    }
    assert {"m_full_conf", "m_bad_sql"} <= metric_terms.keys()

    # a. every LLM metric term lands with confidence <= 0.85 (the cap)
    for term in metric_terms.values():
        assert term["confidence"] <= 0.85
    assert metric_terms["m_bad_sql"]["confidence"] <= 0.35  # + failed EXPLAIN drops it further

    # b. every LLM metric emits approval_required regardless of confidence
    approval_subjects = {e.payload["subject_id"] for e in envs if e.type == "approval_required"}
    assert "m_full_conf" in approval_subjects  # confidence 0.85, still gated
    assert "m_bad_sql" in approval_subjects

    # c. deterministic join terms only emit approval_required when confidence < 0.9
    join_terms = {
        e.payload["term"]["id"]: e.payload["term"]["confidence"]
        for e in envs if e.type == "ontology_term_proposed" and e.payload["term"]["kind"] == "join"
    }
    assert join_terms  # the seeded db's two FK joins were (re)proposed
    for jid, conf in join_terms.items():
        assert (jid in approval_subjects) == (conf < 0.9)

    # d. pre-existing approved baseline entries are untouched (merge-by-id no-clobber)
    reloaded = real_load(tmp_yaml)
    for mid, orig in baseline_metrics.items():
        assert next(m for m in reloaded["metrics"] if m["id"] == mid) == orig
    for jid, orig in baseline_joins.items():
        assert next(j for j in reloaded["joins"] if j["id"] == jid) == orig


def test_run_ontology_draft_llm_failure_emits_error_not_crash(monkeypatch, tmp_path):
    # A BAML failure surviving its own client-level retries (parse/validation
    # exhaustion, rate limit, etc.) must land in the flow's existing
    # try/except -> error + run_completed, exactly like any other exception.
    tmp_yaml = tmp_path / "ontology.yaml"
    tmp_yaml.write_text(agents.onto_mod.ONTOLOGY_PATH.read_text())
    real_load, real_save = agents.onto_mod.load_ontology, agents.onto_mod.save_ontology
    monkeypatch.setattr(agents.onto_mod, "load_ontology", lambda path=tmp_yaml: real_load(path))
    monkeypatch.setattr(agents.onto_mod, "save_ontology", lambda onto, path=tmp_yaml: real_save(onto, path))

    def fake_llm_draft_metrics(schema_and_samples, inferred_joins_json):
        raise ValueError("BAML: failed to parse into DraftMetricsResponse")

    monkeypatch.setattr(agents, "llm_draft_metrics", fake_llm_draft_metrics)

    bus = EventBus()
    envs: list = []
    bus.add_listener(lambda env: envs.append(env))

    async def go():
        bus.bind_loop(asyncio.get_running_loop())
        await agents.run_ontology_draft(bus, "run_draft_fail")

    asyncio.run(go())

    types = [e.type for e in envs]
    assert "error" in types
    assert types[-1] == "run_completed"
    assert not any(e.type == "ontology_term_proposed" and e.payload["term"]["kind"] == "metric" for e in envs)


# --- run_action (decoupled from run_ask) ------------------------------------

def test_run_action_emits_action_proposed_and_approval_required(monkeypatch):
    def fake_llm_draft_action(insight_text):
        return ActionDraftResponse(title="Investigate ticket spike", body="evidence numbers here")

    monkeypatch.setattr(agents, "llm_draft_action", fake_llm_draft_action)

    bus = EventBus()
    events: list = []
    bus.add_listener(lambda env: events.append(env))

    async def go():
        bus.bind_loop(asyncio.get_running_loop())
        await agents.run_action(bus, "run_act", "Ticket spike detected", "insight_run_123")

    asyncio.run(go())

    types = [e.type for e in events]
    assert "action_proposed" in types
    assert "approval_required" in types
    assert types.index("action_proposed") < types.index("approval_required")


# --- Live LLM smoke (excluded by default) -----------------------------------

@pytest.mark.llm
def test_llm_draft_action_live():
    out = agents.llm_draft_action("Insight: support tickets spiked 3x in the last 14 days.")
    assert out.title
    assert out.body
