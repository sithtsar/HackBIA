"""Strands/LLM agent flows for Foundry-Lite (Task 2).

Path taken: **structured-JSON completions**, not tool-calling. The gemma probe
(backend/app/probe_llm.py) confirmed gemma-4-31b on Cerebras does plain
completions, `response_format=json_object`, AND strands tool-calling — all
work. We still drive the pipeline in Python and use the LLM for exactly one
structured-JSON step per flow, because the contract demands a precise,
deterministic event sequence (lineage node/edge traversal, threshold rule,
approval gating) that is far cleaner to emit from Python than to coax out of a
tool-calling agent loop. Uses the raw `openai` client against the Cerebras
base_url (simplest; params match plan.md's OpenAIModel config verbatim:
model_id=FOUNDRY_MODEL_ID, max_tokens=FOUNDRY_MAX_OUTPUT_TOKENS, temperature=0.2).

Every flow is an async entrypoint (FastAPI background task). Blocking work
(duckdb, LLM HTTP) runs in a worker thread via asyncio.to_thread so the event
loop stays responsive for SSE; events publish on the loop via bus.publish. Any
exception → error event + run_completed; the server never crashes.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any

import duckdb
from dotenv import load_dotenv

from . import ontology as onto_mod
from .events import EventBus, OntologyTerm

load_dotenv()

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA_DIR / "foundry.duckdb"

MODEL_ID = os.environ.get("FOUNDRY_MODEL_ID", "gemma-4-31b")
MAX_TOKENS = int(os.environ.get("FOUNDRY_MAX_OUTPUT_TOKENS", "8192"))

# ---------------------------------------------------------------------------
# LLM (single structured-JSON completion; tests monkeypatch this function).
# ---------------------------------------------------------------------------

_client = None


def _openai():
    global _client
    if _client is None:
        from openai import OpenAI

        _client = OpenAI(
            api_key=os.environ["CEREBRAS_API_KEY"],
            base_url=os.environ["CEREBRAS_BASE_URL"],
        )
    return _client


def llm_json(system: str, user: str, max_tokens: int | None = None) -> dict[str, Any]:
    """One structured-JSON completion. Returns the parsed object."""
    r = _openai().chat.completions.create(
        model=MODEL_ID,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        max_tokens=max_tokens or MAX_TOKENS,
        temperature=0.2,
        response_format={"type": "json_object"},
    )
    content = r.choices[0].message.content or "{}"
    content = content.strip()
    if content.startswith("```"):  # strip stray code fences
        content = content.strip("`")
        content = content[content.find("{"):]
    return json.loads(content)


# ---------------------------------------------------------------------------
# SQL guard + validation (pure, unit-tested).
# ---------------------------------------------------------------------------

_FORBIDDEN = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ATTACH|COPY|PRAGMA|CREATE|ALTER|TRUNCATE|"
    r"REPLACE|INSTALL|LOAD|GRANT|EXPORT|CALL)\b",
    re.IGNORECASE,
)


def guard_sql(sql: str) -> str | None:
    """Return None if the SQL is a safe read-only single statement, else a
    human reason string. SELECT/WITH only, no multi-statement, no DDL/DML."""
    s = (sql or "").strip().rstrip(";").strip()
    if not s:
        return "empty query"
    if ";" in s:
        return "multiple statements not allowed"
    if not re.match(r"^(SELECT|WITH)\b", s, re.IGNORECASE):
        return "query must start with SELECT or WITH"
    if _FORBIDDEN.search(s):
        return "forbidden keyword (write/DDL not allowed)"
    return None


def _explain(sql: str) -> tuple[bool, str]:
    con = duckdb.connect(str(DB_PATH), read_only=True)
    try:
        con.execute("EXPLAIN " + sql)
        return True, ""
    except Exception as e:  # noqa: BLE001
        return False, str(e).strip().splitlines()[0] if str(e) else "unparseable"
    finally:
        con.close()


# ---------------------------------------------------------------------------
# DuckDB introspection + deterministic FK inference.
# ---------------------------------------------------------------------------

def _list_tables() -> list[str]:
    con = duckdb.connect(str(DB_PATH), read_only=True)
    try:
        rows = con.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema='main' ORDER BY table_name"
        ).fetchall()
        return [r[0] for r in rows]
    finally:
        con.close()


def introspect(sample_limit: int = 10) -> dict[str, dict[str, Any]]:
    """{table: {"columns": [(name, type)], "rows": [ {col: val} ]}} with at
    most `sample_limit` sample rows per table."""
    con = duckdb.connect(str(DB_PATH), read_only=True)
    try:
        schema: dict[str, dict[str, Any]] = {}
        for t in _list_tables():
            cols = con.execute(
                "SELECT column_name, data_type FROM information_schema.columns "
                "WHERE table_name=? AND table_schema='main' ORDER BY ordinal_position",
                [t],
            ).fetchall()
            cur = con.execute(f'SELECT * FROM "{t}" LIMIT {int(sample_limit)}')
            names = [d[0] for d in cur.description]
            rows = [dict(zip(names, r)) for r in cur.fetchall()]
            schema[t] = {"columns": [(c, d) for c, d in cols], "rows": rows}
        return schema
    finally:
        con.close()


def _resolve_table(base: str, tables: set[str]) -> str | None:
    for cand in (base, base + "s", base + "es"):
        if cand in tables:
            return cand
    return None


def _overlap(con, from_table: str, from_col: str, to_table: str, to_col: str) -> float:
    fv = {
        r[0]
        for r in con.execute(
            f'SELECT DISTINCT "{from_col}" FROM "{from_table}" WHERE "{from_col}" IS NOT NULL LIMIT 5000'
        ).fetchall()
    }
    if not fv:
        return 0.0
    tv = {
        r[0]
        for r in con.execute(
            f'SELECT DISTINCT "{to_col}" FROM "{to_table}" WHERE "{to_col}" IS NOT NULL LIMIT 100000'
        ).fetchall()
    }
    return len(fv & tv) / len(fv)


def infer_fks(schema: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Deterministic FK inference: column `x_id` -> table matching `x` (with
    naive pluralization) whose referenced key column's values contain >=90% of
    the child column's distinct values. Confidence = containment ratio."""
    tables = set(schema.keys())
    con = duckdb.connect(str(DB_PATH), read_only=True)
    fks: list[dict[str, Any]] = []
    try:
        for t, info in schema.items():
            target_cols_by_table = {
                tt: {c.lower() for c, _ in schema[tt]["columns"]} for tt in tables
            }
            for col, _dtype in info["columns"]:
                if not col.lower().endswith("_id"):
                    continue
                base = col[:-3].lower()  # customer_id -> customer
                target = _resolve_table(base, tables)
                if not target or target == t:
                    continue
                tcols = target_cols_by_table[target]
                to_col = "id" if "id" in tcols else (base + "_id" if base + "_id" in tcols else None)
                if not to_col:
                    continue
                ratio = _overlap(con, t, col, target, to_col)
                if ratio >= 0.9:
                    fks.append({
                        "from_table": t, "from_col": col,
                        "to_table": target, "to_col": to_col,
                        "confidence": round(ratio, 2),
                    })
        return fks
    finally:
        con.close()


# ---------------------------------------------------------------------------
# Prompt building (truncated for the 65k context budget).
# ---------------------------------------------------------------------------

def build_schema_prompt(schema: dict[str, dict[str, Any]], max_rows: int = 10, max_chars: int = 60) -> str:
    parts: list[str] = []
    for t, info in schema.items():
        cols = ", ".join(f"{n} {d}" for n, d in info["columns"])
        parts.append(f"Table {t} ({cols}):")
        for row in info["rows"][:max_rows]:  # HARD CAP: <=10 sample rows/table
            trunc = {k: (v[:max_chars] if isinstance(v, str) else v) for k, v in row.items()}
            parts.append("  " + json.dumps(trunc, default=str))
    return "\n".join(parts)


def _singular(t: str) -> str:
    # ponytail: naive singularize, fine for demo tables (customers/orders/tickets).
    if t.endswith("ies"):
        return t[:-3] + "y"
    if t.endswith("s"):
        return t[:-1]
    return t


# ---------------------------------------------------------------------------
# ontology.yaml persistence (merge by id; never clobber approved).
# ---------------------------------------------------------------------------

def _merge_bucket(onto: dict[str, Any], bucket: str, entries: list[dict[str, Any]]) -> None:
    existing = onto.setdefault(bucket, [])
    by_id = {e["id"]: e for e in existing}
    for entry in entries:
        cur = by_id.get(entry["id"])
        if cur is not None and cur.get("status") == "approved":
            continue  # keep the analyst-approved version untouched
        if cur is not None:
            cur.update(entry)
        else:
            existing.append(entry)
            by_id[entry["id"]] = entry


def _persist(objects: list[dict], joins: list[dict], metrics: list[dict]) -> None:
    onto = onto_mod.load_ontology()
    _merge_bucket(onto, "objects", objects)
    _merge_bucket(onto, "joins", joins)
    _merge_bucket(onto, "metrics", metrics)
    onto_mod.save_ontology(onto)


# ===========================================================================
# Flow 1: ontology draft
# ===========================================================================

_DRAFT_SYSTEM = (
    "You are a BI ontology drafter. Given a DuckDB schema with sample rows and "
    "inferred table joins, propose 3-5 useful business metrics. Return STRICT "
    "JSON only: {\"metrics\":[{\"id\":\"m_snake_case\",\"name\":\"Human Name\","
    "\"definition\":\"one sentence\",\"sql\":\"SELECT ... valid DuckDB SQL "
    "referencing REAL columns only\",\"source_tables\":[\"table\"],"
    "\"confidence\":0.0}]}. SQL must be a single SELECT. Metrics must reference "
    "columns that exist in the schema. confidence in 0..1."
)


async def run_ontology_draft(bus: EventBus, run_id: str) -> None:
    try:
        bus.publish("run_started", {"kind": "draft", "input": ""}, run_id)

        tables = await asyncio.to_thread(_list_tables)
        bus.publish("status", {"message": f"Introspecting DuckDB schema: {', '.join(tables)}"}, run_id)
        for t in tables:
            bus.publish("node_touched", {"node_id": f"src_{t}"}, run_id)

        schema = await asyncio.to_thread(introspect)

        onto = onto_mod.load_ontology()
        approved_obj_ids = {o["id"] for o in onto.get("objects", [])}  # baseline objects are approved
        obj_by_table = {o["table"]: o for o in onto.get("objects", [])}

        # Objects: one per table (human name derived deterministically). Re-touch
        # already-known objects; only *propose* objects for genuinely new tables.
        bus.publish("status", {"message": "Mapping source tables to business objects"}, run_id)
        object_yaml: list[dict] = []
        for t in tables:
            oid = obj_by_table.get(t, {}).get("id", f"obj_{_singular(t)}")
            name = obj_by_table.get(t, {}).get("name", _singular(t).replace("_", " ").title())
            object_yaml.append({"id": oid, "name": name, "table": t})
            if oid in approved_obj_ids:
                bus.publish("node_touched", {"node_id": oid}, run_id)
            else:
                term = OntologyTerm(
                    id=oid, kind="object", name=name,
                    definition=f"A {name} record sourced from {t}.",
                    sql="", source_tables=[t], confidence=0.8, status="proposed",
                )
                bus.publish("ontology_term_proposed", {"term": term.model_dump()}, run_id)
                bus.publish("approval_required", {"subject_kind": "ontology_term", "subject_id": oid}, run_id)

        # Joins: deterministic FK inference FIRST.
        bus.publish("status", {"message": "Inferring joins by FK name + value overlap"}, run_id)
        fks = await asyncio.to_thread(infer_fks, schema)
        join_yaml: list[dict] = []
        for fk in fks:
            jid = f"join_{fk['from_table']}_{fk['to_table']}"
            frm = f"{fk['from_table']}.{fk['from_col']}"
            to = f"{fk['to_table']}.{fk['to_col']}"
            conf = fk["confidence"]
            term = OntologyTerm(
                id=jid, kind="join", name=f"{fk['from_table'].title()} → {fk['to_table'].title()}",
                definition=f"{frm} = {to}", sql=f"{frm} = {to}",
                source_tables=[fk["from_table"], fk["to_table"]], confidence=conf, status="proposed",
            )
            join_yaml.append({"id": jid, "from": frm, "to": to, "confidence": conf, "status": "proposed"})
            bus.publish("ontology_term_proposed", {"term": term.model_dump()}, run_id)
            if conf < 0.9:
                bus.publish("approval_required", {"subject_kind": "ontology_term", "subject_id": jid}, run_id)

        # Metrics: LLM proposes, Python validates each with EXPLAIN.
        bus.publish("status", {"message": "Drafting candidate metrics via LLM"}, run_id)
        user = (
            "Schema and sample rows:\n" + build_schema_prompt(schema)
            + "\n\nInferred joins:\n" + json.dumps([
                {"from": f"{f['from_table']}.{f['from_col']}", "to": f"{f['to_table']}.{f['to_col']}"} for f in fks
            ])
            + "\n\nPropose 3-5 metrics as JSON."
        )
        resp = await asyncio.to_thread(llm_json, _DRAFT_SYSTEM, user)

        valid_tables = set(tables)
        metric_yaml: list[dict] = []
        for m in resp.get("metrics", []):
            mid = str(m.get("id", "")).strip() or f"m_{len(metric_yaml)}"
            if not mid.startswith("m_"):
                mid = "m_" + re.sub(r"[^a-z0-9_]", "_", mid.lower())
            sql = str(m.get("sql", "")).strip()
            conf = min(float(m.get("confidence", 0.7) or 0.7), 0.85)  # metrics: cap so UI never reads near-certain
            src = [t for t in m.get("source_tables", []) if t in valid_tables] or tables[:1]

            if not sql:
                bus.publish("status", {"message": f"Dropped metric {mid}: empty SQL"}, run_id)
                continue
            ok, err = await asyncio.to_thread(_explain, sql)
            if not ok:
                conf = min(conf, 0.35)
                bus.publish("status", {"message": f"Metric {mid} failed EXPLAIN ({err}); kept at low confidence for analyst review"}, run_id)

            term = OntologyTerm(
                id=mid, kind="metric", name=str(m.get("name", mid)),
                definition=str(m.get("definition", "")), sql=sql,
                source_tables=src, confidence=round(conf, 2), status="proposed",
            )
            metric_yaml.append({
                "id": mid, "name": term.name, "definition": term.definition, "sql": sql,
                "source_tables": src, "confidence": term.confidence, "status": "proposed",
            })
            bus.publish("ontology_term_proposed", {"term": term.model_dump()}, run_id)
            # LLM-proposed metrics always need human review, regardless of self-reported confidence.
            bus.publish("approval_required", {"subject_kind": "ontology_term", "subject_id": mid}, run_id)

        await asyncio.to_thread(_persist, object_yaml, join_yaml, metric_yaml)
        bus.publish("run_completed", {
            "summary": f"Proposed {len(join_yaml)} joins and {len(metric_yaml)} metrics; persisted to ontology.yaml"
        }, run_id)
    except Exception as e:  # noqa: BLE001
        bus.publish("error", {"message": f"{type(e).__name__}: {e}"}, run_id)
        bus.publish("run_completed", {"summary": "ontology draft failed"}, run_id)


# ===========================================================================
# Flow 2: ask (NL question -> grounded SQL -> lineage -> result -> insight)
# ===========================================================================

_ASK_SYSTEM = (
    "You are a BI query planner. Given a user question, a list of APPROVED "
    "ontology terms (objects/joins/metrics with their SQL) and the DuckDB "
    "schema, produce ONE DuckDB SELECT query that answers the question. Return "
    "STRICT JSON only: {\"sql\":\"SELECT ...\",\"terms_used\":[\"term_id\",...],"
    "\"reasoning_one_line\":\"...\"}. SQL must be a single read-only SELECT "
    "(or WITH...SELECT), DuckDB dialect, referencing only real tables/columns. "
    "terms_used lists the ids of the ontology terms you relied on."
)


def _table_to_object(onto: dict[str, Any]) -> dict[str, str]:
    return {o["table"]: o["id"] for o in onto.get("objects", [])}


def _execute(sql: str) -> dict[str, Any]:
    con = duckdb.connect(str(DB_PATH), read_only=True)
    try:
        cur = con.execute(sql)
        cols = [d[0] for d in cur.description]
        allrows = cur.fetchall()
        rows = [[_cell(v) for v in r] for r in allrows[:20]]
        return {"columns": cols, "rows": rows, "row_count": len(allrows)}
    finally:
        con.close()


def _cell(v: Any) -> Any:
    if v is None or isinstance(v, (int, float, str)):
        return v
    return str(v)


def _emit_lineage(bus: EventBus, run_id: str, onto: dict[str, Any], term_ids: list[str]) -> list[str]:
    """Emit node_touched/edge_traversed along the real lineage for the terms
    used, using graph ids from ontology.py's builder. Returns touched object
    node ids (used as insight node_ids)."""
    t2o = _table_to_object(onto)
    terms = {t.id: t for t in onto_mod.terms_from_ontology(onto)}
    touched: set[str] = set()
    touched_objects: list[str] = []

    def touch(node_id: str) -> None:
        if node_id not in touched:
            touched.add(node_id)
            bus.publish("node_touched", {"node_id": node_id}, run_id)

    def touch_obj(node_id: str) -> None:
        touch(node_id)
        if node_id.startswith("obj_") and node_id not in touched_objects:
            touched_objects.append(node_id)

    for tid in term_ids:
        term = terms.get(tid)
        if term is None:
            continue
        if term.kind == "object":
            table = term.source_tables[0]
            touch(f"src_{table}")
            bus.publish("edge_traversed", {"source": f"src_{table}", "target": tid}, run_id)
            touch_obj(tid)
        elif term.kind == "join":
            frm_tbl, to_tbl = term.source_tables[0], term.source_tables[1]
            frm_obj, to_obj = t2o.get(frm_tbl, frm_tbl), t2o.get(to_tbl, to_tbl)
            touch_obj(frm_obj)
            bus.publish("edge_traversed", {"source": frm_obj, "target": to_obj}, run_id)
            touch_obj(to_obj)
        elif term.kind == "metric":
            for table in term.source_tables:
                obj = t2o.get(table, table)
                touch(f"src_{table}")
                bus.publish("edge_traversed", {"source": f"src_{table}", "target": obj}, run_id)
                touch_obj(obj)
                # derives edge: source=metric, target=object (matches ontology.py's
                # build_graph, which emits e_derives_<metric>_<table> as metric->object).
                bus.publish("edge_traversed", {"source": tid, "target": obj}, run_id)
            touch(tid)
    return touched_objects


def _ticket_anomaly() -> tuple[int, int]:
    """(last14, prior14) ticket counts anchored on the latest ticket date."""
    con = duckdb.connect(str(DB_PATH), read_only=True)
    try:
        row = con.execute(
            "WITH d AS (SELECT max(created_date) AS today FROM tickets) "
            "SELECT "
            "(SELECT count(*) FROM tickets, d WHERE created_date > today - INTERVAL 14 DAY), "
            "(SELECT count(*) FROM tickets, d WHERE created_date <= today - INTERVAL 14 DAY "
            " AND created_date > today - INTERVAL 28 DAY) "
        ).fetchone()
        return int(row[0]), int(row[1])
    finally:
        con.close()


async def run_ask(bus: EventBus, run_id: str, question: str) -> None:
    try:
        bus.publish("run_started", {"kind": "ask", "input": question}, run_id)

        onto = onto_mod.load_ontology()
        approved = [t for t in onto_mod.terms_from_ontology(onto) if t.status == "approved"]
        schema = await asyncio.to_thread(introspect, 5)

        bus.publish("status", {"message": "Resolving question against approved ontology terms"}, run_id)
        terms_blob = json.dumps([
            {"id": t.id, "kind": t.kind, "name": t.name, "definition": t.definition, "sql": t.sql}
            for t in approved
        ])
        base_user = (
            f"Question: {question}\n\nApproved ontology terms:\n{terms_blob}\n\n"
            f"Schema:\n{build_schema_prompt(schema, max_rows=5)}\n\nReturn JSON."
        )

        sql = ""
        terms_used: list[str] = []
        last_err = ""
        for attempt in range(2):
            user = base_user if attempt == 0 else base_user + f"\n\nYour previous SQL failed to validate: {last_err}\nFix it."
            try:
                resp = await asyncio.to_thread(llm_json, _ASK_SYSTEM, user)
            except Exception as e:  # noqa: BLE001 — malformed JSON counts as a failed attempt, not a crash
                last_err = f"invalid JSON: {e}"
                continue
            sql = str(resp.get("sql", "")).strip()
            terms_used = [str(x) for x in resp.get("terms_used", [])]
            reason = guard_sql(sql)
            if reason:
                last_err = reason
                continue
            ok, err = await asyncio.to_thread(_explain, sql)
            if ok:
                break
            last_err = err
        else:
            bus.publish("error", {"message": f"Could not produce valid SQL: {last_err}"}, run_id)
            bus.publish("run_completed", {"summary": "ask failed: invalid SQL"}, run_id)
            return

        # Lineage trace along real graph ids, then the query + result.
        touched_objects = _emit_lineage(bus, run_id, onto, terms_used)
        bus.publish("status", {"message": "Generating DuckDB SQL"}, run_id)
        bus.publish("sql_generated", {"sql": sql, "terms_used": terms_used}, run_id)
        bus.publish("status", {"message": "Executing query against foundry.duckdb"}, run_id)
        result = await asyncio.to_thread(_execute, sql)
        bus.publish("sql_result", result, run_id)

        # Threshold rule (pure Python, no LLM): ticket spike -> critical insight.
        relates_tickets = "ticket" in question.lower() or any(
            "tickets" in t.source_tables for t in approved if t.id in terms_used
        )
        if relates_tickets:
            last14, prior14 = await asyncio.to_thread(_ticket_anomaly)
            if prior14 > 0 and last14 >= 2 * prior14:
                ratio = last14 / prior14
                node_ids = touched_objects or ["obj_ticket"]
                insight_node_id = f"insight_{run_id}"
                text = (
                    f"Support tickets in the last 14 days ({last14}) are {ratio:.1f}x the "
                    f"prior 14-day period ({prior14}) — an emerging SLA-impacting spike."
                )
                bus.publish("insight", {"text": text, "severity": "critical", "node_ids": node_ids}, run_id)
                bus.publish("node_touched", {"node_id": insight_node_id}, run_id)
                await run_action(bus, run_id, text, insight_node_id)

        bus.publish("run_completed", {"summary": "Answered with grounded SQL"}, run_id)
    except Exception as e:  # noqa: BLE001
        bus.publish("error", {"message": f"{type(e).__name__}: {e}"}, run_id)
        bus.publish("run_completed", {"summary": "ask failed"}, run_id)


# ===========================================================================
# Flow 3: action (insight -> Jira ticket proposal)
# ===========================================================================

_ACTION_SYSTEM = (
    "You draft a Jira ticket from a BI insight. Return STRICT JSON only: "
    "{\"title\":\"short imperative title\",\"body\":\"what happened, the "
    "evidence numbers, and 'Suggested owner: BI Analyst on-call'\"}."
)


async def run_action(bus: EventBus, run_id: str, insight_text: str, insight_node_id: str) -> None:
    try:
        bus.publish("status", {"message": "Insight severity=critical → drafting escalation"}, run_id)
        resp = await asyncio.to_thread(
            llm_json, _ACTION_SYSTEM, f"Insight: {insight_text}\n\nReturn JSON.", 1024
        )
        title = str(resp.get("title", "Investigate support ticket spike")).strip()
        body = str(resp.get("body", insight_text)).strip()
        if "BI Analyst on-call" not in body:
            body += "\n\nSuggested owner: BI Analyst on-call"

        # Reuse Task 1's in-memory action registry (main._actions) for the id.
        # Lazy import avoids a circular import (main imports agents for routes).
        from . import main as main_mod  # noqa: PLC0415

        action_id = f"act_{len(main_mod._actions) + 1:04d}"
        action = {
            "id": action_id, "kind": "jira", "title": title, "body": body,
            "insight_ref": insight_node_id, "status": "proposed",
        }
        # The bus listener in main.py registers the action into _actions on this event.
        bus.publish("action_proposed", {"action": action}, run_id)
        bus.publish("node_touched", {"node_id": action_id}, run_id)
        bus.publish("approval_required", {"subject_kind": "action", "subject_id": action_id}, run_id)
    except Exception as e:  # noqa: BLE001
        bus.publish("error", {"message": f"{type(e).__name__}: {e}"}, run_id)
