# Foundry-Lite — Demo Runbook

One-liner for the panel: **"Genie answers questions. Palantir takes action. We built the 1% of both that a BI analyst needs — and our agent builds its own ontology."**

## Reset (before EVERY rehearsal and the real run)

```bash
git checkout -- backend/data/ontology.yaml   # live drafts mutate this file
rm -f backend/data/events.jsonl              # runtime event log
uv run python -m backend.app.seed            # rebuild CSVs + foundry.duckdb
```

## Boot

```bash
# terminal 1 — backend :8400
uv run uvicorn backend.app.main:app --reload --port 8400
# terminal 2 — board :5173
cd frontend && bun run dev
```

Open http://localhost:5173 — status dot green = SSE connected.

## The 3 acts (~3 min)

**Act 1 — the agent builds its own ontology (~60s).**
Click **Draft ontology**. Narrate while the board animates: source nodes light up as the agent introspects; deterministic FK inference finds the joins; the LLM names business objects and proposes metrics. Amber rings = proposed, awaiting human. Point at the approval queue: *"Every AI-generated metric definition is gated on a human — that's not a limitation, that's the feature. Palantir charges forward-deployed engineers months for this file."* Approve the metrics live.

**Act 2 — grounded answers with provenance (~60s).**
Ask: `How many active customers do we have?`
The trace lights the actual path: orders.csv → Order → Active Customer. Show the SQL in the feed + which definition it used: *"No silent guessing between six definitions of 'active customer' — it used THE approved one, and shows its work."*
Then ask: `What's happening with support tickets in the last two weeks?`
Result fires the critical insight (≈3.5x ticket spike, SLA breach rate 4x) — insight node appears red.

**Act 3 — insight becomes action, human approves (~45s).**
The agent drafts a Jira ticket from the insight — action node amber, approval card appears. Read the drafted ticket aloud (evidence numbers in the body). Click **Approve** → `action_pushed` → green. *"Closed loop: raw CSV to approved Jira ticket, every hop on this board, human at both gates."*
Timer freezes: **AGENT ~2 min vs MANUAL 45 min.**

## Insurance

Cerebras down / wifi dead / anything weird → click **Replay**: `demo_events.jsonl` drives the entire board identically, zero LLM calls. Rehearsed and deterministic.

## Metrics slide (sources verified 2026-07-03)

| Claim | Number | Source |
|---|---|---|
| Analyst time on busywork | 78% of week; $21.6k/yr/analyst | dbt Labs + Harris Poll 2025 (N=510) |
| Routine BA work automatable w/ AI | 42% time savings | LeverX 2026 field study |
| Story/ticket writing saved | 20–25 hrs/wk per BA | CogniHubAI ERP case 2025 |
| Auto-ontology accuracy (draft-then-approve) | 96.1% schema docs; +23 F1 FK detection | DBAutoDoc, arXiv 2603.23050 |
| Semantic-layer grounding vs raw NL2SQL | 94.15% exec accuracy (Spider2-snow) | arXiv 2606.31041 |

## Q&A ammo

- "How is this different from a chatbot?" → Ontology grounding (approved definitions, not schema guessing) + provenance trace + action write-back with human gates. Chatbots answer; this operates.
- "What about hallucinated SQL?" → SELECT-only guard, EXPLAIN validation with retry, and the SQL + definitions used are shown, not hidden. Wrong answers are inspectable.
- "Production path?" → Ontology YAML exports to a dbt semantic layer; DuckDB swaps for Databricks SQL; adapters already isolate Jira/Slack. (Roadmap — deliberately not built in 48h.)
- "Why Cerebras?" → gemma-4-31b at extreme inference speed = the board animates in real time, no awkward silence.
