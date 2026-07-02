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
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from . import ontology as onto_mod
from .events import DEMO_EVENTS_FILE, Envelope, EventBus, replay as replay_events

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


@app.post("/api/ontology/draft")
async def ontology_draft() -> None:
    raise HTTPException(status_code=501, detail="ontology-drafter agent not implemented yet (Task 2)")


@app.post("/api/ask")
async def ask() -> None:
    raise HTTPException(status_code=501, detail="query agent not implemented yet (Task 2)")


@app.post("/api/approvals/{subject_id}")
async def approve(subject_id: str, body: ApprovalBody) -> dict[str, bool]:
    decision = body.decision
    if subject_id.startswith("act_"):
        subject_kind = "action"
    else:
        subject_kind = "ontology_term"
        onto = onto_mod.load_ontology()
        if onto_mod.set_term_status(onto, subject_id, decision):
            onto_mod.save_ontology(onto)
    # Action push (Jira/Slack) is Task 3 — approving an action here only
    # emits approval_resolved, per plan.md.
    bus.publish("approval_resolved", {"subject_kind": subject_kind, "subject_id": subject_id, "decision": decision})
    return {"ok": True}


@app.post("/api/replay")
async def replay_route(body: ReplayBody | None = None) -> dict[str, bool]:
    body = body or ReplayBody()
    file = body.file or str(DEMO_EVENTS_FILE)
    asyncio.create_task(replay_events(bus, file, body.speed))
    return {"ok": True}
