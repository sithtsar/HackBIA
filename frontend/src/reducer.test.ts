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
    // Backend only ever serves insight -> action produces edges from
    // GET /api/state; node_ids -> insight edges are not part of the
    // contract, so the reducer must not derive its own.
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
