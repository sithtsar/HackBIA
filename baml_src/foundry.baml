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

// --- Flow 1b: ask suggestions (data-driven prompt chips) ----------------

class SuggestQuestionsResponse {
  questions string[] @description("3-5 short, concrete questions a business user could ask about THIS data — reference real object/metric names, not generic BI cliches")
}

function SuggestAskQuestions(approved_terms_json: string, schema_and_samples: string) -> SuggestQuestionsResponse {
  client Cerebras
  prompt #"
    {{ _.role("system") }}
    You are a BI copilot suggesting what a user could ask next. Given the
    APPROVED ontology terms (objects/joins/metrics) and the DuckDB schema
    with sample rows, propose 3-5 short natural-language questions this data
    can actually answer. Ground them in the real table/column names and
    values you see — no generic placeholders.

    {{ _.role("user") }}
    Approved ontology terms:
    {{ approved_terms_json }}

    Schema and sample rows:
    {{ schema_and_samples }}

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
  text string @description("direct one-to-two sentence answer to the user's question, grounded in the query result — always filled in, regardless of has_insight")
  severity string @description("'info' for a routine answer; 'warning' or 'critical' only when has_insight is true and the pattern is concerning")
  warrants_action bool
  reasoning_one_line string
}

function InterpretQueryResult(question: string, sql: string, result_json: string, terms_used_json: string) -> InsightInterpretation {
  client Cerebras
  prompt #"
    {{ _.role("system") }}
    You are a BI analyst. Given a user question, the SQL used to answer it,
    and the query result, ALWAYS write a direct one-to-two sentence answer to
    the question in `text`, citing the actual numbers from the result — this
    is what the user sees as the answer to what they asked, so never leave it
    empty. Separately, set has_insight=true only when the data ALSO reveals a
    significant pattern, anomaly, or opportunity beyond just answering the
    question — not for routine queries. When has_insight is true, set
    severity to 'warning' or 'critical' and warrants_action accordingly;
    otherwise severity is 'info' and warrants_action is false.

    {{ _.role("user") }}
    Question: {{ question }}
    SQL: {{ sql }}
    Results (JSON): {{ result_json }}
    Terms used: {{ terms_used_json }}

    {{ ctx.output_format }}
  "#
}
