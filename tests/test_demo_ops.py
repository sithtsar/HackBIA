import asyncio
from pathlib import Path

import httpx
import pytest
import yaml

from backend.app import main
from backend.app import ontology as onto_mod
from backend.app import seed as seed_mod

_ORIGINAL_ONTOLOGY_YAML = onto_mod.ONTOLOGY_PATH.read_text()


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """Redirect seed's data dir, ontology.yaml/baseline, and the event log
    to tmp_path so /api/demo/reset never touches real backend/data (a live
    dev server may have those files open). seed.main() and ontology.py read
    these module globals fresh at call time (not baked into defaults), so
    monkeypatching here is enough to isolate the whole route — same trick
    test_ingest.py uses for ingest.DB_PATH/UPLOADS_DIR."""
    onto_path = tmp_path / "ontology.yaml"
    onto_path.write_text(_ORIGINAL_ONTOLOGY_YAML)
    baseline_path = tmp_path / "ontology.baseline.yaml"
    baseline_path.write_text(_ORIGINAL_ONTOLOGY_YAML)
    events_path = tmp_path / "events.jsonl"
    events_path.write_text('{"id": "evt_stale"}\n')

    monkeypatch.setattr(onto_mod, "ONTOLOGY_PATH", onto_path)
    monkeypatch.setattr(onto_mod, "ONTOLOGY_BASELINE_PATH", baseline_path)
    monkeypatch.setattr(seed_mod, "DATA_DIR", tmp_path)
    monkeypatch.setattr(seed_mod, "DB_PATH", tmp_path / "foundry.duckdb")
    monkeypatch.setattr(main.bus, "_jsonl_path", events_path)

    main._actions.clear()
    main._pending.clear()
    main._insight_nodes.clear()
    main._action_nodes.clear()
    main._produces_edges.clear()
    main._term_nodes.clear()
    main._term_edges.clear()
    main._workflows.clear()
    main._active_workflow_id = None

    yield onto_path, baseline_path, events_path


def _client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")


async def _settle(predicate, timeout=5.0):
    """Wait for a background replay to reach a state instead of guessing at it
    with a fixed sleep. The replay runs as a task, so a hardcoded delay is a
    race: it passed locally until a cold DuckDB seed pushed the run past the
    deadline and the assertion saw 1 of 43 events."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.01)
    return predicate()


def test_reset_rebuilds_seed_restores_baseline_clears_state_emits_event(_isolate):
    onto_path, baseline_path, events_path = _isolate

    # Dirty everything reset is supposed to clean up.
    dirty_onto = onto_mod.load_ontology(onto_path)
    dirty_onto["sources"].append({"table": "products"})
    onto_mod.save_ontology(dirty_onto, onto_path)
    main._actions["act_x"] = {"id": "act_x", "status": "proposed"}
    main._pending["act_x"] = {"subject_kind": "action", "subject_id": "act_x"}
    main._insight_nodes["insight_x"] = {"id": "insight_x"}
    main._action_nodes["act_x"] = {"id": "act_x"}
    main._produces_edges["e_x"] = {"id": "e_x"}
    main._term_nodes["m_x"] = {"id": "m_x"}
    main._term_edges["e_derives_m_x_orders"] = {"id": "e_derives_m_x_orders"}

    async def run():
        async with _client() as c:
            q = main.bus.subscribe()
            r = await c.post("/api/demo/reset")
            env = await asyncio.wait_for(q.get(), timeout=5)
            main.bus.unsubscribe(q)
            return r, env

    r, env = asyncio.run(run())

    assert r.status_code == 200
    assert r.json() == {"ok": True}

    # ontology.yaml restored to an exact byte copy of the baseline.
    assert onto_path.read_text() == baseline_path.read_text()

    # in-memory registries cleared.
    assert main._actions == {}
    assert main._pending == {}
    assert main._insight_nodes == {}
    assert main._action_nodes == {}
    assert main._produces_edges == {}
    assert main._term_nodes == {}
    assert main._term_edges == {}

    # exactly one status event on the bus, and it's the reset marker.
    assert env.type == "status"
    assert env.payload == {"message": "demo reset [retail]: Retail support operations"}

    # events.jsonl was truncated then got only the reset's own status line.
    lines = events_path.read_text().strip().splitlines()
    assert len(lines) == 1

    # seed actually reran against the isolated data dir.
    assert (Path(seed_mod.DATA_DIR) / "customers.csv").exists()
    assert seed_mod.DB_PATH.exists()


def test_replay_resets_state_before_reemitting(_isolate):
    onto_path, baseline_path, events_path = _isolate

    # Dirty everything a live session (or a previous replay) could have left
    # behind, exactly like the demo/reset test does.
    dirty_onto = onto_mod.load_ontology(onto_path)
    dirty_onto["sources"].append({"table": "products"})
    onto_mod.save_ontology(dirty_onto, onto_path)
    main._actions["act_x"] = {"id": "act_x", "status": "proposed"}
    main._pending["act_x"] = {"subject_kind": "action", "subject_id": "act_x"}
    main._term_nodes["m_stale"] = {"id": "m_stale"}
    main._term_edges["e_derives_m_stale_orders"] = {"id": "e_derives_m_stale_orders"}

    async def run():
        async with _client() as c:
            q = main.bus.subscribe()
            # reset defaults to true — no body override needed.
            r = await c.post("/api/replay", json={"speed": 1000})
            await _settle(lambda: q.qsize() >= 43)
            n = q.qsize()
            main.bus.unsubscribe(q)
            return r, n

    r, n = asyncio.run(run())

    assert r.status_code == 200
    assert n == 43  # every demo_events.jsonl line re-emitted after the reset

    # ontology.yaml was restored to baseline BEFORE replay (no stray "products"
    # source stacked on top, no id collisions from a prior run).
    onto = onto_mod.load_ontology(onto_path)
    assert [s["table"] for s in onto["sources"]] == ["customers", "orders", "tickets"]

    # stale pre-replay demo state is gone; only what replay itself produced remains
    # (the demo narrative's own action + proposed terms).
    assert "act_x" not in main._actions
    assert "act_x" not in main._pending
    assert "m_stale" not in main._term_nodes
    assert "e_derives_m_stale_orders" not in main._term_edges
    assert len(main._actions) == 1
    assert set(main._term_nodes) == {"obj_customer", "obj_order", "obj_ticket", "m_active_customer"}


def test_replay_activates_workflow_so_ask_joins_it(_isolate, monkeypatch):
    """Replay reaches workflows only through the event listener, never through
    _create_workflow. If the listener leaves _active_workflow_id unset, the
    first question after a replay forks a second workflow and the demo's
    lineage splits in two — the no-API-key path breaks exactly where it is
    meant to shine."""
    monkeypatch.setattr(main.agents, "run_ask", lambda *a, **kw: asyncio.sleep(0))

    async def run():
        async with _client() as c:
            await c.post("/api/replay", json={"speed": 1000})
            await _settle(lambda: main._active_workflow_id is not None)
            active_after_replay = main._active_workflow_id
            await c.post("/api/ask", json={"question": "why did tickets spike?"})
            return active_after_replay

    active_after_replay = asyncio.run(run())

    assert active_after_replay == "wf_demo001"
    # the ask joined the replayed workflow instead of forking a new one
    assert list(main._workflows) == ["wf_demo001"]
    assert len(main._workflows["wf_demo001"]["run_ids"]) == 1


def test_ontology_export_returns_yaml_file(_isolate):
    async def run():
        async with _client() as c:
            return await c.get("/api/ontology/export")

    r = asyncio.run(run())

    assert r.status_code == 200
    assert "yaml" in r.headers["content-type"]
    assert "ontology.yaml" in r.headers.get("content-disposition", "")

    body = yaml.safe_load(r.content)
    assert "sources" in body
    assert "objects" in body
