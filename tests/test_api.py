import asyncio

import httpx
import pytest

from backend.app import main
from backend.app.ontology import ONTOLOGY_PATH, load_ontology


@pytest.fixture(autouse=True)
def _reset_state():
    main._actions.clear()
    main._pending.clear()
    main._insight_nodes.clear()
    main._action_nodes.clear()
    main._produces_edges.clear()
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


def test_replay_route_returns_immediately_and_streams_events():
    async def run():
        async with _client() as c:
            q = main.bus.subscribe()
            r = await c.post("/api/replay", json={"speed": 1000})
            await asyncio.sleep(0.1)  # let the fast background replay finish
            n = q.qsize()
            main.bus.unsubscribe(q)
            return r, n

    r, n = asyncio.run(run())
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert n == 40
