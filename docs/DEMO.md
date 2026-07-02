# Foundry-Lite — Demo Runbook

One-liner for the panel: **"Genie answers questions. Palantir takes action. We built the 1% of both that a BI analyst needs — and our agent builds its own ontology."**

Persona for narration: **Priya, BI analyst.** Monday morning, a new CSV lands, leadership wants answers, tickets need filing. Normally: ~45 min of schema spelunking, SQL, screenshots, Jira. Watch the agent do the loop with Priya only at the approval gates.

## Reset (before EVERY rehearsal and the real run)

Click **Reset** in the topbar (restores baseline ontology + clears runtime events), or from a shell:

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

## The 4 acts (~3.5 min)

**Act 0 — bring your own data (~20s).**
Click **ADD DATA**, pick `products.csv`. The new source node drops onto the canvas live; feed confirms rows/columns. *"No pipeline team, no ticket to data engineering — the board ingests it and the ontology sees it immediately."*

**Act 1 — the agent builds its own ontology (~60s).**
Click **Draft ontology**. Narrate while the board animates: source nodes light up as the agent introspects; deterministic FK inference finds the joins; the LLM names business objects and proposes metrics. Amber rings = proposed, awaiting human. Point at the approval queue: *"Every AI-generated metric definition is gated on a human — that's not a limitation, that's the feature. Palantir charges forward-deployed engineers months for this file."* Approve the metrics live. (**Export** downloads the resulting ontology.yaml — hold it up as the artifact Palantir bills months for.)

**Act 2 — grounded answers with provenance (~60s).**
Click the chip `How many active customers do we have?`
The trace lights the actual path: orders.csv → Order → Active Customer. Show the SQL in the feed + which definition it used: *"No silent guessing between six definitions of 'active customer' — it used THE approved one, and shows its work."*
Then the chip `What's happening with support tickets in the last two weeks?`
Result fires the critical insight (≈3.5x ticket spike, SLA breach rate 4x) — insight node appears red.

**Act 3 — insight becomes action, human approves (~50s).**
The agent drafts a Jira ticket from the insight — action node amber, approval card appears. **Click the action node**: the detail panel opens with the drafted ticket and the full upstream lineage re-illuminates — tickets.csv → Support Ticket → breach metric → insight → this action. *"Every number in this ticket is traceable to a CSV row on this board."* Read the ticket aloud, click **Approve** → `action_pushed` → green. *"Closed loop: raw CSV to approved Jira ticket, every hop visible, human at both gates."*
Timer freezes: **AGENT ~2:40 vs MANUAL 45:00.**

## Insurance

Cerebras down / wifi dead / anything weird → click **Replay**: `demo_events.jsonl` drives the entire board identically, zero LLM calls. Rehearsed and deterministic. (Reset first if the canvas is dirty.)

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
- "Production path?" → Ontology YAML exports to a dbt semantic layer (the Export button is the seam); DuckDB swaps for Databricks SQL; adapters already isolate Jira/Slack. (Roadmap — deliberately not built in 48h.)
- "Why Cerebras?" → gemma-4-31b at extreme inference speed = the board animates in real time, no awkward silence.
- "What if I upload garbage?" → 20MB cap, CSV sniffing, sanitized table names, and nothing enters a query until a human approves the terms that reference it.
