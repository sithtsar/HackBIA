# Foundry-Lite — Live Demo Runbook

**The pitch in one line:** an agent proposes the ontology, a human approves it, and every
answer traces back to a CSV row. Lead with the gate, not the tech.

Persona for narration: **Priya, BI analyst.** A new CSV lands, leadership wants answers,
tickets need filing. Normally: ~45 minutes of schema spelunking, SQL, screenshots, Jira.
Watch the agent do the loop with Priya only at the approval gates.

## Reset (before EVERY rehearsal and the real run)

Click **Reset** in the topbar (rebuilds `foundry.duckdb`, restores the baseline
`ontology.yaml`, clears runtime graph/actions/pending, truncates `events.jsonl`) — or from
a shell, same effect, and the only way to also switch domains:

```bash
curl -sX POST localhost:8420/api/demo/reset -H 'Content-Type: application/json' -d '{}'
# switch domains in the same call:
curl -sX POST localhost:8420/api/demo/reset -H 'Content-Type: application/json' -d '{"scenario":"supply"}'
```

## Boot (one process, board + API together)

```bash
cd frontend && bun install && bun run build
cd .. && source .venv/bin/activate && uv run uvicorn backend.app.main:app --port 8420
```

Open **http://localhost:8420/** — status dot green = SSE connected. There is no separate
Vite dev server to start; the backend serves the built board at `/`.

## The 5 acts (~4 min, Act 4 is the one to cut first if you're short on time)

**Act 0 — bring your own data (~20s).**
Click **Add data**, pick `backend/data/upload_demo/employees.csv` (an HR pack the ontology
has never seen — untouched by any scenario). The new source table shows up in the feed with
its row/column counts.
*"No pipeline team, no ticket to data engineering — the board ingests it and the ontology
sees it immediately."*
Click **Reset** afterward to clear it back out before Act 1 (it isn't part of the retail
story).

**Act 1 — the agent drafts an ontology (~45s).**
Click **Draft ontology**. Narrate while the board animates: the agent introspects
`customers`/`orders`/`tickets`, infers the FK joins, names the business objects, and
proposes a metric. *"Amber means proposed. Nothing here is committed yet — the agent doesn't
get to decide what a customer is."*

**Act 2 — a human approves, and refuses (~45s). This is the whole pitch.**
Open the **Approvals** panel. Approve `Customer`, `Order`, `Ticket` one at a time (amber →
green, watch the graph light up). Then hit **Reject** on the `active_customer` metric and say
why out loud: *"We don't need this one for the question we're about to ask, and I'm not
committing a definition just because the agent proposed it. Approve is not a formality —
reject is a real button and it does something."* The rejected term stays gray/rejected on
the graph; the ask in Act 3 will run fine without it.

**Act 3 — ask a question, only against approved terms (~45s).**
Type or click the question chip **"Why did support tickets spike recently?"**. Point at the
feed: the generated SQL is visible, and the lineage path lights up `tickets.csv → Ticket →
insight`. Read the number off the insight card: *"Ticket volume up roughly 3x, SLA breach
rate 10% to 40%, in the trailing 14 days — and it only used definitions we just approved. It
didn't touch `active_customer` because we rejected it."*

**Act 4 — insight becomes a drafted Jira ticket, human approves (~35s).**
Click **Draft action** on the insight node. Action node appears amber with a drafted ticket
body. Open it, read a line or two aloud, click **Approve** in the Approvals panel →
`action_pushed` → green. *"Every number in this ticket traces back to a CSV row, and it only
shipped because a human clicked approve."*

**Act 5 — switch domains live, prove it isn't hardcoded (~50s, optional if time is tight).**
In a terminal: `curl -sX POST localhost:8420/api/demo/reset -H 'Content-Type: application/json' -d '{"scenario":"supply"}'`.
The board clears to a schema the agent has never seen (`suppliers`/`shipments`/`delays`).
Click **Draft ontology** again, approve the terms, then ask **"Which supplier is driving our
late deliveries?"**. *"One supplier's late-delivery rate goes from 12% baseline to 65% in the
last 14 days — invisible in the aggregate, only visible once you group by supplier. Same
board, same gate, a schema it has never seen before."* (Fintech scenario tells the same story
with `mobile_wallet` chargebacks going 0.9% to 11% — swap `"scenario":"supply"` for
`"scenario":"fintech"` if asked for a second domain.)

Close on: *"Every number on this board traces back to a CSV row. Amber waits on a human,
green means someone signed off."*

## Fallbacks (assume a nervous presenter and a flaky conference network)

- **LLM stalls or Cerebras is down, retail act:** click **Replay** instead of Draft
  ontology/Ask. `demo_events.jsonl` drives the whole retail board (ontology, ask, insight,
  action all fire) deterministically with zero LLM calls. Click **Reset** first if the canvas
  is dirty. Then do the approvals (and the one reject) live yourself, same as Act 2 above —
  the replay log doesn't include approvals, so the gate demo still happens live either way.
- **LLM stalls during Act 5 (supply/fintech):** there is no replay log for these — replay
  only exists for retail. Skip Act 5 and close on Act 4 instead, or narrate over
  `video/raw/supply.webm` / `video/raw/fintech.webm` if the recorded video is cued up on a
  second screen.
- **Upload fails in Act 0 (bad file, wifi drops mid-request):** skip straight to Act 1 on the
  pre-seeded retail scenario — Act 0 is a nice-to-have, not load-bearing for the rest of the
  script.
- **Board looks stale / stuck mid-approval:** click **Reset**, wait for the `status` toast,
  restart the current act. Never leave two acts' state mixed on screen.
- **Totally dead (server crashed, port conflict):** `lsof -ti:8420 | xargs kill`, then re-run
  the Boot commands above. If the frontend build is stale, `cd frontend && bun run build`
  before restarting uvicorn — it serves whatever is already in `frontend/dist`.

## Metrics slide (sources verified 2026-07-03)

| Claim | Number | Source |
|---|---|---|
| Analyst time on busywork | 78% of week; $21.6k/yr/analyst | dbt Labs + Harris Poll 2025 (N=510) |
| Routine BA work automatable w/ AI | 42% time savings | LeverX 2026 field study |
| Story/ticket writing saved | 20-25 hrs/wk per BA | CogniHubAI ERP case 2025 |
| Auto-ontology accuracy (draft-then-approve) | 96.1% schema docs; +23 F1 FK detection | DBAutoDoc, arXiv 2603.23050 |
| Semantic-layer grounding vs raw NL2SQL | 94.15% exec accuracy (Spider2-snow) | arXiv 2606.31041 |

## Q&A ammo

- "How is this different from a chatbot?" → Ontology grounding (approved definitions, not
  schema guessing) plus a provenance trace plus action write-back with human gates at both
  the ontology and the action. Chatbots answer; this operates.
- "What about hallucinated SQL?" → SELECT-only guard, EXPLAIN validation with retry, and the
  SQL plus the definitions it used are shown on the node cards, not hidden. Wrong answers are
  inspectable.
- "What did I just see get rejected?" → `active_customer`, on purpose, to show reject is a
  real path and not just a demo formality. The ask in Act 3 still ran fine without it.
- "How is the insight found?" → The LLM interprets actual query results against the
  question asked, not a hardcoded ticket-spike rule. Any question can yield an insight if the
  data supports it — supply and fintech hide their anomaly inside one segment, so it only
  surfaces once the agent groups by the right dimension.
- "Production path?" → Ontology YAML exports to a dbt semantic layer (the Export button is
  the seam); DuckDB swaps for Databricks SQL; adapters already isolate Jira. (Roadmap,
  deliberately not built in 48h.)
- "Why Cerebras?" → gemma-4-31b at extreme inference speed means the board animates in real
  time, no awkward silence waiting on the LLM.
- "What if I upload garbage?" → 20MB cap, CSV sniffing, sanitized table names, and nothing
  enters a query until a human approves the terms that reference it.
- "Multiple investigations?" → The workflow switcher in the topbar opens separate
  investigation threads, each with its own ask/insight/action chain, sharing one ontology.
