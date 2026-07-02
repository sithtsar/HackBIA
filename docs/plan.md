# Foundry-Lite Build Plan

Ontology-grounded BI agent ops board. Palantir-style single board: lineage graph + live agent feed + approval queue.
Constitution: docs/contracts.md. Two lanes, zero file overlap. Global constraints:

- UI is a pure function of (GET /api/state, SSE /api/events). No other data paths.
- Backend Python 3.14 / uv / FastAPI, code under `backend/`. Frontend bun/Vite/React/TS strict (no `any`) under `frontend/`.
- Every bus event also appended to events.jsonl. Replay must drive the full UI with zero LLM calls.
- Errors never pass silently: agent/LLM failures emit `error` events.
- Keep it small: no auth, no persistence beyond files, no extra services.

## Task 1: Backend core (lane A) — sonnet
FastAPI app per contracts: events.py (envelope models, in-process EventBus with asyncio queues, jsonl append, replay), ontology.py (yaml load/save, graph builder), seed.py (3 CSVs w/ ~500 rows realistic data incl. a plantable anomaly: ticket spike + SLA breaches in last 14 days; loads into foundry.duckdb), main.py (routes: state, events SSE, replay, approvals — approvals update ontology.yaml/action status + emit events; draft/ask return 501 stub for now), handcrafted data/ontology.yaml (approved baseline per contracts), handcrafted data/demo_events.jsonl (~40 events simulating full 3-act run: draft w/ proposals → ask w/ trace+sql → insight → action_proposed → approval_required). Deps added via uv. Smoke test: scripts or pytest hitting state + replay + SSE.

## Task 2: Strands agents (lane A, after T1) — opus
agents.py: three agents on strands-agents SDK (Bedrock via AWS_PROFILE; model configurable env FOUNDRY_MODEL_ID, default anthropic claude sonnet on bedrock). (1) ontology-drafter: introspect duckdb information_schema + 50-row samples; deterministic FK inference by name+value-overlap FIRST, LLM only for semantic naming/definitions/metrics; emit ontology_term_proposed w/ confidence + approval_required for confidence < 0.9; write proposals into ontology.yaml status=proposed. (2) query-agent: NL question → pick approved terms → generate DuckDB SQL → validate w/ EXPLAIN → execute; emit node_touched/edge_traversed along real lineage path, sql_generated, sql_result; threshold rule on results → insight event. (3) action-agent: insight → drafts ActionProposal (jira) → action_proposed + approval_required. Wire main.py draft/ask routes to real agents. All LLM failures → error event, never crash server. Verify with one real run against Bedrock; if no model access, report BLOCKED with exact error.

## Task 3: Action push adapters (lane A, after T2) — sonnet
actions.py: on action approval, push. Jira Cloud REST (env JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN/JIRA_PROJECT) and Slack webhook (SLACK_WEBHOOK_URL). Missing env → clearly-labeled mock mode: log + fake external_url "https://mock.jira/PROJ-123", still emit action_pushed. Never block demo on missing creds.

## Task 4: Board shell (lane B) — sonnet
frontend/: Vite+React+TS strict, Tailwind v4, @xyflow/react. Layout + tokens per contracts.md design section: topbar (status dot, run label, manual-vs-agent timer placeholder), center React Flow canvas rendering /api/state graph (custom node component: kind icon, mono label, status color ring; dagre or layered manual layout L→R source→object→metric), right rail top = agent feed panel (empty state), right rail bottom = approval queue (renders pending from state, approve/reject buttons POST /api/approvals). IBM Plex via @fontsource. Dark only. Vite proxy /api→8400. No `any`, no unused shadcn bloat — hand-rolled panels fine.

## Task 5: Live wiring (lane B, after T4) — sonnet, escalate to opus if blocked
SSE client (EventSource w/ reconnect) → single reducer store (Zustand or useReducer) keyed by event type per contracts. Feed renders envelopes live (mono, color-coded by type, auto-scroll). node_touched/edge_traversed → animate: edge pulse + node glow in agent-blue, decay after 2s. insight → append insight node + red/amber styling. action_proposed → append action node + amber; approval_required → queue item appears; approval_resolved → colors flip green/gray. Ask box in topbar POSTs /api/ask. Replay button POSTs /api/replay. Error events → toast + feed entry. Timer: starts on run_started, stops run_completed, shows vs static "manual: 45 min" baseline.

## Task 6: Final review + demo script — opus reviewer, then me
Whole-branch review (requesting-code-review), fix wave, rehearse: seed → draft → approve terms → ask 3 questions → approve action → push (mock ok) → full replay. Write DEMO.md runbook.
