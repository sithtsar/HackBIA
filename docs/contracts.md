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
{ "id": "evt_000042", "ts": "2026-07-03T10:00:00Z", "run_id": "run_a1b2", "type": "<EventType>", "payload": { } }
```

`id` monotonic per process. `run_id` groups one agent run; `""` for system events.

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
| `insight` | `{ "text": string, "severity": "info"\|"warning"\|"critical", "node_ids": string[] }` |
| `action_proposed` | `{ "action": ActionProposal }` |
| `approval_required` | `{ "subject_kind": "ontology_term"\|"action", "subject_id": string }` |
| `approval_resolved` | `{ "subject_kind": string, "subject_id": string, "decision": "approved"\|"rejected" }` |
| `action_pushed` | `{ "action_id": string, "external_url": string }` |
| `run_completed` | `{ "summary": string }` |
| `error` | `{ "message": string }` |

## Core objects

```ts
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
  meta: Record<string, string>;
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
edges = table→object (`feeds`), joins between objects (`join`), metric→its objects (`derives`), insight→action (`produces`).

## HTTP API (all under /api)

| Route | Req | Resp |
|---|---|---|
| `GET /api/state` | — | `{ graph: {nodes, edges}, terms: OntologyTerm[], actions: ActionProposal[], pending: {subject_kind, subject_id}[] }` |
| `GET /api/events` | — | SSE stream of envelopes (live only, no history) |
| `POST /api/ontology/draft` | `{}` | `{ run_id }` (agent runs async, events stream) |
| `POST /api/ask` | `{ question: string }` | `{ run_id }` |
| `POST /api/approvals/{subject_id}` | `{ decision: "approved"\|"rejected" }` | `{ ok: true }` (emits approval_resolved; approved action → push → action_pushed) |
| `POST /api/replay` | `{ file?: string, speed?: number }` | `{ ok: true }` (default file `backend/data/demo_events.jsonl`, speed 4 = 4x; re-emits envelopes onto the live bus with fresh ts) |

Every event emitted on the bus is also appended to `backend/data/events.jsonl` (one JSON per line). Replay reads a jsonl and re-emits. That file doubles as demo insurance.

## Design tokens (frontend)

Canvas `#0E1116`, panel `#161B22`, hairline `#2B3444`, agent-blue `#4C90F0`, pending-amber `#D9822B`, committed-green `#3DCC91`, text-secondary `#9BA6B5`, text-primary `#E6EDF3`.
Fonts: IBM Plex Sans (UI), IBM Plex Mono (all data: SQL, timestamps, node labels, numbers). Radius 4px. Hairline borders. Motion ONLY in response to events (edge pulse, node glow); no ambient animation.
Color = state: blue flows/queries, amber pending approval, green committed/approved, red errors.
