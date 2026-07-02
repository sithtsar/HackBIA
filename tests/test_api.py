import asyncio

import httpx
import pytest

from backend.app import main
from backend.app.ontology import ONTOLOGY_PATH, load_ontology, save_ontology


@pytest.fixture(autouse=True)
def _reset_state():
    main._actions.clear()
    main._pending.clear()
    main._insight_nodes.clear()
    main._action_nodes.clear()
    main._produces_edges.clear()
    main._term_nodes.clear()
    main._term_edges.clear()
    yield


def _client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")


def test_get_state_returns_graph_terms_actions_pending():
    async def run():
        async with _client() as c:
            return await c.get("/api/state")

    r = asyncio.run(run())
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == {"graph", "terms", "actions", "pending"}
    assert len(body["graph"]["nodes"]) == 7  # baseline: 3 sources + 3 objects + 1 metric
    assert len(body["terms"]) == 6  # 3 objects + 2 joins + 1 metric
    assert body["actions"] == []
    assert body["pending"] == []


def test_draft_and_ask_return_run_id(monkeypatch):
    # Stub the agent entrypoints so the route wiring is tested without any
    # LLM/network call (the background tasks are scheduled but no-op).
    async def _noop(*a, **k):
        return None

    monkeypatch.setattr(main.agents, "run_ontology_draft", _noop)
    monkeypatch.setattr(main.agents, "run_ask", _noop)

    async def run():
        async with _client() as c:
            r1 = await c.post("/api/ontology/draft", json={})
            r2 = await c.post("/api/ask", json={"question": "why?"})
            return r1, r2

    r1, r2 = asyncio.run(run())
    assert r1.status_code == 200
    assert r1.json()["run_id"].startswith("run_")
    assert r2.status_code == 200
    assert r2.json()["run_id"].startswith("run_")


def test_approvals_mutate_yaml_and_emit_event():
    original = ONTOLOGY_PATH.read_text()
    try:
        async def run():
            async with _client() as c:
                q = main.bus.subscribe()
                r = await c.post("/api/approvals/m_active_customer", json={"decision": "rejected"})
                env = await asyncio.wait_for(q.get(), timeout=1)
                main.bus.unsubscribe(q)
                return r, env

        r, env = asyncio.run(run())
        assert r.status_code == 200
        assert r.json() == {"ok": True}
        assert env.type == "approval_resolved"
        assert env.payload == {
            "subject_kind": "ontology_term",
            "subject_id": "m_active_customer",
            "decision": "rejected",
        }
        onto = load_ontology()
        metric = next(m for m in onto["metrics"] if m["id"] == "m_active_customer")
        assert metric["status"] == "rejected"
    finally:
        ONTOLOGY_PATH.write_text(original)


def test_approvals_on_unknown_ontology_term_still_emits_event_no_crash():
    async def run():
        async with _client() as c:
            return await c.post("/api/approvals/m_not_a_real_term", json={"decision": "approved"})

    r = asyncio.run(run())
    assert r.status_code == 200


def test_approvals_on_action_updates_registry_and_clears_pending():
    async def run():
        async with _client() as c:
            main.bus.publish("action_proposed", {"action": {
                "id": "act_test01", "kind": "jira", "title": "t", "body": "b",
                "insight_ref": "insight_x", "status": "proposed",
            }})
            main.bus.publish("approval_required", {"subject_kind": "action", "subject_id": "act_test01"})
            assert "act_test01" in main._pending
            q = main.bus.subscribe()
            r = await c.post("/api/approvals/act_test01", json={"decision": "approved"})
            # Task 3: approval triggers a background push (mock mode here) —
            # wait for approval_resolved + action_pushed before asserting.
            for _ in range(2):
                await asyncio.wait_for(q.get(), timeout=2)
            main.bus.unsubscribe(q)
            return r

    r = asyncio.run(run())
    assert r.status_code == 200
    assert main._actions["act_test01"]["status"] == "pushed"
    assert "act_test01" not in main._pending


def test_insight_event_creates_produces_edges_from_evidence_to_insight():
    async def run():
        async with _client() as c:
            payload = {
                "text": "spike", "severity": "critical",
                "node_ids": ["obj_ticket", "obj_customer", "no_such_node"],
            }
            main.bus.publish("insight", payload, "run_test01")
            main.bus.publish("insight", payload, "run_test01")  # replay/live can re-emit the same insight
            return await c.get("/api/state")

    r = asyncio.run(run())
    assert r.status_code == 200
    edges = r.json()["graph"]["edges"]
    produces = [e for e in edges if e["kind"] == "produces"]
    assert {
        "id": "e_obj_ticket_insight_run_test01", "source": "obj_ticket",
        "target": "insight_run_test01", "kind": "produces",
    } in produces
    assert {
        "id": "e_obj_customer_insight_run_test01", "source": "obj_customer",
        "target": "insight_run_test01", "kind": "produces",
    } in produces
    assert not any(e["source"] == "no_such_node" for e in edges)  # skip ids with no matching node
    assert len(produces) == 2  # duplicate insight event doesn't duplicate edges


def test_replay_route_returns_immediately_and_streams_events():
    # reset=False: this test isn't isolated from real backend/data (unlike
    # test_demo_ops.py's _isolate fixture), so it opts out of the reset path
    # to avoid reseeding/duckdb-locking the real data dir on every test run.
    # See test_demo_ops.py for reset=True (default) coverage, isolated.
    async def run():
        async with _client() as c:
            q = main.bus.subscribe()
            r = await c.post("/api/replay", json={"speed": 1000, "reset": False})
            await asyncio.sleep(0.1)  # let the fast background replay finish
            n = q.qsize()
            main.bus.unsubscribe(q)
            return r, n

    r, n = asyncio.run(run())
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert n == 40


# --- ontology_term_proposed -> immediate graph edges (docs/contracts.md) ---

def test_proposed_metric_term_emits_node_and_derives_edges():
    async def run():
        async with _client() as c:
            term = {
                "id": "m_test_metric", "kind": "metric", "name": "Test Metric",
                "definition": "d", "sql": "SELECT 1", "source_tables": ["orders"],
                "confidence": 0.7, "status": "proposed",
            }
            main.bus.publish("ontology_term_proposed", {"term": term}, "run_x")
            main.bus.publish("ontology_term_proposed", {"term": term}, "run_x")  # replay/live re-emit safe
            return await c.get("/api/state")

    r = asyncio.run(run())
    assert r.status_code == 200
    body = r.json()
    metric_nodes = [n for n in body["graph"]["nodes"] if n["id"] == "m_test_metric"]
    assert metric_nodes == [{
        "id": "m_test_metric", "kind": "metric", "label": "Test Metric",
        "status": "proposed", "meta": {"confidence": "0.7"},
    }]
    derives = [e for e in body["graph"]["edges"] if e["kind"] == "derives" and e["source"] == "m_test_metric"]
    assert derives == [{
        "id": "e_derives_m_test_metric_orders", "source": "m_test_metric", "target": "obj_order", "kind": "derives",
    }]


def test_proposed_join_term_emits_edge_only_no_node():
    async def run():
        async with _client() as c:
            term = {
                "id": "join_test_orders_customers", "kind": "join", "name": "Orders → Customers",
                "definition": "d", "sql": "orders.x = customers.y", "source_tables": ["orders", "customers"],
                "confidence": 0.5, "status": "proposed",
            }
            main.bus.publish("ontology_term_proposed", {"term": term}, "run_x")
            return await c.get("/api/state")

    r = asyncio.run(run())
    body = r.json()
    assert not any(n["id"] == "join_test_orders_customers" for n in body["graph"]["nodes"])
    join_edges = [e for e in body["graph"]["edges"] if e["id"] == "join_test_orders_customers"]
    assert join_edges == [{
        "id": "join_test_orders_customers", "source": "obj_order", "target": "obj_customer", "kind": "join",
    }]


def test_proposed_metric_node_dedupes_once_persisted_and_approved():
    # Simulates the draft flow's _persist() (or approval + yaml rebuild)
    # landing the same term in ontology.yaml after ontology_term_proposed
    # already fired — build_graph's onto-derived node must win, no duplicate.
    original = ONTOLOGY_PATH.read_text()
    try:
        async def run():
            async with _client() as c:
                term = {
                    "id": "m_dedupe_test", "kind": "metric", "name": "Dedupe Test",
                    "definition": "d", "sql": "SELECT 1", "source_tables": ["orders"],
                    "confidence": 0.7, "status": "proposed",
                }
                main.bus.publish("ontology_term_proposed", {"term": term}, "run_x")

                onto = load_ontology()
                onto.setdefault("metrics", []).append({
                    "id": "m_dedupe_test", "name": "Dedupe Test", "definition": "d", "sql": "SELECT 1",
                    "source_tables": ["orders"], "confidence": 0.7, "status": "approved",
                })
                save_ontology(onto)
                return await c.get("/api/state")

        r = asyncio.run(run())
        body = r.json()
        assert sum(1 for n in body["graph"]["nodes"] if n["id"] == "m_dedupe_test") == 1
        derives = [e for e in body["graph"]["edges"] if e["kind"] == "derives" and e["source"] == "m_dedupe_test"]
        assert len(derives) == 1
        # the onto-derived node reflects the yaml (now approved), not the stale event copy
        node = next(n for n in body["graph"]["nodes"] if n["id"] == "m_dedupe_test")
        assert node["status"] == "approved"
    finally:
        ONTOLOGY_PATH.write_text(original)


# --- POST /api/ontology/join --------------------------------------------

def test_ontology_join_happy_path_creates_proposed_join():
    original = ONTOLOGY_PATH.read_text()
    try:
        onto = load_ontology()
        onto["joins"] = [j for j in onto["joins"] if j["id"] != "join_orders_customers"]
        save_ontology(onto)

        async def run():
            async with _client() as c:
                q = main.bus.subscribe()
                r = await c.post("/api/ontology/join", json={"from_object": "obj_order", "to_object": "obj_customer"})
                envs = [await asyncio.wait_for(q.get(), timeout=2) for _ in range(2)]
                main.bus.unsubscribe(q)
                return r, envs

        r, envs = asyncio.run(run())
        assert r.status_code == 200
        term_id = r.json()["term_id"]
        assert term_id == "join_orders_customers"

        assert envs[0].type == "ontology_term_proposed"
        assert envs[0].payload["term"]["id"] == term_id
        assert envs[0].payload["term"]["status"] == "proposed"
        assert envs[1].type == "approval_required"
        assert envs[1].payload["subject_id"] == term_id

        reloaded = load_ontology()
        created = next(j for j in reloaded["joins"] if j["id"] == term_id)
        assert created["status"] == "proposed"
    finally:
        ONTOLOGY_PATH.write_text(original)


def test_ontology_join_unknown_object_400():
    async def run():
        async with _client() as c:
            return await c.post("/api/ontology/join", json={"from_object": "obj_nope", "to_object": "obj_customer"})

    r = asyncio.run(run())
    assert r.status_code == 400


def test_ontology_join_same_object_400():
    async def run():
        async with _client() as c:
            return await c.post("/api/ontology/join", json={"from_object": "obj_order", "to_object": "obj_order"})

    r = asyncio.run(run())
    assert r.status_code == 400


def test_ontology_join_no_inferable_key_400():
    # obj_order <-> obj_ticket: orders and tickets share no FK in the seeded schema.
    async def run():
        async with _client() as c:
            return await c.post("/api/ontology/join", json={"from_object": "obj_order", "to_object": "obj_ticket"})

    r = asyncio.run(run())
    assert r.status_code == 400
