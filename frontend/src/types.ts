// Types below are copied verbatim from docs/contracts.md ("Core objects").
// Do not invent fields. Do not rename types. UI is a pure function of
// (GET /api/state, SSE /api/events) — these are the only shapes it knows.

export type Workflow = {
  id: string; // "wf_0001"
  title: string;
  status: "active" | "completed" | "failed";
  created_at: string;
  run_ids: string[];
};

export type OntologyTerm = {
  id: string; // "m_active_customer", "join_orders_customers", "obj_order"
  kind: "object" | "join" | "metric";
  name: string;
  definition: string; // human sentence
  sql: string; // SELECT or join predicate; "" for objects
  source_tables: string[];
  confidence: number; // 0..1
  status: "proposed" | "approved" | "rejected";
};

export type ActionProposal = {
  id: string; // "act_0001"
  kind: "jira" | "slack";
  title: string;
  body: string;
  insight_ref: string; // node_id of insight
  status: "proposed" | "approved" | "rejected" | "pushed";
};

export type GraphNode = {
  id: string;
  kind: "source" | "object" | "metric" | "insight" | "action";
  label: string;
  status: "proposed" | "approved" | "rejected" | "neutral";
  meta: Record<string, string>; // keys: confidence, sql, definition, workflow_id, sql_used, severity, kind, table
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: "feeds" | "join" | "derives" | "produces";
};

// POST /api/data/upload response shape.
export type UploadColumn = { name: string; type: string };
export type UploadResponse = { table: string; rows: number; columns: UploadColumn[] };

// --- Below this line: not verbatim contract types, but shapes derived from
// the "HTTP API" and "Event envelope" sections of contracts.md, needed to
// type the fetch layer and the SSE seam. ---

export type PendingItem = {
  subject_kind: "ontology_term" | "action";
  subject_id: string;
};

// GET /api/state response shape.
export type BoardState = {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  terms: OntologyTerm[];
  actions: ActionProposal[];
  pending: PendingItem[];
  workflows: Workflow[];
  active_workflow_id: string | null;
};

// Per-type payload shapes, copied verbatim from contracts.md's
// "EventType -> payload" table (field names/optionality untouched).
export type RunStartedPayload = { kind: "draft" | "ask" | "action"; input: string };
export type StatusPayload = { message: string };
export type NodeTouchedPayload = { node_id: string };
export type EdgeTraversedPayload = { source: string; target: string };
export type OntologyTermProposedPayload = { term: OntologyTerm };
export type SqlGeneratedPayload = { sql: string; terms_used: string[] };
export type SqlResultPayload = {
  columns: string[];
  rows: (string | number | null)[][];
  row_count: number;
};
export type InsightPayload = {
  text: string;
  severity: "info" | "warning" | "critical";
  node_ids: string[];
  sql_used: string;
};
export type ActionProposedPayload = { action: ActionProposal };
export type ApprovalRequiredPayload = {
  subject_kind: "ontology_term" | "action";
  subject_id: string;
};
export type ApprovalResolvedPayload = {
  subject_kind: string;
  subject_id: string;
  decision: "approved" | "rejected";
};
export type ActionPushedPayload = { action_id: string; external_url: string };
export type RunCompletedPayload = { summary: string };
export type ErrorPayload = { message: string };
export type WorkflowCreatedPayload = { workflow_id: string; title: string };
export type WorkflowRenamedPayload = { workflow_id: string; title: string };
export type WorkflowCompletedPayload = { workflow_id: string };

type EnvelopeBase = { id: string; ts: string; run_id: string; workflow_id: string };

// SSE `data:` payload: one JSON envelope per contracts.md's "Event envelope"
// section, discriminated on `type` so the reducer (reducer.ts) gets a
// narrowed `payload` per case with no casts.
export type EventEnvelope =
  | (EnvelopeBase & { type: "run_started"; payload: RunStartedPayload })
  | (EnvelopeBase & { type: "status"; payload: StatusPayload })
  | (EnvelopeBase & { type: "node_touched"; payload: NodeTouchedPayload })
  | (EnvelopeBase & { type: "edge_traversed"; payload: EdgeTraversedPayload })
  | (EnvelopeBase & { type: "ontology_term_proposed"; payload: OntologyTermProposedPayload })
  | (EnvelopeBase & { type: "sql_generated"; payload: SqlGeneratedPayload })
  | (EnvelopeBase & { type: "sql_result"; payload: SqlResultPayload })
  | (EnvelopeBase & { type: "insight"; payload: InsightPayload })
  | (EnvelopeBase & { type: "action_proposed"; payload: ActionProposedPayload })
  | (EnvelopeBase & { type: "approval_required"; payload: ApprovalRequiredPayload })
  | (EnvelopeBase & { type: "approval_resolved"; payload: ApprovalResolvedPayload })
  | (EnvelopeBase & { type: "action_pushed"; payload: ActionPushedPayload })
  | (EnvelopeBase & { type: "run_completed"; payload: RunCompletedPayload })
  | (EnvelopeBase & { type: "error"; payload: ErrorPayload })
  | (EnvelopeBase & { type: "workflow_created"; payload: WorkflowCreatedPayload })
  | (EnvelopeBase & { type: "workflow_renamed"; payload: WorkflowRenamedPayload })
  | (EnvelopeBase & { type: "workflow_completed"; payload: WorkflowCompletedPayload });

export type EventType = EventEnvelope["type"];
