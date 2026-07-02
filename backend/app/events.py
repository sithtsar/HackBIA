"""Event envelope models + in-process EventBus + jsonl append/replay.

Per docs/contracts.md: every event on the bus is one JSON envelope
`{ id, ts, run_id, type, payload }`, also appended as one line to
backend/data/events.jsonl. Replay re-reads a jsonl file and re-emits its
lines onto the live bus.
"""
from __future__ import annotations

import asyncio
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal

from pydantic import BaseModel

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
EVENTS_FILE = DATA_DIR / "events.jsonl"
DEMO_EVENTS_FILE = DATA_DIR / "demo_events.jsonl"

EventType = Literal[
    "run_started",
    "status",
    "node_touched",
    "edge_traversed",
    "ontology_term_proposed",
    "sql_generated",
    "sql_result",
    "insight",
    "action_proposed",
    "approval_required",
    "approval_resolved",
    "action_pushed",
    "run_completed",
    "error",
]


class OntologyTerm(BaseModel):
    id: str
    kind: Literal["object", "join", "metric"]
    name: str
    definition: str
    sql: str
    source_tables: list[str]
    confidence: float
    status: Literal["proposed", "approved", "rejected"]


class ActionProposal(BaseModel):
    id: str
    kind: Literal["jira", "slack"]
    title: str
    body: str
    insight_ref: str
    status: Literal["proposed", "approved", "rejected", "pushed"]


class Envelope(BaseModel):
    id: str
    ts: str
    run_id: str
    type: EventType
    payload: dict[str, Any]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class EventBus:
    """In-process pub/sub. One asyncio.Queue per SSE subscriber.

    publish() must run on the bound event loop thread. publish_sync() is the
    thread-safe entry point for sync/background code (agents) — it schedules
    the real publish onto the bound loop and blocks the calling thread until
    it lands.
    """

    def __init__(self, jsonl_path: Path = EVENTS_FILE):
        self._subscribers: set[asyncio.Queue[Envelope]] = set()
        self._listeners: list[Callable[[Envelope], None]] = []
        self._lock = threading.Lock()
        self._counter = 0
        self._jsonl_path = jsonl_path
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def add_listener(self, fn: Callable[[Envelope], None]) -> None:
        """Register a synchronous callback invoked on every publish (used by
        main.py to derive in-memory state — actions/pending/insight nodes —
        from the event stream itself)."""
        self._listeners.append(fn)

    def subscribe(self) -> asyncio.Queue[Envelope]:
        q: asyncio.Queue[Envelope] = asyncio.Queue()
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[Envelope]) -> None:
        self._subscribers.discard(q)

    def _next_id(self) -> str:
        with self._lock:
            self._counter += 1
            return f"evt_{self._counter:06d}"

    def publish(
        self,
        type: EventType,
        payload: dict[str, Any],
        run_id: str = "",
        ts: str | None = None,
    ) -> Envelope:
        env = Envelope(id=self._next_id(), ts=ts or _now_iso(), run_id=run_id, type=type, payload=payload)
        self._append(env)
        for fn in self._listeners:
            fn(env)
        for q in list(self._subscribers):
            q.put_nowait(env)
        return env

    def publish_sync(
        self,
        type: EventType,
        payload: dict[str, Any],
        run_id: str = "",
        ts: str | None = None,
    ) -> Envelope:
        """Thread-safe publish for sync code running off the event loop
        thread (e.g. an agent's blocking LLM/DB call in a worker thread)."""
        if self._loop is None:
            return self.publish(type, payload, run_id, ts)
        fut = asyncio.run_coroutine_threadsafe(_wrap(self, type, payload, run_id, ts), self._loop)
        return fut.result()

    def _append(self, env: Envelope) -> None:
        self._jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self._jsonl_path, "a") as f:
            f.write(env.model_dump_json() + "\n")


async def _wrap(bus: EventBus, type, payload, run_id, ts) -> Envelope:
    return bus.publish(type, payload, run_id, ts)


async def replay(bus: EventBus, file: Path | str | None = None, speed: float = 4.0) -> int:
    """Read a jsonl file of envelopes and re-emit each onto the bus with a
    fresh id/ts, spaced ~0.3s/event (divided by speed) for a real-time feel.
    Runs as a background asyncio task; returns the number of events emitted.

    Errors never pass silently: a bad path or missing file stops the replay
    and emits an `error` event; a malformed line is skipped (with its own
    `error` event) and replay continues with the remaining lines."""
    path = Path(file) if file else DEMO_EVENTS_FILE
    delay = 0.3 / max(speed, 0.01)
    run_id = ""
    try:
        resolved = path.resolve()
        if not resolved.is_relative_to(DATA_DIR):
            bus.publish("error", {"message": "replay file outside data dir"}, run_id=run_id)
            return 0
        with open(resolved) as f:
            lines = [ln for ln in f if ln.strip()]
    except Exception as exc:
        bus.publish("error", {"message": f"replay failed: {exc}"}, run_id=run_id)
        return 0

    count = 0
    try:
        for i, ln in enumerate(lines, start=1):
            try:
                raw = json.loads(ln)
                run_id = raw.get("run_id", run_id)
                etype, payload = raw["type"], raw["payload"]
            except Exception as exc:
                bus.publish(
                    "error", {"message": f"replay failed at line {i}: {exc}"}, run_id=run_id
                )
                continue
            bus.publish(etype, payload, run_id=run_id)
            count += 1
            await asyncio.sleep(delay)
    except Exception as exc:
        bus.publish("error", {"message": f"replay failed: {exc}"}, run_id=run_id)
        return count
    return count
