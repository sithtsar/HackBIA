"""FastAPI app + routes per docs/contracts.md.

Runtime state beyond ontology.yaml (actions registry, pending approvals,
insight/action graph nodes) is derived purely from the event stream via an
EventBus listener — same event source the SSE clients see, so state stays
consistent with "UI is a pure function of (initial graph, event stream)".
It is in-memory only and reset on restart (contracts: no persistence beyond
files; ontology.yaml + events.jsonl are the durable state).
"""
from __future__ import annotations

import asyncio
import shutil
import uuid
from contextlib import asynccontextmanager
from typing import Any, Literal

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from . import agents
from . import ingest as ingest_mod
from . import ontology as onto_mod
from . import seed as seed_mod
from .actions import ActionPushError, push_action
from .events import DEMO_EVENTS_FILE, ActionProposal, Envelope, EventBus, replay as replay_events

load_dotenv()

bus = EventBus()

_actions: dict[str, dict[str, Any]] = {}
_pending: dict[str, dict[str, str]] = {}
_insight_nodes: dict[str, dict[str, Any]] = {}
_action_nodes: dict[str, dict[str, Any]] = {}
_produces_edges: dict[str, dict[str, Any]] = {}


def _on_event(env: Envelope) -> None:
    if env.type == "insight":
        # ponytail: node id keyed by run_id (stable across replay, which
        # reassigns fresh envelope ids) — assumes <=1 insight per run, true
        # for this hackathon's agents; revisit if a run can emit several.
        node_id = f"insight_{env.run_id or env.id}"
        _insight_nodes[node_id] = {
            "id": node_id, "kind": "insight", "label": env.payload["text"],
            "status": "neutral", "meta": {"severity": env.payload["severity"]},
        }
    elif env.type == "action_proposed":
        a = env.payload["action"]
        _actions[a["id"]] = a
        _action_nodes[a["id"]] = {
            "id": a["id"], "kind": "action", "label": a["title"],
            "status": "proposed", "meta": {"kind": a["kind"]},
        }
        edge_id = f"e_produces_{a['id']}"
        _produces_edges[edge_id] = {"id": edge_id, "source": a["insight_ref"], "target": a["id"], "kind": "produces"}
    elif env.type == "approval_required":
        sid = env.payload["subject_id"]
        _pending[sid] = {"subject_kind": env.payload["subject_kind"], "subject_id": sid}
    elif env.type == "approval_resolved":
        sid = env.payload["subject_id"]
        _pending.pop(sid, None)
        if env.payload["subject_kind"] == "action" and sid in _actions:
            _actions[sid]["status"] = env.payload["decision"]
            _action_nodes[sid]["status"] = env.payload["decision"]
    elif env.type == "action_pushed":
        aid = env.payload["action_id"]
        if aid in _actions:
            _actions[aid]["status"] = "pushed"
            _action_nodes[aid]["status"] = "approved"  # GraphNode.status has no "pushed" value


bus.add_listener(_on_event)


@asynccontextmanager
async def lifespan(app: FastAPI):
    bus.bind_loop(asyncio.get_running_loop())
    yield


app = FastAPI(title="foundry-lite", lifespan=lifespan)


class ApprovalBody(BaseModel):
    decision: Literal["approved", "rejected"]


class ReplayBody(BaseModel):
    file: str | None = None
    speed: float = 4.0


@app.get("/api/state")
async def get_state() -> dict[str, Any]:
    onto = onto_mod.load_ontology()
    extra_nodes = list(_insight_nodes.values()) + list(_action_nodes.values())
    extra_edges = list(_produces_edges.values())
    graph = onto_mod.build_graph(onto, extra_nodes=extra_nodes, extra_edges=extra_edges)
    terms = onto_mod.terms_from_ontology(onto)
    return {
        "graph": graph,
        "terms": [t.model_dump() for t in terms],
        "actions": list(_actions.values()),
        "pending": list(_pending.values()),
    }


@app.get("/api/events")
async def sse_events() -> EventSourceResponse:
    q = bus.subscribe()

    async def gen():
        try:
            while True:
                env = await q.get()
                yield {"event": "message", "data": env.model_dump_json()}
        finally:
            bus.unsubscribe(q)

    return EventSourceResponse(gen())


class AskBody(BaseModel):
    question: str


def _new_run_id() -> str:
    return f"run_{uuid.uuid4().hex[:8]}"


@app.post("/api/ontology/draft")
async def ontology_draft() -> dict[str, str]:
    run_id = _new_run_id()
    asyncio.create_task(agents.run_ontology_draft(bus, run_id))
    return {"run_id": run_id}


@app.post("/api/ask")
async def ask(body: AskBody) -> dict[str, str]:
    run_id = _new_run_id()
    asyncio.create_task(agents.run_ask(bus, run_id, body.question))
    return {"run_id": run_id}


@app.post("/api/approvals/{subject_id}")
async def approve(subject_id: str, body: ApprovalBody) -> dict[str, bool]:
    decision = body.decision
    if subject_id.startswith("act_"):
        subject_kind = "action"
        # ponytail: idempotency guard — a repeat "approved" while already
        # approved/pushed (double-click, client retry) or repeat "rejected"
        # while already rejected is a no-op: no re-emit, no re-push.
        current = _actions.get(subject_id, {}).get("status")
        if (decision == "approved" and current in ("approved", "pushed")) or (
            decision == "rejected" and current == "rejected"
        ):
            return {"ok": True}
    else:
        subject_kind = "ontology_term"
        onto = onto_mod.load_ontology()
        if onto_mod.set_term_status(onto, subject_id, decision):
            onto_mod.save_ontology(onto)
    bus.publish("approval_resolved", {"subject_kind": subject_kind, "subject_id": subject_id, "decision": decision})
    if subject_kind == "action" and decision == "approved":
        raw = _actions.get(subject_id)
        if raw is None:
            bus.publish("error", {"message": f"cannot push unknown action {subject_id}"})
        else:
            asyncio.create_task(_push_and_emit(ActionProposal(**raw)))
    return {"ok": True}


async def _push_and_emit(action: ActionProposal) -> None:
    """Background push of an approved action. Success → action_pushed (the
    bus listener marks the registry status=pushed); any failure → error
    event. Never crashes, never silent."""
    try:
        url = await push_action(action)
    except ActionPushError as exc:
        bus.publish("error", {"message": str(exc)})
        return
    except Exception as exc:  # e.g. httpx timeout/connect error
        bus.publish("error", {"message": f"action push failed: {type(exc).__name__}: {exc}"})
        return
    bus.publish("action_pushed", {"action_id": action.id, "external_url": url})


@app.post("/api/data/upload")
async def upload_data(file: UploadFile = File(...), table: str | None = Form(None)) -> dict[str, Any]:
    content = await file.read()
    try:
        result = await asyncio.to_thread(ingest_mod.ingest_csv, content, file.filename or "", table)
    except ingest_mod.IngestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    bus.publish("status", {"message": f"ingested table {result.table}: {result.rows} rows, {len(result.columns)} columns"})
    return {"table": result.table, "rows": result.rows, "columns": result.columns}


@app.post("/api/replay")
async def replay_route(body: ReplayBody | None = None) -> dict[str, bool]:
    body = body or ReplayBody()
    file = body.file or str(DEMO_EVENTS_FILE)
    asyncio.create_task(replay_events(bus, file, body.speed))
    return {"ok": True}


@app.post("/api/demo/reset")
async def demo_reset() -> dict[str, bool]:
    """Rebuild the demo to its pristine baseline: reseed CSVs/foundry.duckdb
    (drops any uploaded tables), restore ontology.yaml from the committed
    baseline, clear all in-memory demo state, and truncate the event log."""
    await asyncio.to_thread(seed_mod.main)
    shutil.copy2(onto_mod.ONTOLOGY_BASELINE_PATH, onto_mod.ONTOLOGY_PATH)

    _actions.clear()
    _pending.clear()
    _insight_nodes.clear()
    _action_nodes.clear()
    _produces_edges.clear()

    bus._jsonl_path.write_text("")
    bus.publish("status", {"message": "demo reset: seed rebuilt, ontology baseline restored"})
    return {"ok": True}


@app.get("/api/ontology/export")
async def ontology_export() -> FileResponse:
    return FileResponse(onto_mod.ONTOLOGY_PATH, media_type="application/x-yaml", filename="ontology.yaml")
