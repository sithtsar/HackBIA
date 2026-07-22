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
import os
import re
import shutil
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from . import agents
from . import ingest as ingest_mod
from . import ontology as onto_mod
from . import scenarios
from . import seed as seed_mod
from .actions import ActionPushError, push_action
from .events import DEMO_EVENTS_FILE, ActionProposal, Envelope, EventBus, OntologyTerm, replay as replay_events

load_dotenv()

bus = EventBus()

_actions: dict[str, dict[str, Any]] = {}
_pending: dict[str, dict[str, str]] = {}
_insight_nodes: dict[str, dict[str, Any]] = {}
_action_nodes: dict[str, dict[str, Any]] = {}
_produces_edges: dict[str, dict[str, Any]] = {}
# Proposed-term graph bits, populated purely from the event stream (so replay
# — which never writes ontology.yaml — still renders proposed metrics/joins
# instead of leaving them floating). Once a term actually lands in
# ontology.yaml (draft flow's _persist, or the manual join endpoint),
# build_graph's own onto-derived nodes/edges take over; get_state() filters
# these out by id at request time so the two paths never double up.
_term_nodes: dict[str, dict[str, Any]] = {}
_term_edges: dict[str, dict[str, Any]] = {}

# Workflow-scoped storage
_workflows: dict[str, dict[str, Any]] = {}
_insight_seq: dict[str, int] = {}  # run_id -> sequence counter for multi-insight
_active_workflow_id: str | None = None
# Which demo domain is loaded. Reset switches it; seed defaults to retail.
_active_scenario: str = scenarios.DEFAULT_SCENARIO
_insight_sql_used: dict[str, str] = {}  # insight_node_id -> sql used to produce it


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _create_workflow(title: str) -> str:
    wf_id = f"wf_{uuid.uuid4().hex[:6]}"
    global _active_workflow_id
    _workflows[wf_id] = {
        "id": wf_id, "title": title,
        "status": "active", "created_at": _now_iso(), "run_ids": [],
    }
    _active_workflow_id = wf_id
    bus.publish("workflow_created", {"workflow_id": wf_id, "title": title})
    return wf_id


def _on_event(env: Envelope) -> None:
    global _active_workflow_id
    if env.type == "insight":
        # Multi-insight support: sequential ids per run
        seq = _insight_seq.get(env.run_id, 0) + 1
        _insight_seq[env.run_id] = seq
        node_id = f"insight_{env.run_id}_{seq}" if seq > 1 else f"insight_{env.run_id}"
        sql_used = env.payload.get("sql_used", "")
        meta: dict[str, str] = {"severity": env.payload["severity"]}
        if sql_used:
            meta["sql_used"] = sql_used
            _insight_sql_used[node_id] = sql_used
        if env.workflow_id:
            meta["workflow_id"] = env.workflow_id
        _insight_nodes[node_id] = {
            "id": node_id, "kind": "insight", "label": env.payload["text"],
            "status": "neutral", "meta": meta,
        }
        extra = list(_term_nodes.values()) + list(_insight_nodes.values()) + list(_action_nodes.values())
        graph_node_ids = {n["id"] for n in onto_mod.build_graph(onto_mod.load_ontology(), extra_nodes=extra)["nodes"]}
        for evidence_id in env.payload["node_ids"]:
            if evidence_id not in graph_node_ids:
                continue  # skip ids with no matching node
            edge_id = f"e_{evidence_id}_{node_id}"
            if edge_id in _produces_edges:
                continue  # dedupe: replay + live can re-emit the same insight
            _produces_edges[edge_id] = {
                "id": edge_id, "source": evidence_id, "target": node_id, "kind": "produces",
            }
    elif env.type == "ontology_term_proposed":
        term = env.payload["term"]
        # Build table→object mapping from both ontology.yaml AND event-sourced object terms
        onto_objects = onto_mod.load_ontology().get("objects", [])
        table_to_object: dict[str, str] = {o["table"]: o["id"] for o in onto_objects}
        # Include event-sourced proposed objects
        for t in _term_nodes.values():
            if t["kind"] == "object":
                table = t["meta"].get("table", "")
                if table:
                    table_to_object.setdefault(table, t["id"])
        if term["kind"] == "object":
            _term_nodes[term["id"]] = {
                "id": term["id"], "kind": "object", "label": term["name"],
                "status": term["status"],
                "meta": {"table": term["source_tables"][0] if term.get("source_tables") else ""},
            }
        elif term["kind"] == "metric":
            meta: dict[str, str] = {"confidence": str(term["confidence"])}
            if term.get("sql"):
                meta["sql"] = term["sql"]
            if term.get("definition"):
                meta["definition"] = term["definition"]
            _term_nodes[term["id"]] = {
                "id": term["id"], "kind": "metric", "label": term["name"],
                "status": term["status"], "meta": meta,
            }
            for table in term["source_tables"]:
                obj_id = table_to_object.get(table)
                if obj_id is None:
                    continue
                edge_id = f"e_derives_{term['id']}_{table}"
                _term_edges[edge_id] = {"id": edge_id, "source": obj_id, "target": term["id"], "kind": "derives"}
        elif term["kind"] == "join" and len(term["source_tables"]) >= 2:
            from_obj = table_to_object.get(term["source_tables"][0])
            to_obj = table_to_object.get(term["source_tables"][1])
            if from_obj is not None and to_obj is not None:
                _term_edges[term["id"]] = {"id": term["id"], "source": from_obj, "target": to_obj, "kind": "join"}
    elif env.type == "action_proposed":
        a = env.payload["action"]
        _actions[a["id"]] = a
        meta: dict[str, str] = {"kind": a["kind"]}
        if env.workflow_id:
            meta["workflow_id"] = env.workflow_id
        _action_nodes[a["id"]] = {
            "id": a["id"], "kind": "action", "label": a["title"],
            "status": "proposed", "meta": meta,
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
    elif env.type == "workflow_created":
        wid = env.payload["workflow_id"]
        if wid not in _workflows:
            _workflows[wid] = {
                "id": wid,
                "title": env.payload["title"],
                "status": "active",
                "created_at": env.ts,
                "run_ids": [],
            }
        # Replay drives workflows through here only (never _create_workflow), so
        # without this the board ends up with a workflow but no active pointer,
        # and the next /api/ask forks a second one instead of joining it.
        _active_workflow_id = wid


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
    reset: bool = True


def _snapshot() -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
    """Merged (ontology.yaml + event-sourced proposals) view used by every
    read of the board: GET /api/state, node sampling, and delete cascade all
    need the same onto-with-event-sourced-objects + graph."""
    onto = onto_mod.load_ontology()
    existing_object_ids = {o["id"] for o in onto.get("objects", [])}
    existing_metric_ids = {m["id"] for m in onto.get("metrics", [])}
    existing_join_ids = {j["id"] for j in onto.get("joins", [])}
    all_existing = existing_object_ids | existing_metric_ids

    # Merge event-sourced object terms into onto so YAML-based metrics/joins
    # can resolve table→object for derives/joins edges.
    event_object_ids = set()
    for n in _term_nodes.values():
        if n["kind"] == "object" and n["id"] not in existing_object_ids:
            table = n["meta"].get("table", "")
            onto.setdefault("objects", []).append({
                "id": n["id"], "name": n["label"], "table": table,
            })
            event_object_ids.add(n["id"])

    term_nodes = [n for n in _term_nodes.values() if n["id"] not in all_existing and n["id"] not in event_object_ids]
    term_edges = [
        e for e in _term_edges.values()
        if not (e["kind"] == "join" and e["id"] in existing_join_ids)
        and not (e["kind"] == "derives" and e["target"] in existing_metric_ids)
    ]
    extra_nodes = term_nodes + list(_insight_nodes.values()) + list(_action_nodes.values())
    extra_edges = term_edges + list(_produces_edges.values())
    graph = onto_mod.build_graph(onto, extra_nodes=extra_nodes, extra_edges=extra_edges)
    return onto, graph


@app.get("/api/state")
async def get_state() -> dict[str, Any]:
    onto, graph = _snapshot()
    base_terms = onto_mod.terms_from_ontology(onto)
    # Append event-sourced terms not yet in ontology.yaml (proposed objects, joins, metrics)
    term_ids = {t.id for t in base_terms}
    for n in _term_nodes.values():
        if n["id"] not in term_ids:
            base_terms.append(OntologyTerm(
                id=n["id"],
                kind=n["kind"],  # type: ignore
                name=n["label"],
                definition=n["meta"].get("definition", ""),
                sql=n["meta"].get("sql", ""),
                source_tables=[],
                confidence=float(n["meta"].get("confidence", "0")) if n["meta"].get("confidence") else 0.0,
                status=n["status"],
            ))
            term_ids.add(n["id"])
    return {
        "graph": graph,
        "terms": [t.model_dump() for t in base_terms],
        "actions": list(_actions.values()),
        "pending": list(_pending.values()),
        "workflows": list(_workflows.values()),
        "active_workflow_id": _active_workflow_id,
    }


@app.get("/api/nodes/{node_id}/sample")
async def node_sample(node_id: str) -> dict[str, Any]:
    """Head/tail rows behind a graph node — the source/object's table, a
    metric's own SQL, or the SQL that produced an insight. 404 for an unknown
    node id, 204-shaped empty result (row_count 0, no columns) for a node
    kind with no underlying query (e.g. an action)."""
    _, graph = _snapshot()
    node = next((n for n in graph["nodes"] if n["id"] == node_id), None)
    if node is None:
        raise HTTPException(404, f"unknown node id: {node_id}")
    try:
        sample = await asyncio.to_thread(agents.sample_node_data, node["kind"], node["meta"])
    except Exception as e:  # noqa: BLE001 — malformed stored SQL surfaces as a client-visible error, not a crash
        raise HTTPException(status_code=502, detail=f"{type(e).__name__}: {e}") from e
    if sample is None:
        return {"columns": [], "head": [], "tail": [], "row_count": 0}
    return sample


@app.delete("/api/graph/{node_id}")
async def delete_graph_node(node_id: str) -> dict[str, list[str]]:
    """Delete a node and its downstream dependents (cascading along
    feeds/derives/produces edges — a metric derived from a deleted object has
    no meaning without it, same for insights/actions built from either) so no
    edge is ever left pointing at a node that no longer exists."""
    onto, graph = _snapshot()
    nodes_by_id = {n["id"]: n for n in graph["nodes"]}
    if node_id not in nodes_by_id:
        raise HTTPException(404, f"unknown node id: {node_id}")

    cascade_kinds = {"feeds", "derives", "produces"}
    adjacency: dict[str, list[str]] = {}
    for e in graph["edges"]:
        if e["kind"] in cascade_kinds:
            adjacency.setdefault(e["source"], []).append(e["target"])

    to_delete: set[str] = set()
    stack = [node_id]
    while stack:
        nid = stack.pop()
        if nid in to_delete:
            continue
        to_delete.add(nid)
        stack.extend(adjacency.get(nid, []))

    removed_tables = {
        nodes_by_id[nid]["meta"].get("table", "")
        for nid in to_delete
        if nodes_by_id[nid]["kind"] in ("source", "object")
    }
    removed_tables.discard("")

    onto["sources"] = [s for s in onto.get("sources", []) if f"src_{s['table']}" not in to_delete]
    onto["objects"] = [o for o in onto.get("objects", []) if o["id"] not in to_delete]
    onto["metrics"] = [m for m in onto.get("metrics", []) if m["id"] not in to_delete]
    onto["joins"] = [
        j for j in onto.get("joins", [])
        if j["id"] not in to_delete
        and j["from"].split(".")[0] not in removed_tables
        and j["to"].split(".")[0] not in removed_tables
    ]
    onto_mod.save_ontology(onto)

    for nid in to_delete:
        _term_nodes.pop(nid, None)
        _insight_nodes.pop(nid, None)
        _insight_sql_used.pop(nid, None)
        _action_nodes.pop(nid, None)
        _actions.pop(nid, None)
        _pending.pop(nid, None)
    for e in list(_term_edges.values()):
        if e["source"] in to_delete or e["target"] in to_delete:
            _term_edges.pop(e["id"], None)
    for e in list(_produces_edges.values()):
        if e["source"] in to_delete or e["target"] in to_delete:
            _produces_edges.pop(e["id"], None)

    node_ids = sorted(to_delete)
    bus.publish("node_deleted", {"node_ids": node_ids})
    return {"node_ids": node_ids}


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

    # ping= emits a comment frame while idle; without it a proxy between the
    # board and the API is free to drop a quiet connection.
    return EventSourceResponse(gen(), ping=15)


class AskBody(BaseModel):
    question: str


def _new_run_id() -> str:
    return f"run_{uuid.uuid4().hex[:8]}"


@app.post("/api/ontology/draft")
async def ontology_draft() -> dict[str, str]:
    run_id = _new_run_id()
    asyncio.create_task(agents.run_ontology_draft(bus, run_id))
    return {"run_id": run_id}


@app.get("/api/ask/suggestions")
async def ask_suggestions() -> dict[str, list[str]]:
    """LLM-generated prompt chips grounded in the current approved ontology
    + schema. 502 on LLM/parse failure — the client falls back to a static
    list rather than have the server fabricate one."""
    try:
        return {"questions": await agents.get_ask_suggestions()}
    except Exception as e:  # noqa: BLE001 — surfaced as a client-visible fallback trigger, not a crash
        raise HTTPException(status_code=502, detail=f"{type(e).__name__}: {e}") from e


@app.post("/api/ask")
async def ask(body: AskBody) -> dict[str, str]:
    """Scoped to active workflow. Creates one if none exists."""
    run_id = _new_run_id()
    wf_id = _active_workflow_id or _create_workflow(body.question)
    _workflows[wf_id]["run_ids"].append(run_id)
    asyncio.create_task(agents.run_ask(bus, run_id, body.question, workflow_id=wf_id))
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


class JoinBody(BaseModel):
    from_object: str
    to_object: str


@app.post("/api/ontology/join")
async def ontology_join(body: JoinBody) -> dict[str, str]:
    """User-drawn join between two objects: no LLM, fully deterministic —
    reuses agents.infer_fks (the same FK inference the ontology-draft flow
    runs) scoped to just the two objects' tables."""
    onto = onto_mod.load_ontology()
    objects_by_id = {o["id"]: o for o in onto.get("objects", [])}
    unknown = [oid for oid in (body.from_object, body.to_object) if oid not in objects_by_id]
    if unknown:
        raise HTTPException(400, f"unknown object id(s): {', '.join(unknown)}")
    if body.from_object == body.to_object:
        raise HTTPException(400, "from_object and to_object must differ")

    t1 = objects_by_id[body.from_object]["table"]
    t2 = objects_by_id[body.to_object]["table"]

    schema = await asyncio.to_thread(agents.introspect)
    fks = await asyncio.to_thread(agents.infer_fks, schema)
    fk = next((f for f in fks if {f["from_table"], f["to_table"]} == {t1, t2}), None)
    if fk is None:
        raise HTTPException(400, f"no inferable key between {t1} and {t2}")

    jid = f"join_{fk['from_table']}_{fk['to_table']}"
    frm, to = f"{fk['from_table']}.{fk['from_col']}", f"{fk['to_table']}.{fk['to_col']}"
    term = OntologyTerm(
        id=jid, kind="join", name=f"{fk['from_table'].title()} → {fk['to_table'].title()}",
        definition=f"{frm} = {to}", sql=f"{frm} = {to}",
        source_tables=[fk["from_table"], fk["to_table"]], confidence=fk["confidence"], status="proposed",
    )
    if not any(j["id"] == jid for j in onto.get("joins", [])):
        onto.setdefault("joins", []).append(
            {"id": jid, "from": frm, "to": to, "confidence": fk["confidence"], "status": "proposed"}
        )
        onto_mod.save_ontology(onto)

    bus.publish("ontology_term_proposed", {"term": term.model_dump()})
    bus.publish("approval_required", {"subject_kind": "ontology_term", "subject_id": jid})
    return {"term_id": jid}


class MetricBody(BaseModel):
    name: str
    definition: str
    sql: str = ""
    source_tables: list[str]


@app.post("/api/ontology/metric")
async def ontology_metric(body: MetricBody) -> dict[str, str]:
    """User-built metric (graph builder): no LLM — the user supplies the
    definition, so it goes straight to a proposed term awaiting approval,
    exactly like a draft-flow proposal."""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "name must not be empty")
    if not body.source_tables:
        raise HTTPException(400, "source_tables must not be empty")
    onto = onto_mod.load_ontology()
    known_tables = {o["table"] for o in onto.get("objects", [])}
    unknown = [t for t in body.source_tables if t not in known_tables]
    if unknown:
        raise HTTPException(400, f"unknown table(s): {', '.join(unknown)}")
    if body.sql.strip():
        reason = agents.guard_sql(body.sql)
        if reason is not None:
            raise HTTPException(400, f"sql rejected: {reason}")

    mid = "m_" + re.sub(r"[^a-z0-9_]+", "_", name.lower()).strip("_")
    if any(m["id"] == mid for m in onto.get("metrics", [])):
        raise HTTPException(400, f"metric {mid} already exists")

    term = OntologyTerm(
        id=mid, kind="metric", name=name, definition=body.definition,
        sql=body.sql.strip(), source_tables=body.source_tables,
        confidence=1.0, status="proposed",
    )
    onto.setdefault("metrics", []).append({
        "id": mid, "name": name, "definition": body.definition, "sql": body.sql.strip(),
        "source_tables": body.source_tables, "confidence": 1.0, "status": "proposed",
    })
    onto_mod.save_ontology(onto)

    bus.publish("ontology_term_proposed", {"term": term.model_dump()})
    bus.publish("approval_required", {"subject_kind": "ontology_term", "subject_id": mid})
    return {"term_id": mid}


class WorkflowCreateBody(BaseModel):
    title: str


class WorkflowPatchBody(BaseModel):
    status: Literal["active", "completed", "failed"] | None = None
    title: str | None = None


class ActionDraftBody(BaseModel):
    insight_text: str
    insight_node_id: str


@app.post("/api/workflows")
async def create_workflow(body: WorkflowCreateBody) -> dict[str, str]:
    return {"workflow_id": _create_workflow(body.title)}


@app.get("/api/workflows")
async def list_workflows() -> dict[str, Any]:
    return {"workflows": list(_workflows.values())}


@app.get("/api/workflows/{wf_id}")
async def get_workflow(wf_id: str) -> dict[str, Any]:
    wf = _workflows.get(wf_id)
    if wf is None:
        raise HTTPException(404, f"workflow {wf_id} not found")
    return {"workflow": wf}


@app.post("/api/workflows/{wf_id}/ask")
async def workflow_ask(wf_id: str, body: AskBody) -> dict[str, str]:
    wf = _workflows.get(wf_id)
    if wf is None:
        raise HTTPException(404, f"workflow {wf_id} not found")
    run_id = _new_run_id()
    wf["run_ids"].append(run_id)
    global _active_workflow_id
    _active_workflow_id = wf_id
    asyncio.create_task(agents.run_ask(bus, run_id, body.question, workflow_id=wf_id))
    return {"run_id": run_id}


@app.patch("/api/workflows/{wf_id}")
async def patch_workflow(wf_id: str, body: WorkflowPatchBody) -> dict[str, bool]:
    wf = _workflows.get(wf_id)
    if wf is None:
        raise HTTPException(404, f"workflow {wf_id} not found")
    if body.status:
        wf["status"] = body.status
        if body.status == "completed":
            bus.publish("workflow_completed", {"workflow_id": wf_id})
    if body.title:
        wf["title"] = body.title
        bus.publish("workflow_renamed", {"workflow_id": wf_id, "title": body.title})
    global _active_workflow_id
    if wf["status"] == "active":
        _active_workflow_id = wf_id
    return {"ok": True}


@app.post("/api/workflows/{wf_id}/action")
async def workflow_draft_action(wf_id: str, body: ActionDraftBody) -> dict[str, str]:
    """User-initiated action draft from an insight, scoped to a workflow."""
    wf = _workflows.get(wf_id)
    if wf is None:
        raise HTTPException(404, f"workflow {wf_id} not found")
    run_id = _new_run_id()
    wf["run_ids"].append(run_id)
    bus.publish("run_started", {"kind": "action", "input": body.insight_text}, run_id, workflow_id=wf_id)
    asyncio.create_task(agents.run_action(bus, run_id, body.insight_text, body.insight_node_id, workflow_id=wf_id))
    return {"run_id": run_id}


@app.post("/api/data/upload")
async def upload_data(file: UploadFile = File(...), table: str | None = Form(None)) -> dict[str, Any]:
    content = await file.read()
    try:
        result = await asyncio.to_thread(ingest_mod.ingest_csv, content, file.filename or "", table)
    except ingest_mod.IngestError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    bus.publish("status", {"message": f"ingested table {result.table}: {result.rows} rows, {len(result.columns)} columns"})
    return {"table": result.table, "rows": result.rows, "columns": result.columns}


async def _restore_baseline(scenario_key: str | None = None) -> None:
    """Reseed CSVs/foundry.duckdb (drops any uploaded tables), restore
    ontology.yaml to the active scenario's baseline, clear all in-memory
    event-derived demo state, and truncate the event log. Shared by
    /api/demo/reset and /api/replay's reset=true (default) path so a replay
    never stacks its events on top of stale live state.

    Passing scenario_key switches the demo domain: the previous scenario's
    tables and CSVs go away and the ontology is rebuilt around the new ones,
    so the agent never introspects a schema that is no longer loaded."""
    global _active_scenario
    scenario = scenarios.get(scenario_key or _active_scenario)
    await asyncio.to_thread(seed_mod.main, scenario.key)

    if scenario.key == scenarios.DEFAULT_SCENARIO:
        # Retail resets from the committed file — it doubles as demo insurance
        # if the generator ever regresses.
        shutil.copy2(onto_mod.ONTOLOGY_BASELINE_PATH, onto_mod.ONTOLOGY_PATH)
    else:
        onto_mod.save_ontology(onto_mod.baseline_for(scenario.tables), onto_mod.ONTOLOGY_PATH)
    _active_scenario = scenario.key

    _actions.clear()
    _pending.clear()
    _insight_nodes.clear()
    _action_nodes.clear()
    _produces_edges.clear()
    _term_nodes.clear()
    _term_edges.clear()
    _workflows.clear()
    _insight_seq.clear()
    _insight_sql_used.clear()
    global _active_workflow_id
    _active_workflow_id = None

    bus._jsonl_path.write_text("")


@app.post("/api/replay")
async def replay_route(body: ReplayBody | None = None) -> dict[str, bool]:
    body = body or ReplayBody()
    if body.reset:
        await _restore_baseline()
    file = body.file or str(DEMO_EVENTS_FILE)
    asyncio.create_task(replay_events(bus, file, body.speed))
    return {"ok": True}


class ResetBody(BaseModel):
    scenario: str | None = None


@app.post("/api/demo/reset")
async def demo_reset(body: ResetBody | None = None) -> dict[str, bool]:
    """Rebuild the demo to its pristine baseline (see _restore_baseline).

    Pass {"scenario": "supply"} to switch domains — same board, different
    data, and an ontology the agent has to draft from scratch."""
    key = (body or ResetBody()).scenario
    if key is not None and key not in scenarios.SCENARIOS:
        raise HTTPException(status_code=422, detail=f"unknown scenario {key!r}")
    await _restore_baseline(key)
    scenario = scenarios.get(_active_scenario)
    bus.publish("status", {"message": f"demo reset [{scenario.key}]: {scenario.label}"})
    return {"ok": True}


@app.get("/api/scenarios")
async def list_scenarios() -> dict[str, Any]:
    """Lets the board offer the demo domains without hardcoding them."""
    return {
        "active": _active_scenario,
        "scenarios": [
            {"key": s.key, "label": s.label, "tables": list(s.tables), "question": s.question}
            for s in scenarios.SCENARIOS.values()
        ],
    }


@app.get("/api/ontology/export")
async def ontology_export() -> FileResponse:
    return FileResponse(onto_mod.ONTOLOGY_PATH, media_type="application/x-yaml", filename="ontology.yaml")


# Production (the GHCR image) serves the built board from this same process, so
# the frontend's relative /api/... calls are same-origin and no proxy or CORS is
# involved. In dev the directory does not exist and Vite serves the board
# instead — hence the guard rather than an unconditional mount. Mounted last so
# it can never shadow an /api route.
_STATIC_DIR = Path(os.getenv("FOUNDRY_STATIC_DIR", "frontend/dist"))
if (_STATIC_DIR / "index.html").is_file():
    app.mount("/", StaticFiles(directory=_STATIC_DIR, html=True), name="board")
