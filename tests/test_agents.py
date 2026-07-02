"""Task 2 agent tests. LLM network calls are excluded from the default run
(marked @pytest.mark.llm); everything here mocks the completion function."""
import asyncio

import pytest

from backend.app import agents, seed
from backend.app.events import EventBus


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


def test_run_ask_event_sequence_mocked_llm(monkeypatch):
    # Canned planner output: a valid, guard-passing, EXPLAIN-able query against
    # an approved object term. Customers question -> no ticket insight.
    def fake_llm_json(system, user, max_tokens=None):
        return {
            "sql": "SELECT count(*) AS n FROM customers",
            "terms_used": ["obj_customer"],
            "reasoning_one_line": "count all customers",
        }

    monkeypatch.setattr(agents, "llm_json", fake_llm_json)

    types = _collect_run(lambda bus: agents.run_ask(bus, "run_test", "How many customers do we have?"))

    assert types[0] == "run_started"
    assert types[-1] == "run_completed"
    # core sequence present and ordered
    assert "node_touched" in types
    assert types.index("sql_generated") < types.index("sql_result")
    assert types.index("sql_result") < types.index("run_completed")
    # non-ticket question -> no insight/action fired
    assert "insight" not in types
    assert "action_proposed" not in types


def test_run_ask_ticket_question_fires_insight_and_action(monkeypatch):
    def fake_llm_json(system, user, max_tokens=None):
        if "Jira" in system:  # action drafter
            return {"title": "Investigate ticket spike", "body": "evidence numbers here"}
        return {
            "sql": "SELECT count(*) AS n FROM tickets",
            "terms_used": ["obj_ticket"],
            "reasoning_one_line": "count tickets",
        }

    monkeypatch.setattr(agents, "llm_json", fake_llm_json)

    types = _collect_run(
        lambda bus: agents.run_ask(bus, "run_tix", "What is happening with support tickets lately?")
    )

    assert "insight" in types
    assert "action_proposed" in types
    # insight precedes the action it produces, both precede run_completed
    assert types.index("insight") < types.index("action_proposed")
    assert types.index("action_proposed") < types.index("run_completed")


# --- Live LLM smoke (excluded by default) -----------------------------------

@pytest.mark.llm
def test_llm_json_live():
    out = agents.llm_json("Return JSON only.", 'Return {"ok": true}.')
    assert out.get("ok") is True
