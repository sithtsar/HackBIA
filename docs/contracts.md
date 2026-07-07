# Foundry-Lite Contracts (single source of truth)

Every builder reads this file first. UI is a pure function of (initial graph, event stream).
Do not invent fields. Do not rename types. TypeScript side: no `any`.

## File layout

```
backend/
  app/__init__.py
  app/main.py        # FastAPI app + routes
  app/events.py      # Event models, EventBus, jsonl append + replay
  app/ontology.py    # ontology.yaml load/save, graph builder
  app/agents.py      # Strands agents (T2 only touches this)
  app/actions.py     # Jira/Slack adapters (T3 only touches this)
  app/seed.py        # generates data/*.csv + data/foundry.duckdb
  data/              # csvs, foundry.duckdb, ontology.yaml, events.jsonl, demo_events.jsonl
frontend/            # Vite + React + TS (bun)
docs/                # this file, plan.md, briefs/
```

Backend deps go in root `pyproject.toml` (uv). Run: `uv run uvicorn backend.app.main:app --reload --port 8400`.
Frontend: bun, dev server on 5173, proxy `/api` → `http://localhost:8400`.

## Event envelope (SSE `data:` payload, one JSON object per event)

```json
{ "id": "evt_000042", "ts": "2026-07-03T10:00:00Z", "run_id": "run_a1b2", "workflow_id": "wf_0001", "type": "<EventType>", "payload": { } }
```

`id` monotonic per process. `run_id` groups one agent run; `""` for system events. `workflow_id` scopes the event to a workflow investigation; `""` for unassigned.

## EventType → payload

| type | payload |
|---|---|
| `run_started` | `{ "kind": "draft"\|"ask"\|"action", "input": string }` |
| `status` | `{ "message": string }` |
| `node_touched` | `{ "node_id": string }` |
| `edge_traversed` | `{ "source": string, "target": string }` |
| `ontology_term_proposed` | `{ "term": OntologyTerm }` |
| `sql_generated` | `{ "sql": string, "terms_used": string[] }` |
| `sql_result` | `{ "columns": string[], "rows": (string\|number\|null)[][], "row_count": number }` (rows capped at 20) |
| `insight` | `{ "text": string, "severity": "info"\|"warning"\|"critical", "node_ids": string[], "sql_used": string }` |
| `action_proposed` | `{ "action": ActionProposal }` |
| `approval_required` | `{ "subject_kind": "ontology_term"\|"action", "subject_id": string }` |
| `approval_resolved` | `{ "subject_kind": string, "subject_id": string, "decision": "approved"\|"rejected" }` |
| `action_pushed` | `{ "action_id": string, "external_url": string }` |
| `run_completed` | `{ "summary": string }` |
| `error` | `{ "message": string }` |
| `workflow_created` | `{ "workflow_id": string, "title": string }` |
| `workflow_renamed` | `{ "workflow_id": string, "title": string }` |
| `workflow_completed` | `{ "workflow_id": string }` |

## Core objects

```ts
type Workflow = {
  id: string;                       // "wf_0001"
  title: string;
  status: "active" | "completed" | "failed";
  created_at: string;
  run_ids: string[];
};

type OntologyTerm = {
  id: string;                       // "m_active_customer", "join_orders_customers", "obj_order"
  kind: "object" | "join" | "metric";
  name: string;
  definition: string;               // human sentence
  sql: string;                      // SELECT or join predicate; "" for objects
  source_tables: string[];
  confidence: number;               // 0..1
  status: "proposed" | "approved" | "rejected";
};

type ActionProposal = {
  id: string;                       // "act_0001"
  kind: "jira" | "slack";
  title: string;
  body: string;
  insight_ref: string;              // node_id of insight
  status: "proposed" | "approved" | "rejected" | "pushed";
};

type GraphNode = {
  id: string;
  kind: "source" | "object" | "metric" | "insight" | "action";
  label: string;
  status: "proposed" | "approved" | "rejected" | "neutral";
  meta: Record<string, string>;     // keys: confidence, sql, definition, workflow_id, sql_used, severity, kind, table
};
type GraphEdge = { id: string; source: string; target: string; kind: "feeds" | "join" | "derives" | "produces" };
```

## ontology.yaml

```yaml
version: 1
sources:
  - table: customers
  - table: orders
  - table: tickets
objects:
  - { id: obj_customer, name: Customer, table: customers }
  - { id: obj_order,    name: Order,    table: orders }
  - { id: obj_ticket,   name: Support Ticket, table: tickets }
joins:
  - { id: join_orders_customers, from: orders.customer_id, to: customers.id, confidence: 0.95, status: approved }
  - { id: join_tickets_customers, from: tickets.customer_id, to: customers.id, confidence: 0.9, status: approved }
metrics:
  - id: m_active_customer
    name: Active Customer
    definition: "Customer with at least one order in the last 90 days"
    sql: "SELECT DISTINCT customer_id FROM orders WHERE order_date >= current_date - INTERVAL 90 DAY"
    source_tables: [orders]
    confidence: 0.8
    status: approved
```

Graph derivation (backend builds, UI never derives):
nodes = sources + objects + metrics (+ insights/actions appended by events);
edges = table→object (`feeds`), joins between objects (`join`), object→metric (`derives`), insight→action (`produces`), insight-evidence node→insight (`produces`). Every directed edge points WITH the data flow (left→right on the board: source → object → metric → insight → action); `edge_traversed` payloads use the same orientation.
A `proposed` term appears WITH its edges the moment `ontology_term_proposed` fires (metric → `derives`, join → `join`) — no floating nodes awaiting approval. These event-driven edges are appended server-side in `_on_event` AND mirrored in the client reducer with identical ids/guards (existence + dedupe), so live view and refetch always agree.

LLM output contract (backend): every LLM call goes through **BAML** (`baml-py`) — functions and output classes defined in `baml_src/*.baml`, generated client committed at `baml_client/`. Cerebras is wired as an `openai-generic` client (`base_url https://api.cerebras.ai/v1`, key ONLY from env `CEREBRAS_API_KEY`, retry_policy max 2 retries with exponential backoff). BAML's Schema-Aligned Parsing is the fault-tolerance layer (markdown fences, trailing commas, type coercion); output class shapes match the Core objects above exactly. Parse/validation exhaustion emits an `error` event and ends the run. No unvalidated LLM dict ever reaches the event bus or ontology.yaml. Regenerate after editing `.baml` files: `uv run baml-cli generate`.

## HTTP API (all under /api)

| Route | Req | Resp |
|---|---|---|
| `GET /api/state` | — | `{ graph: {nodes, edges}, terms: OntologyTerm[], actions: ActionProposal[], pending: {subject_kind, subject_id}[], workflows: Workflow[], active_workflow_id: string\|null }` |
| `GET /api/events` | — | SSE stream of envelopes (live only, no history) |
| `POST /api/ontology/draft` | `{}` | `{ run_id }` (agent runs async, events stream) |
| `POST /api/ask` | `{ question: string }` | `{ run_id }` (creates workflow if none active, scopes ask to active workflow) |
| `POST /api/workflows` | `{ title: string }` | `{ workflow_id: string }` |
| `GET /api/workflows` | — | `{ workflows: Workflow[] }` |
| `GET /api/workflows/{id}` | — | `{ workflow: Workflow }` |
| `POST /api/workflows/{id}/ask` | `{ question: string }` | `{ run_id }` |
| `POST /api/workflows/{id}/action` | `{ insight_text: string, insight_node_id: string }` | `{ action_id: string }` |
| `PATCH /api/workflows/{id}` | `{ status?: "active"\|"completed"\|"failed", title?: string }` | `{ ok: true }` (renaming publishes `workflow_renamed` event) |
| `POST /api/approvals/{subject_id}` | `{ decision: "approved"\|"rejected" }` | `{ ok: true }` (emits approval_resolved; approved action → push → action_pushed) |
| `POST /api/replay` | `{ file?: string, speed?: number, reset?: boolean }` | `{ ok: true }` (default file `backend/data/demo_events.jsonl`, speed 4 = 4x; re-emits envelopes onto the live bus with fresh ts. `reset` defaults **true**: server restores baseline ontology + clears runtime graph/actions/pending first, so replay never stacks on stale state) |
| `POST /api/ontology/join` | `{ "from_object": string, "to_object": string }` | `{ term_id: string }` (user-drawn join: runs deterministic FK inference between the two objects' tables, creates a `proposed` join term, emits `ontology_term_proposed` + `approval_required`; 400 unknown object id, same id, or no inferable key) |
| `POST /api/ontology/metric` | `{ "name": string, "definition": string, "sql"?: string, "source_tables": string[] }` | `{ term_id: string }` (user-built metric, no LLM: id `m_<slug(name)>`, persisted `proposed`, emits `ontology_term_proposed` + `approval_required`; 400 empty name/tables, unknown table, non-SELECT sql, duplicate id) |
| `POST /api/data/upload` | multipart: `file` (CSV, required), `table` (optional name; default = sanitized filename stem) | `{ table: string, rows: number, columns: {name: string, type: string}[] }` (loads into `foundry.duckdb`, appends `{table}` to ontology.yaml `sources:` if absent, emits a `status` event; 400 bad name/CSV, 413 over 20MB) |
| `POST /api/demo/reset` | — | `{ ok: true }` (reseeds `foundry.duckdb`+CSVs, restores `ontology.yaml` from the committed baseline, clears in-memory actions/pending/insight/workflow state, truncates `events.jsonl`, emits one `status` event) |
| `GET /api/ontology/export` | — | `ontology.yaml` file download, `Content-Type: application/x-yaml`, filename `ontology.yaml` |

Every event emitted on the bus is also appended to `backend/data/events.jsonl` (one JSON per line). Replay reads a jsonl and re-emits. That file doubles as demo insurance.

## Design tokens (frontend)

Canvas `#0E1116`, panel `#161B22`, hairline `#2B3444`, agent-blue `#4C90F0`, pending-amber `#D9822B`, committed-green `#3DCC91`, text-secondary `#9BA6B5`, text-primary `#E6EDF3`.
Fonts: IBM Plex Sans (UI), IBM Plex Mono (all data: SQL, timestamps, node labels, numbers). Radius 4px. Hairline borders. Motion ONLY in response to events (edge pulse, node glow); no ambient animation.
Color = state: blue flows/queries, amber pending approval, green committed/approved, red errors.
