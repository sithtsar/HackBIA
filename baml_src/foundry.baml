// Foundry-Lite's LLM call sites (backend/app/agents.py). Prompts are
// ported verbatim from the raw-JSON versions that used to live in agents.py's
// _DRAFT_SYSTEM/_ASK_SYSTEM/_ACTION_SYSTEM strings; the old "Return STRICT
// JSON only: {...}" shape spec is now expressed as class fields (with
// @description carrying the old inline hints) and rendered by
// {{ ctx.output_format }} instead of hand-written JSON-shape prose.
// docs/contracts.md is the source of truth for the shapes these feed into
// (OntologyTerm, ActionProposal) — agents.py fills in the fields the LLM
// doesn't produce (kind, status, ids) exactly as before; only the "get one
// validated structured completion" mechanism changed.

// --- Flow 1: ontology draft (metrics) ---------------------------------

class DraftMetric {
  id string @description("snake_case id prefixed with m_, e.g. m_active_customer")
  name string @description("Human Name")
  definition string @description("one sentence")
  sql string @description("SELECT ... valid DuckDB SQL referencing REAL columns only; must be a single SELECT")
  source_tables string[] @description("table names this metric is computed from")
  confidence float @description("0..1")
}

class DraftMetricsResponse {
  metrics DraftMetric[] @description("3-5 useful business metrics")
}

function DraftOntologyMetrics(schema_and_samples: string, inferred_joins_json: string) -> DraftMetricsResponse {
  client Cerebras
  prompt #"
    {{ _.role("system") }}
    You are a BI ontology drafter. Given a DuckDB schema with sample rows and
    inferred table joins, propose 3-5 useful business metrics. Metrics must
    reference columns that exist in the schema.

    {{ _.role("user") }}
    Schema and sample rows:
    {{ schema_and_samples }}

    Inferred joins:
    {{ inferred_joins_json }}

    Propose 3-5 metrics as JSON.

    {{ ctx.output_format }}
  "#
}

// --- Flow 2: ask (NL question -> grounded SQL) -------------------------

class AskResponse {
  sql string @description("SELECT ... a single read-only SELECT (or WITH...SELECT), DuckDB dialect, referencing only real tables/columns")
  terms_used string[] @description("ids of the ontology terms you relied on")
  reasoning_one_line string
}

function AskQuestion(question: string, approved_terms_json: string, schema_and_samples: string, retry_note: string) -> AskResponse {
  client Cerebras
  prompt #"
    {{ _.role("system") }}
    You are a BI query planner. Given a user question, a list of APPROVED
    ontology terms (objects/joins/metrics with their SQL) and the DuckDB
    schema, produce ONE DuckDB SELECT query that answers the question. SQL
    must be a single read-only SELECT (or WITH...SELECT), DuckDB dialect,
    referencing only real tables/columns. terms_used lists the ids of the
    ontology terms you relied on.

    If the question asks about a RATE, SPIKE, SHARE, or which group is the
    biggest "driver" of an outcome, a raw COUNT or SUM GROUP BY is misleading:
    the group with the most occurrences is often just the group with the most
    volume overall, not the one behaving disproportionately. Compute a rate —
    the share of a group's own rows that meet the condition, not the group's
    share of all matching rows — for example:
      COUNT(*) FILTER (WHERE <condition>) * 1.0 / NULLIF(COUNT(*), 0) AS rate
    grouped by the relevant dimension, so each group is compared against its
    own volume. Guard against spurious 100% rates on tiny groups by requiring
    a minimum group size (e.g. HAVING COUNT(*) >= 5) or by also selecting the
    group's row count alongside the rate so the caller can judge reliability.

    {{ _.role("user") }}
    Question: {{ question }}

    Approved ontology terms:
    {{ approved_terms_json }}

    Schema:
    {{ schema_and_samples }}
    {{ retry_note }}

    {{ ctx.output_format }}
  "#
}

// --- Flow 3: action (insight -> Jira ticket proposal) ------------------

class ActionDraftResponse {
  title string @description("short imperative title")
  body string @description("what happened, the evidence numbers, and 'Suggested owner: BI Analyst on-call'")
}

function DraftActionTicket(insight_text: string) -> ActionDraftResponse {
  client Cerebras
  prompt #"
    {{ _.role("system") }}
    You draft a Jira ticket from a BI insight.

    {{ _.role("user") }}
    Insight: {{ insight_text }}

    {{ ctx.output_format }}
  "#
}

// --- Flow 4: insight interpretation (query result -> insight) ----------

class InsightInterpretation {
  has_insight bool
  text string @description("one-sentence insight description; empty if has_insight is false")
  severity string @description("'info', 'warning', or 'critical'; empty if has_insight is false")
  warrants_action bool
  reasoning_one_line string
}

function InterpretQueryResult(question: string, sql: string, result_json: string, terms_used_json: string) -> InsightInterpretation {
  client Cerebras
  prompt #"
    {{ _.role("system") }}
    You are a BI insight interpreter. Given a user question, the SQL used to
    answer it, and the query result, determine if there is an actionable
    insight. Return has_insight=true only when the data reveals a significant
    pattern, anomaly, or opportunity — not for routine queries. When you find
    an insight, set the severity and warrants_action accordingly.

    {{ _.role("user") }}
    Question: {{ question }}
    SQL: {{ sql }}
    Results (JSON): {{ result_json }}
    Terms used: {{ terms_used_json }}

    {{ ctx.output_format }}
  "#
}
