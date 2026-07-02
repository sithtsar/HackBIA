"""ontology.yaml load/save + graph derivation.

Graph derivation rules (docs/contracts.md):
  nodes = sources + objects + metrics (+ insights/actions appended by events)
  edges = table->object (feeds), joins between objects (join),
          metric->its objects (derives), insight->action (produces)

Node/edge id conventions (not specified by contracts.md, chosen to match
frontend/src/fixtures/state.json which the board-shell task already built
against): source "src_<table>", feeds edge "e_feeds_<table>", derives edge
"e_derives_<metric_id>_<table>", produces edge "e_produces_<action_id>".
Join edges reuse the join's own id.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from .events import ActionProposal, OntologyTerm

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
ONTOLOGY_PATH = DATA_DIR / "ontology.yaml"
# Committed, never-mutated reference copy — /api/demo/reset copies this over
# ONTOLOGY_PATH to undo any drafts/approvals/uploads made during a demo run.
ONTOLOGY_BASELINE_PATH = DATA_DIR / "ontology.baseline.yaml"


def load_ontology(path: Path = ONTOLOGY_PATH) -> dict[str, Any]:
    with open(path) as f:
        return yaml.safe_load(f)


def save_ontology(onto: dict[str, Any], path: Path = ONTOLOGY_PATH) -> None:
    with open(path, "w") as f:
        yaml.safe_dump(onto, f, sort_keys=False)


def set_term_status(onto: dict[str, Any], term_id: str, status: str) -> bool:
    """Find term_id among joins/metrics and set its status in place.
    Returns True if found+updated, False otherwise (no-op — e.g. an id from
    a replayed demo narrative that was never actually drafted into the live
    yaml; approvals route still emits approval_resolved either way so the
    demo UI updates)."""
    for bucket in ("joins", "metrics"):
        for term in onto.get(bucket, []):
            if term["id"] == term_id:
                term["status"] = status
                return True
    return False


def _table_to_object(onto: dict[str, Any]) -> dict[str, str]:
    return {o["table"]: o["id"] for o in onto.get("objects", [])}


def build_graph(
    onto: dict[str, Any],
    extra_nodes: list[dict[str, Any]] | None = None,
    extra_edges: list[dict[str, Any]] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []

    for s in onto.get("sources", []):
        table = s["table"]
        nodes.append({"id": f"src_{table}", "kind": "source", "label": table, "status": "neutral", "meta": {"table": table}})

    for o in onto.get("objects", []):
        nodes.append({"id": o["id"], "kind": "object", "label": o["name"], "status": "approved", "meta": {"table": o["table"]}})
        edges.append({"id": f"e_feeds_{o['table']}", "source": f"src_{o['table']}", "target": o["id"], "kind": "feeds"})

    table_to_object = _table_to_object(onto)
    for j in onto.get("joins", []):
        from_table = j["from"].split(".")[0]
        to_table = j["to"].split(".")[0]
        edges.append({
            "id": j["id"],
            "source": table_to_object.get(from_table, from_table),
            "target": table_to_object.get(to_table, to_table),
            "kind": "join",
        })

    for m in onto.get("metrics", []):
        nodes.append({
            "id": m["id"],
            "kind": "metric",
            "label": m["name"],
            "status": m.get("status", "proposed"),
            "meta": {"confidence": str(m.get("confidence", ""))},
        })
        for table in m.get("source_tables", []):
            obj_id = table_to_object.get(table)
            if obj_id:
                edges.append({"id": f"e_derives_{m['id']}_{table}", "source": m["id"], "target": obj_id, "kind": "derives"})

    nodes.extend(extra_nodes or [])
    edges.extend(extra_edges or [])
    return {"nodes": nodes, "edges": edges}


def terms_from_ontology(onto: dict[str, Any]) -> list[OntologyTerm]:
    """Project ontology.yaml's compact shape into the full OntologyTerm
    shape used by /api/state and events (fills in name/definition/sql for
    objects+joins, which the yaml keeps terse)."""
    terms: list[OntologyTerm] = []

    for o in onto.get("objects", []):
        terms.append(OntologyTerm(
            id=o["id"], kind="object", name=o["name"],
            definition=f"{o['name']} record sourced from {o['table']}.",
            sql="", source_tables=[o["table"]], confidence=1.0, status="approved",
        ))

    for j in onto.get("joins", []):
        from_table, from_col = j["from"].split(".")
        to_table, to_col = j["to"].split(".")
        terms.append(OntologyTerm(
            id=j["id"], kind="join", name=f"{from_table.title()} → {to_table.title()}",
            definition=f"{j['from']} = {j['to']}", sql=f"{j['from']} = {j['to']}",
            source_tables=[from_table, to_table], confidence=j["confidence"], status=j["status"],
        ))

    for m in onto.get("metrics", []):
        terms.append(OntologyTerm(
            id=m["id"], kind="metric", name=m["name"], definition=m["definition"],
            sql=m["sql"], source_tables=m["source_tables"], confidence=m["confidence"], status=m["status"],
        ))

    return terms
