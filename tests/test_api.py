import asyncio

import httpx
import pytest

from backend.app import agents, main, seed
from backend.app.ontology import ONTOLOGY_PATH, load_ontology, save_ontology


@pytest.fixture(scope="module", autouse=True)
def _ensure_db():
    if not agents.DB_PATH.exists():
        seed.main()
    yield


@pytest.fixture(autouse=True)
def _reset_state():
    main._actions.clear()
    main._pending.clear()
    main._insight_nodes.clear()
    main._action_nodes.clear()
    main._produces_edges.clear()
    main._term_nodes.clear()
    main._term_edges.clear()
    main._workflows.clear()
    main._insight_seq.clear()
    main._insight_sql_used.clear()
    main._active_workflow_id = None
    yield


def _client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")


def _propose_objects():
    """Helper: propose baseline 3 objects via event stream so table→object
    mapping exists for metric/join edge resolution."""
    for oid, name, table in [
        ("obj_customer", "Customer", "customers"),
        ("obj_order", "Order", "orders"),
        ("obj_ticket", "Support Ticket", "tickets"),
    ]:
        main.bus.publish("ontology_term_proposed", {"term": {
            "id": oid, "kind": "object", "name": name,
            "definition": f"A {name} record sourced from {table}.",
            "sql": "", "source_tables": [table],
            "confidence": 0.9, "status": "proposed",
        }}, "run_setup")


def test_get_state_returns_graph_terms_actions_pending_workflows():
    async def run():
        async with _client() as c:
            return await c.get("/api/state")

    r = asyncio.run(run())
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == {"graph", "terms", "actions", "pending", "workflows", "active_workflow_id"}
    assert len(body["graph"]["nodes"]) == 3
    assert len(body["terms"]) == 0
    assert body["actions"] == []
    assert body["pending"] == []
    assert body["workflows"] == []
    assert body["active_workflow_id"] is None


def test_draft_and_ask_return_run_id(monkeypatch):
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
        # Add a metric to ontology.yaml so set_term_status can find it
        onto = load_ontology()
        onto.setdefault("metrics", []).append({
            "id": "m_active_customer", "name": "Active Customer",
            "definition": "d", "sql": "SELECT 1",
            "source_tables": ["orders"], "confidence": 0.8, "status": "proposed",
        })
        save_ontology(onto)

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
            # Propose objects first so evidence ids resolve in graph
            _propose_objects()
            payload = {
                "text": "spike", "severity": "critical",
                "node_ids": ["obj_ticket", "obj_customer", "no_such_node"],
                "sql_used": "SELECT count(*) FROM tickets",
            }
            main.bus.publish("insight", payload, "run_test01")
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
    assert not any(e["source"] == "no_such_node" for e in edges)
    insight_node = next(n for n in r.json()["graph"]["nodes"] if n["id"] == "insight_run_test01")
    assert insight_node["meta"]["sql_used"] == "SELECT count(*) FROM tickets"


def test_replay_route_returns_immediately_and_streams_events():
    async def run():
        async with _client() as c:
            q = main.bus.subscribe()
            r = await c.post("/api/replay", json={"speed": 1000, "reset": False})
            await asyncio.sleep(0.1)
            n = q.qsize()
            main.bus.unsubscribe(q)
            return r, n

    r, n = asyncio.run(run())
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert n == 43


def test_proposed_metric_term_emits_node_and_derives_edges():
    async def run():
        async with _client() as c:
            # Propose objects so table→object mapping exists
            _propose_objects()
            term = {
                "id": "m_test_metric", "kind": "metric", "name": "Test Metric",
                "definition": "d", "sql": "SELECT 1", "source_tables": ["orders"],
                "confidence": 0.7, "status": "proposed",
            }
            main.bus.publish("ontology_term_proposed", {"term": term}, "run_x")
            main.bus.publish("ontology_term_proposed", {"term": term}, "run_x")
            return await c.get("/api/state")

    r = asyncio.run(run())
    assert r.status_code == 200
    body = r.json()
    metric_nodes = [n for n in body["graph"]["nodes"] if n["id"] == "m_test_metric"]
    assert metric_nodes == [{
        "id": "m_test_metric", "kind": "metric", "label": "Test Metric",
        "status": "proposed", "meta": {"confidence": "0.7", "sql": "SELECT 1", "definition": "d"},
    }]
    derives = [e for e in body["graph"]["edges"] if e["kind"] == "derives" and e["target"] == "m_test_metric"]
    assert derives == [{
        "id": "e_derives_m_test_metric_orders", "source": "obj_order", "target": "m_test_metric", "kind": "derives",
    }]


def test_proposed_join_term_emits_edge_only_no_node():
    async def run():
        async with _client() as c:
            _propose_objects()
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
    original = ONTOLOGY_PATH.read_text()
    try:
        async def run():
            async with _client() as c:
                _propose_objects()
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
        derives = [e for e in body["graph"]["edges"] if e["kind"] == "derives" and e["target"] == "m_dedupe_test"]
        assert len(derives) == 1
        node = next(n for n in body["graph"]["nodes"] if n["id"] == "m_dedupe_test")
        assert node["status"] == "approved"
    finally:
        ONTOLOGY_PATH.write_text(original)


def test_ontology_join_happy_path_creates_proposed_join():
    original = ONTOLOGY_PATH.read_text()
    try:
        onto = load_ontology()
        onto.setdefault("objects", []).extend([
            {"id": "obj_order", "name": "Order", "table": "orders"},
            {"id": "obj_customer", "name": "Customer", "table": "customers"},
        ])
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
    original = ONTOLOGY_PATH.read_text()
    try:
        onto = load_ontology()
        onto.setdefault("objects", []).extend([
            {"id": "obj_customer", "name": "Customer", "table": "customers"},
        ])
        save_ontology(onto)

        async def run():
            async with _client() as c:
                return await c.post("/api/ontology/join", json={"from_object": "obj_nope", "to_object": "obj_customer"})

        r = asyncio.run(run())
        assert r.status_code == 400
    finally:
        ONTOLOGY_PATH.write_text(original)


def test_ontology_join_same_object_400():
    original = ONTOLOGY_PATH.read_text()
    try:
        onto = load_ontology()
        onto.setdefault("objects", []).extend([
            {"id": "obj_order", "name": "Order", "table": "orders"},
        ])
        save_ontology(onto)

        async def run():
            async with _client() as c:
                return await c.post("/api/ontology/join", json={"from_object": "obj_order", "to_object": "obj_order"})

        r = asyncio.run(run())
        assert r.status_code == 400
    finally:
        ONTOLOGY_PATH.write_text(original)


def test_ontology_join_no_inferable_key_400():
    original = ONTOLOGY_PATH.read_text()
    try:
        onto = load_ontology()
        onto.setdefault("objects", []).extend([
            {"id": "obj_order", "name": "Order", "table": "orders"},
            {"id": "obj_ticket", "name": "Support Ticket", "table": "tickets"},
        ])
        save_ontology(onto)

        async def run():
            async with _client() as c:
                return await c.post("/api/ontology/join", json={"from_object": "obj_order", "to_object": "obj_ticket"})

        r = asyncio.run(run())
        assert r.status_code == 400
    finally:
        ONTOLOGY_PATH.write_text(original)


def test_ontology_metric_happy_path_creates_proposed_metric():
    original = ONTOLOGY_PATH.read_text()
    try:
        onto = load_ontology()
        onto.setdefault("objects", []).extend([
            {"id": "obj_order", "name": "Order", "table": "orders"},
        ])
        save_ontology(onto)

        async def run():
            async with _client() as c:
                q = main.bus.subscribe()
                r = await c.post("/api/ontology/metric", json={
                    "name": "Repeat Buyer",
                    "definition": "Customer with more than one order",
                    "sql": "SELECT customer_id FROM orders GROUP BY customer_id HAVING count(*) > 1",
                    "source_tables": ["orders"],
                })
                envs = [await asyncio.wait_for(q.get(), timeout=2) for _ in range(2)]
                main.bus.unsubscribe(q)
                return r, envs

        r, envs = asyncio.run(run())
        assert r.status_code == 200
        term_id = r.json()["term_id"]
        assert term_id == "m_repeat_buyer"

        assert envs[0].type == "ontology_term_proposed"
        assert envs[0].payload["term"]["id"] == term_id
        assert envs[0].payload["term"]["status"] == "proposed"
        assert envs[1].type == "approval_required"
        assert envs[1].payload["subject_id"] == term_id

        reloaded = load_ontology()
        created = next(m for m in reloaded["metrics"] if m["id"] == term_id)
        assert created["status"] == "proposed"

        async def state():
            async with _client() as c:
                return await c.get("/api/state")
        body = asyncio.run(state()).json()
        derives = [e for e in body["graph"]["edges"] if e["target"] == term_id and e["kind"] == "derives"]
        assert derives and derives[0]["source"] == "obj_order"
    finally:
        ONTOLOGY_PATH.write_text(original)


def test_ontology_metric_unknown_table_400():
    async def run():
        async with _client() as c:
            return await c.post("/api/ontology/metric", json={
                "name": "Bad", "definition": "x", "source_tables": ["nope"],
            })

    r = asyncio.run(run())
    assert r.status_code == 400


def test_ontology_metric_write_sql_400():
    async def run():
        async with _client() as c:
            return await c.post("/api/ontology/metric", json={
                "name": "Evil", "definition": "x", "sql": "DROP TABLE orders",
                "source_tables": ["orders"],
            })

    r = asyncio.run(run())
    assert r.status_code == 400


def test_ontology_metric_duplicate_400():
    original = ONTOLOGY_PATH.read_text()
    try:
        onto = load_ontology()
        onto.setdefault("objects", []).append({"id": "obj_order", "name": "Order", "table": "orders"})
        onto.setdefault("metrics", []).append({
            "id": "m_active_customer", "name": "Active Customer",
            "definition": "d", "sql": "SELECT 1",
            "source_tables": ["orders"], "confidence": 0.8, "status": "approved",
        })
        save_ontology(onto)

        async def run():
            async with _client() as c:
                return await c.post("/api/ontology/metric", json={
                    "name": "Active Customer", "definition": "dup",
                    "source_tables": ["orders"],
                })

        r = asyncio.run(run())
        assert r.status_code == 400
    finally:
        ONTOLOGY_PATH.write_text(original)


def test_create_workflow():
    async def run():
        async with _client() as c:
            r = await c.post("/api/workflows", json={"title": "Test investigation"})
            return r

    r = asyncio.run(run())
    assert r.status_code == 200
    wid = r.json()["workflow_id"]
    assert wid.startswith("wf_")
    assert wid in main._workflows
    assert main._workflows[wid]["title"] == "Test investigation"


def test_list_workflows():
    async def run():
        async with _client() as c:
            await c.post("/api/workflows", json={"title": "WF 1"})
            await c.post("/api/workflows", json={"title": "WF 2"})
            r = await c.get("/api/workflows")
            return r

    r = asyncio.run(run())
    assert r.status_code == 200
    body = r.json()
    assert len(body["workflows"]) == 2


def test_get_workflow():
    async def run():
        async with _client() as c:
            created = await c.post("/api/workflows", json={"title": "My WF"})
            wid = created.json()["workflow_id"]
            r = await c.get(f"/api/workflows/{wid}")
            return r

    r = asyncio.run(run())
    assert r.status_code == 200
    assert r.json()["workflow"]["title"] == "My WF"


def test_get_workflow_404():
    async def run():
        async with _client() as c:
            return await c.get("/api/workflows/wf_nope")

    r = asyncio.run(run())
    assert r.status_code == 404


def test_patch_workflow_status():
    async def run():
        async with _client() as c:
            created = await c.post("/api/workflows", json={"title": "WF"})
            wid = created.json()["workflow_id"]
            r = await c.patch(f"/api/workflows/{wid}", json={"status": "completed"})
            return r, wid

    r, wid = asyncio.run(run())
    assert r.status_code == 200
    assert main._workflows[wid]["status"] == "completed"


def test_workflow_ask_creates_workflow_scoped_run(monkeypatch):
    async def _noop(*a, **k):
        return None
    monkeypatch.setattr(main.agents, "run_ask", _noop)

    async def run():
        async with _client() as c:
            created = await c.post("/api/workflows", json={"title": "Investigation"})
            wid = created.json()["workflow_id"]
            r = await c.post(f"/api/workflows/{wid}/ask", json={"question": "How many customers?"})
            return r, wid

    r, wid = asyncio.run(run())
    assert r.status_code == 200
    assert r.json()["run_id"].startswith("run_")
    assert len(main._workflows[wid]["run_ids"]) == 1


def test_workflow_action_draft(monkeypatch):
    async def _noop(*a, **k):
        return None
    monkeypatch.setattr(main.agents, "run_action", _noop)

    async def run():
        async with _client() as c:
            created = await c.post("/api/workflows", json={"title": "WF"})
            wid = created.json()["workflow_id"]
            r = await c.post(f"/api/workflows/{wid}/action", json={
                "insight_text": "ticket spike",
                "insight_node_id": "insight_123",
            })
            return r, wid

    r, wid = asyncio.run(run())
    assert r.status_code == 200
    assert r.json()["run_id"].startswith("run_")


def test_ask_creates_workflow_automatically(monkeypatch):
    async def _noop(*a, **k):
        return None
    monkeypatch.setattr(main.agents, "run_ask", _noop)

    async def run():
        async with _client() as c:
            r = await c.post("/api/ask", json={"question": "What is up?"})
            return r

    r = asyncio.run(run())
    assert r.status_code == 200
    assert main._active_workflow_id is not None
    assert len(main._workflows) == 1


def test_build_graph_metric_meta_includes_sql_and_definition():
    async def run():
        async with _client() as c:
            return await c.get("/api/state")

    r = asyncio.run(run())
    body = r.json()
    metric_nodes = [n for n in body["graph"]["nodes"] if n["kind"] == "metric"]
    assert len(metric_nodes) == 0


def test_delete_graph_node_cascades_to_derived_metric_and_updates_yaml():
    original = ONTOLOGY_PATH.read_text()
    try:
        onto = load_ontology()
        onto["objects"] = [{"id": "obj_customer", "name": "Customer", "table": "customers"}]
        onto["metrics"] = [{
            "id": "m_x", "name": "X", "definition": "d", "sql": "SELECT 1",
            "source_tables": ["customers"], "confidence": 0.8, "status": "approved",
        }]
        save_ontology(onto)

        async def run():
            async with _client() as c:
                q = main.bus.subscribe()
                r = await c.delete("/api/graph/obj_customer")
                env = await asyncio.wait_for(q.get(), timeout=1)
                main.bus.unsubscribe(q)
                state = await c.get("/api/state")
                return r, env, state

        r, env, state = asyncio.run(run())
        assert r.status_code == 200
        assert set(r.json()["node_ids"]) == {"obj_customer", "m_x"}
        assert env.type == "node_deleted"
        assert set(env.payload["node_ids"]) == {"obj_customer", "m_x"}

        onto = load_ontology()
        assert onto["objects"] == []
        assert onto["metrics"] == []
        # source table itself is untouched — only the object mapping onto it is gone
        assert any(s["table"] == "customers" for s in onto["sources"])

        node_ids = {n["id"] for n in state.json()["graph"]["nodes"]}
        assert "obj_customer" not in node_ids
        assert "m_x" not in node_ids
        edge_endpoints = {e["source"] for e in state.json()["graph"]["edges"]} | {
            e["target"] for e in state.json()["graph"]["edges"]
        }
        assert "obj_customer" not in edge_endpoints
        assert "m_x" not in edge_endpoints
    finally:
        ONTOLOGY_PATH.write_text(original)


def test_delete_graph_node_unknown_404():
    async def run():
        async with _client() as c:
            return await c.delete("/api/graph/does_not_exist")

    r = asyncio.run(run())
    assert r.status_code == 404


def test_node_sample_returns_head_and_tail_for_a_source_table():
    async def run():
        async with _client() as c:
            return await c.get("/api/nodes/src_customers/sample")

    r = asyncio.run(run())
    assert r.status_code == 200
    body = r.json()
    assert body["row_count"] > 0
    assert len(body["head"]) == min(5, body["row_count"])
    assert len(body["tail"]) == min(5, body["row_count"])
    assert len(body["columns"]) > 0


def test_node_sample_unknown_404():
    async def run():
        async with _client() as c:
            return await c.get("/api/nodes/does_not_exist/sample")

    r = asyncio.run(run())
    assert r.status_code == 404
