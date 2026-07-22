import type { ActionProposal, BoardState, EventEnvelope, GraphEdge, GraphNode, Workflow } from "./types";

function upsertBy<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((existing) => existing.id === item.id);
  if (idx === -1) return [...list, item];
  const next = list.slice();
  next[idx] = item;
  return next;
}

function upsertEdge(
  edges: GraphEdge[],
  source: string,
  target: string,
  kind: GraphEdge["kind"],
): GraphEdge[] {
  const exists = edges.some((e) => e.source === source && e.target === target && e.kind === kind);
  if (exists) return edges;
  return [...edges, { id: `e_${kind}_${source}_${target}`, source, target, kind }];
}

function setNodeStatus(nodes: GraphNode[], id: string, status: GraphNode["status"]): GraphNode[] {
  return nodes.map((n) => (n.id === id ? { ...n, status } : n));
}

function actionNodeStatus(status: ActionProposal["status"]): GraphNode["status"] {
  // GraphNode has no "pushed" status; a pushed action still renders green.
  return status === "pushed" ? "approved" : status;
}

function upsertWorkflow(workflows: Workflow[], wf: Workflow): Workflow[] {
  const idx = workflows.findIndex((w) => w.id === wf.id);
  if (idx === -1) return [...workflows, wf];
  const next = workflows.slice();
  next[idx] = wf;
  return next;
}

/**
 * Pure fold of one SSE envelope into the board's graph/terms/actions/pending/workflows.
 * Node/edge activity glow, the agent feed list, run timing, and toasts are
 * separate (non-board, side-effecting) store concerns handled in store.ts —
 * kept out of here so this stays a plain, unit-testable function.
 */
export function reduceBoard(board: BoardState, envelope: EventEnvelope): BoardState {
  switch (envelope.type) {
    case "ontology_term_proposed": {
      const term = envelope.payload.term;
      const terms = upsertBy(board.terms, term);
      // Object nodes carry meta.table (backend build_graph), which is the
      // same table -> object mapping _on_event uses to anchor term edges.
      const tableToObject = new Map(
        board.graph.nodes.filter((n) => n.kind === "object").map((n) => [n.meta.table, n.id]),
      );
      if (term.kind === "join") {
        // A join is an edge, not a node (contracts.md graph derivation).
        // Mirrors backend _on_event: edge id reuses the join term's id,
        // endpoints resolved via source_tables = [from_table, to_table].
        // Guards: both object nodes must exist, dedupe on edge id.
        const source = tableToObject.get(term.source_tables[0] ?? "");
        const target = tableToObject.get(term.source_tables[1] ?? "");
        if (!source || !target || board.graph.edges.some((e) => e.id === term.id)) {
          return { ...board, terms };
        }
        const edge: GraphEdge = { id: term.id, source, target, kind: "join" };
        return { ...board, terms, graph: { ...board.graph, edges: [...board.graph.edges, edge] } };
      }
      const meta: Record<string, string> =
        term.kind === "metric"
          ? { confidence: String(term.confidence), sql: term.sql, definition: term.definition }
          : { table: term.source_tables[0] ?? "", definition: term.definition };
      const node: GraphNode = {
        id: term.id,
        kind: term.kind,
        label: term.name,
        status: term.status,
        meta,
      };
      const nodes = upsertBy(board.graph.nodes, node);
      // Mirrors backend's e_derives_<metric_id>_<table> edges (object -> metric,
      // data-flow direction) emitted at proposal time, so proposed metrics never
      // float unconnected. Same guards as _on_event: object node must exist,
      // dedupe on edge id.
      let edges = board.graph.edges;
      if (term.kind === "metric") {
        for (const table of term.source_tables) {
          const objectId = tableToObject.get(table);
          if (!objectId) continue;
          const edgeId = `e_derives_${term.id}_${table}`;
          if (edges.some((e) => e.id === edgeId)) continue;
          edges = [...edges, { id: edgeId, source: objectId, target: term.id, kind: "derives" }];
        }
      }
      // Same reasoning as metrics above, for objects: backend build_graph emits
      // e_feeds_<table> (src_<table> -> object), but only a full refetch carries
      // it. Without this, every freshly proposed object floats as a disconnected
      // root until the next GET /api/state — which the layout then honours by
      // filing each one into rank 0, so the board reads as scattered boxes.
      if (term.kind === "object") {
        const table = term.source_tables[0] ?? "";
        const sourceId = `src_${table}`;
        const edgeId = `e_feeds_${table}`;
        if (
          table &&
          nodes.some((n) => n.id === sourceId) &&
          !edges.some((e) => e.id === edgeId)
        ) {
          edges = [...edges, { id: edgeId, source: sourceId, target: term.id, kind: "feeds" }];
        }
      }
      return { ...board, terms, graph: { nodes, edges } };
    }

    case "insight": {
      const { text, severity, node_ids, sql_used } = envelope.payload;
      // Multi-insight aware id scheme (matches backend: insight_{run_id} or insight_{run_id}_{seq})
      const id = `insight_${envelope.run_id || envelope.id}`;
      const meta: Record<string, string> = { severity };
      if (sql_used) meta.sql_used = sql_used;
      if (envelope.workflow_id) meta.workflow_id = envelope.workflow_id;
      const node: GraphNode = { id, kind: "insight", label: text, status: "neutral", meta };
      const nodes = upsertBy(board.graph.nodes, node);
      const knownIds = new Set(nodes.map((n) => n.id));
      // Mirrors backend's e_<evidence_id>_<insight_id> produces edges so
      // live and refetched state agree (same id scheme, same guards).
      const edges = node_ids.reduce<GraphEdge[]>((acc, evidenceId) => {
        if (!knownIds.has(evidenceId)) return acc; // skip ids with no matching node
        const edgeId = `e_${evidenceId}_${id}`;
        if (acc.some((e) => e.id === edgeId)) return acc; // dedupe: replay + live can re-emit
        return [...acc, { id: edgeId, source: evidenceId, target: id, kind: "produces" }];
      }, board.graph.edges);
      return { ...board, graph: { nodes, edges } };
    }

    case "action_proposed": {
      const action = envelope.payload.action;
      const actions = upsertBy(board.actions, action);
      const meta: Record<string, string> = { kind: action.kind };
      if (envelope.workflow_id) meta.workflow_id = envelope.workflow_id;
      const node: GraphNode = {
        id: action.id,
        kind: "action",
        label: action.title,
        status: actionNodeStatus(action.status),
        meta,
      };
      const nodes = upsertBy(board.graph.nodes, node);
      // Mirrors backend's e_produces_<action.id> edge (insight -> action).
      const edges = upsertEdge(board.graph.edges, action.insight_ref, action.id, "produces");
      return { ...board, actions, graph: { nodes, edges } };
    }

    case "approval_required": {
      const { subject_kind, subject_id } = envelope.payload;
      const already = board.pending.some(
        (p) => p.subject_kind === subject_kind && p.subject_id === subject_id,
      );
      const pending = already ? board.pending : [...board.pending, { subject_kind, subject_id }];
      return { ...board, pending };
    }

    case "approval_resolved": {
      const { subject_kind, subject_id, decision } = envelope.payload;
      const pending = board.pending.filter(
        (p) => !(p.subject_kind === subject_kind && p.subject_id === subject_id),
      );
      const terms =
        subject_kind === "ontology_term"
          ? board.terms.map((t) => (t.id === subject_id ? { ...t, status: decision } : t))
          : board.terms;
      const actions =
        subject_kind === "action"
          ? board.actions.map((a) => (a.id === subject_id ? { ...a, status: decision } : a))
          : board.actions;
      const nodes = setNodeStatus(board.graph.nodes, subject_id, decision);
      return { ...board, pending, terms, actions, graph: { ...board.graph, nodes } };
    }

    case "action_pushed": {
      const { action_id } = envelope.payload;
      const actions = board.actions.map((a): ActionProposal =>
        a.id === action_id ? { ...a, status: "pushed" } : a,
      );
      const nodes = setNodeStatus(board.graph.nodes, action_id, "approved");
      return { ...board, actions, graph: { ...board.graph, nodes } };
    }

    case "workflow_created": {
      const { workflow_id, title } = envelope.payload;
      const wf: Workflow = {
        id: workflow_id,
        title,
        status: "active",
        created_at: envelope.ts,
        run_ids: [],
      };
      const workflows = upsertWorkflow(board.workflows, wf);
      return { ...board, workflows, active_workflow_id: workflow_id };
    }

    case "workflow_completed": {
      const { workflow_id } = envelope.payload;
      const workflows = board.workflows.map((w) =>
        w.id === workflow_id ? { ...w, status: "completed" as const } : w,
      );
      return { ...board, workflows };
    }

    case "workflow_renamed": {
      const { workflow_id, title } = envelope.payload;
      const workflows = board.workflows.map((w) =>
        w.id === workflow_id ? { ...w, title } : w,
      );
      return { ...board, workflows };
    }

    case "node_deleted": {
      const deleted = new Set(envelope.payload.node_ids);
      const nodes = board.graph.nodes.filter((n) => !deleted.has(n.id));
      const edges = board.graph.edges.filter((e) => !deleted.has(e.source) && !deleted.has(e.target));
      const terms = board.terms.filter((t) => !deleted.has(t.id));
      const actions = board.actions.filter((a) => !deleted.has(a.id));
      const pending = board.pending.filter((p) => !deleted.has(p.subject_id));
      return { ...board, graph: { nodes, edges }, terms, actions, pending };
    }

    // run_started, status, node_touched, edge_traversed, sql_generated,
    // sql_result, run_completed, error: feed-only, board is unchanged.
    default:
      return board;
  }
}
