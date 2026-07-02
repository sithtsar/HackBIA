// Types below are copied verbatim from docs/contracts.md ("Core objects").
// Do not invent fields. Do not rename types. UI is a pure function of
// (GET /api/state, SSE /api/events) — these are the only shapes it knows.

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
  meta: Record<string, string>;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: "feeds" | "join" | "derives" | "produces";
};

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
};

export type EventType =
  | "run_started"
  | "status"
  | "node_touched"
  | "edge_traversed"
  | "ontology_term_proposed"
  | "sql_generated"
  | "sql_result"
  | "insight"
  | "action_proposed"
  | "approval_required"
  | "approval_resolved"
  | "action_pushed"
  | "run_completed"
  | "error";

// SSE `data:` payload. Payload shape varies per `type` (see contracts.md
// "EventType -> payload" table); Task 5 narrows this when it builds the
// reducer. Left as a record here since Task 4 only needs the envelope
// shape for the store seam, not the payload contents.
export type EventEnvelope = {
  id: string;
  ts: string;
  run_id: string;
  type: EventType;
  payload: Record<string, unknown>;
};
