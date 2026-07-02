import { describe, expect, test } from "bun:test";
import { reduceBoard } from "./reducer";
import type { BoardState, EventEnvelope } from "./types";

function emptyBoard(): BoardState {
  return { graph: { nodes: [], edges: [] }, terms: [], actions: [], pending: [] };
}

function envelope<T extends EventEnvelope>(partial: T): T {
  return partial;
}

describe("reduceBoard", () => {
  test("ontology_term_proposed upserts the term and adds an amber graph node", () => {
    const board = emptyBoard();
    const e = envelope<EventEnvelope>({
      id: "evt_1",
      ts: "2026-07-03T10:00:00Z",
      run_id: "run_a",
      type: "ontology_term_proposed",
      payload: {
        term: {
          id: "m_churn_risk",
          kind: "metric",
          name: "Churn Risk",
          definition: "def",
          sql: "SELECT 1",
          source_tables: ["orders"],
          confidence: 0.72,
          status: "proposed",
        },
      },
    });

    const next = reduceBoard(board, e);

    expect(next.terms).toHaveLength(1);
    expect(next.terms[0]?.id).toBe("m_churn_risk");
    expect(next.graph.nodes).toHaveLength(1);
    expect(next.graph.nodes[0]).toMatchObject({
      id: "m_churn_risk",
      kind: "metric",
      status: "proposed",
    });
  });

  test("ontology_term_proposed metric adds e_derives edges to existing objects (guarded + deduped)", () => {
    const board: BoardState = {
      graph: {
        nodes: [
          { id: "obj_order", kind: "object", label: "Order", status: "approved", meta: { table: "orders" } },
        ],
        edges: [],
      },
      terms: [],
      actions: [],
      pending: [],
    };
    const e = envelope<EventEnvelope>({
      id: "evt_10",
      ts: "2026-07-03T10:00:00Z",
      run_id: "run_a",
      type: "ontology_term_proposed",
      payload: {
        term: {
          id: "m_churn_risk",
          kind: "metric",
          name: "Churn Risk",
          definition: "def",
          sql: "SELECT 1",
          source_tables: ["orders", "ghost_table"],
          confidence: 0.72,
          status: "proposed",
        },
      },
    });

    const once = reduceBoard(board, e);
    const twice = reduceBoard(once, e); // replay + live can re-emit

    // Same id scheme as backend build_graph: e_derives_<metric_id>_<table>,
    // metric -> object; tables with no object node are skipped.
    expect(once.graph.edges).toHaveLength(1);
    expect(once.graph.edges[0]).toMatchObject({
      id: "e_derives_m_churn_risk_orders",
      source: "m_churn_risk",
      target: "obj_order",
      kind: "derives",
    });
    expect(twice.graph.edges).toHaveLength(1);
  });

  test("ontology_term_proposed join adds a join edge reusing the term id (no node)", () => {
    const board: BoardState = {
      graph: {
        nodes: [
          { id: "obj_order", kind: "object", label: "Order", status: "approved", meta: { table: "orders" } },
          { id: "obj_customer", kind: "object", label: "Customer", status: "approved", meta: { table: "customers" } },
        ],
        edges: [],
      },
      terms: [],
      actions: [],
      pending: [],
    };
    const e = envelope<EventEnvelope>({
      id: "evt_11",
      ts: "2026-07-03T10:00:00Z",
      run_id: "run_a",
      type: "ontology_term_proposed",
      payload: {
        term: {
          id: "join_orders_customers",
          kind: "join",
          name: "Orders → Customers",
          definition: "orders.customer_id = customers.id",
          sql: "orders.customer_id = customers.id",
          source_tables: ["orders", "customers"],
          confidence: 0.9,
          status: "proposed",
        },
      },
    });

    const once = reduceBoard(board, e);
    const twice = reduceBoard(once, e);

    expect(once.terms).toHaveLength(1);
    expect(once.graph.nodes).toHaveLength(2); // joins are edges, never nodes
    expect(once.graph.edges).toHaveLength(1);
    expect(once.graph.edges[0]).toMatchObject({
      id: "join_orders_customers",
      source: "obj_order",
      target: "obj_customer",
      kind: "join",
    });
    expect(twice.graph.edges).toHaveLength(1);
  });

  test("ontology_term_proposed join with a missing object adds the term but no edge", () => {
    const board: BoardState = {
      graph: {
        nodes: [
          { id: "obj_order", kind: "object", label: "Order", status: "approved", meta: { table: "orders" } },
        ],
        edges: [],
      },
      terms: [],
      actions: [],
      pending: [],
    };
    const e = envelope<EventEnvelope>({
      id: "evt_12",
      ts: "2026-07-03T10:00:00Z",
      run_id: "run_a",
      type: "ontology_term_proposed",
      payload: {
        term: {
          id: "join_orders_unknown",
          kind: "join",
          name: "Orders → Unknown",
          definition: "d",
          sql: "s",
          source_tables: ["orders", "unknown"],
          confidence: 0.5,
          status: "proposed",
        },
      },
    });

    const next = reduceBoard(board, e);

    expect(next.terms).toHaveLength(1);
    expect(next.graph.edges).toHaveLength(0);
  });

  test("insight appends an insight node keyed by run_id and adds no edges", () => {
    const board = emptyBoard();
    const e = envelope<EventEnvelope>({
      id: "evt_2",
      ts: "2026-07-03T10:00:01Z",
      run_id: "run_b",
      type: "insight",
      payload: {
        text: "Ticket SLA breach spike",
        severity: "warning",
        node_ids: ["obj_ticket", "m_churn_risk"],
      },
    });

    const next = reduceBoard(board, e);

    expect(next.graph.nodes).toHaveLength(1);
    expect(next.graph.nodes[0]).toMatchObject({
      id: "insight_run_b",
      kind: "insight",
      status: "neutral",
      meta: { severity: "warning" },
    });
    // Evidence edges are only added for node_ids with a matching node on
    // the board (same guard as backend _on_event); this board is empty.
    expect(next.graph.edges).toHaveLength(0);
  });

  test("action_proposed appends an action node and an insight->action produces edge", () => {
    const board = emptyBoard();
    const e = envelope<EventEnvelope>({
      id: "evt_3",
      ts: "2026-07-03T10:00:02Z",
      run_id: "run_b",
      type: "action_proposed",
      payload: {
        action: {
          id: "act_0001",
          kind: "jira",
          title: "Investigate SLA breach spike",
          body: "body",
          insight_ref: "insight_run_b",
          status: "proposed",
        },
      },
    });

    const next = reduceBoard(board, e);

    expect(next.actions).toHaveLength(1);
    expect(next.graph.nodes[0]).toMatchObject({ id: "act_0001", kind: "action", status: "proposed" });
    expect(next.graph.edges[0]).toMatchObject({
      source: "insight_run_b",
      target: "act_0001",
      kind: "produces",
    });
  });

  test("approval_required adds a pending entry (deduped on repeat)", () => {
    const board = emptyBoard();
    const e = envelope<EventEnvelope>({
      id: "evt_4",
      ts: "2026-07-03T10:00:03Z",
      run_id: "",
      type: "approval_required",
      payload: { subject_kind: "action", subject_id: "act_0001" },
    });

    const once = reduceBoard(board, e);
    const twice = reduceBoard(once, e);

    expect(once.pending).toHaveLength(1);
    expect(twice.pending).toHaveLength(1);
  });

  test("approval_resolved flips term status to approved and clears the pending entry", () => {
    const board: BoardState = {
      graph: {
        nodes: [
          { id: "m_churn_risk", kind: "metric", label: "Churn Risk", status: "proposed", meta: {} },
        ],
        edges: [],
      },
      terms: [
        {
          id: "m_churn_risk",
          kind: "metric",
          name: "Churn Risk",
          definition: "def",
          sql: "",
          source_tables: [],
          confidence: 0.72,
          status: "proposed",
        },
      ],
      actions: [],
      pending: [{ subject_kind: "ontology_term", subject_id: "m_churn_risk" }],
    };
    const e = envelope<EventEnvelope>({
      id: "evt_5",
      ts: "2026-07-03T10:00:04Z",
      run_id: "",
      type: "approval_resolved",
      payload: { subject_kind: "ontology_term", subject_id: "m_churn_risk", decision: "approved" },
    });

    const next = reduceBoard(board, e);

    expect(next.pending).toHaveLength(0);
    expect(next.terms[0]?.status).toBe("approved");
    expect(next.graph.nodes[0]?.status).toBe("approved");
  });

  test("node_touched (feed-only event) leaves the board untouched", () => {
    const board = emptyBoard();
    const e = envelope<EventEnvelope>({
      id: "evt_6",
      ts: "2026-07-03T10:00:05Z",
      run_id: "run_a",
      type: "node_touched",
      payload: { node_id: "obj_order" },
    });

    expect(reduceBoard(board, e)).toBe(board);
  });
});
