// Eval harness for the 4 LLM call sites in agents.py. These hit the real
// Cerebras client (BAML test blocks always call the configured client) —
// run with `uv run baml-cli test` before a demo to catch prompt/model drift.
// Not part of the pytest suite (backend/app/agents.py's llm_* seams are
// monkeypatched there instead, per the docstring at the top of agents.py).
// Fixtures below mirror the real seeded schema in backend/app/seed.py
// (customers/orders/tickets) and the planted ticket-spike anomaly.

test DraftOntologyMetricsBasic {
  functions [DraftOntologyMetrics]
  args {
    schema_and_samples #"
      Table customers (id VARCHAR, name VARCHAR, email VARCHAR, signup_date DATE, segment VARCHAR):
        {"id": "cust_0001", "name": "Ana Silva", "email": "ana.silva1@example.com", "signup_date": "2024-11-02", "segment": "enterprise"}
      Table orders (id VARCHAR, customer_id VARCHAR, order_date DATE, amount DOUBLE, status VARCHAR):
        {"id": "ord_00001", "customer_id": "cust_0001", "order_date": "2026-06-20", "amount": 128.50, "status": "completed"}
      Table tickets (id VARCHAR, customer_id VARCHAR, created_date DATE, category VARCHAR, priority VARCHAR, sla_breached BOOLEAN):
        {"id": "tkt_0001", "customer_id": "cust_0001", "created_date": "2026-07-01", "category": "billing", "priority": "high", "sla_breached": true}
    "#
    inferred_joins_json #"[{"from": "orders.customer_id", "to": "customers.id"}, {"from": "tickets.customer_id", "to": "customers.id"}]"#
  }
  // must land in the prompt's stated range, and every metric must at least
  // look like a SELECT over a real table.
  @@assert( {{ this.metrics|length >= 3 and this.metrics|length <= 5 }} )
  @@check( metrics_reference_select, {{ this.metrics|selectattr("sql")|list|length == this.metrics|length }} )
}

test AskQuestionTicketSpike {
  functions [AskQuestion]
  args {
    question "How many tickets were created in the last 14 days?"
    approved_terms_json #"[{"id": "obj_ticket", "kind": "object", "name": "Ticket", "definition": "A ticket record.", "sql": ""}]"#
    schema_and_samples #"
      Table tickets (id VARCHAR, customer_id VARCHAR, created_date DATE, category VARCHAR, priority VARCHAR, sla_breached BOOLEAN):
        {"id": "tkt_0001", "customer_id": "cust_0001", "created_date": "2026-07-01", "category": "billing", "priority": "high", "sla_breached": true}
    "#
    retry_note ""
  }
  @@assert( {{ "select" in this.sql|lower or "with" in this.sql|lower }} )
  @@assert( {{ this.terms_used|length > 0 }} )
}

test DraftActionTicketFromSpike {
  functions [DraftActionTicket]
  args {
    insight_text "Support tickets in the last 14 days (30) are 3.2x the prior 14-day period (9), an emerging SLA-impacting spike."
  }
  @@assert( {{ this.title|length > 0 }} )
  @@assert( {{ this.body|length > 0 }} )
}

test InterpretQueryResultFindsSpike {
  functions [InterpretQueryResult]
  args {
    question "How many tickets in the last 14 days vs the prior 14 days?"
    sql #"SELECT
      (SELECT count(*) FROM tickets WHERE created_date > current_date - 14) AS last14,
      (SELECT count(*) FROM tickets WHERE created_date <= current_date - 14 AND created_date > current_date - 28) AS prior14"#
    result_json #"{"columns": ["last14", "prior14"], "rows": [[30, 9]], "row_count": 1}"#
    terms_used_json #"["obj_ticket"]"#
  }
  @@assert( {{ this.has_insight == true }} )
  @@check( severity_set, {{ this.severity|length > 0 }} )
}

test InterpretQueryResultNoInsightOnRoutineQuery {
  functions [InterpretQueryResult]
  args {
    question "How many customers signed up in the enterprise segment?"
    sql "SELECT count(*) FROM customers WHERE segment = 'enterprise'"
    result_json #"{"columns": ["count"], "rows": [[42]], "row_count": 1}"#
    terms_used_json #"["obj_customer"]"#
  }
  @@assert( {{ this.has_insight == false }} )
}
