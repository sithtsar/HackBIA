import { describe, expect, test } from "bun:test";
import { layoutGraph, NODE_WIDTH, NODE_HEIGHT } from "./layout";
import type { GraphEdge, GraphNode } from "./types";

function node(id: string, kind: GraphNode["kind"]): GraphNode {
  return { id, kind, label: id, status: "neutral", meta: {} };
}

describe("layoutGraph (dagre DAG layout)", () => {
  test("all nodes get x/y positions", () => {
    const nodes: GraphNode[] = [
      node("src_orders", "source"),
      node("obj_order", "object"),
      node("m_active", "metric"),
      node("insight_x", "insight"),
      node("act_1", "action"),
    ];
    const edges: GraphEdge[] = [
      { id: "e1", source: "src_orders", target: "obj_order", kind: "feeds" },
      { id: "e2", source: "obj_order", target: "m_active", kind: "derives" },
      { id: "e3", source: "m_active", target: "insight_x", kind: "produces" },
      { id: "e4", source: "insight_x", target: "act_1", kind: "produces" },
    ];

    const positioned = layoutGraph(nodes, edges);
    expect(positioned.length).toBe(5);
    const byId = new Map(positioned.map((n) => [n.id, n]));

    // All nodes have finite x/y
    for (const n of positioned) {
      expect(typeof n.x).toBe("number");
      expect(typeof n.y).toBe("number");
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }

    // source is left of object, which is left of metric (LR rankdir)
    const src = byId.get("src_orders")!;
    const obj = byId.get("obj_order")!;
    const met = byId.get("m_active")!;
    expect(src.x).toBeLessThan(obj.x);
    expect(obj.x).toBeLessThan(met.x);
  });

  test("unconnected nodes still get positioned", () => {
    const nodes: GraphNode[] = [
      node("obj_a", "object"),
      node("m_orphan", "metric"),
    ];
    const edges: GraphEdge[] = [];

    const positioned = layoutGraph(nodes, edges);
    expect(positioned.length).toBe(2);
    for (const n of positioned) {
      expect(typeof n.x).toBe("number");
      expect(typeof n.y).toBe("number");
    }
  });

  test("empty nodes returns empty", () => {
    expect(layoutGraph([], [])).toEqual([]);
  });

  // The whole point of applying the layout to every node: no two cards may
  // occupy the same space. If this passes but the board still shows overlap,
  // the bug is a caller applying only part of the result.
  test("no two nodes overlap", () => {
    const nodes: GraphNode[] = [
      node("src_orders", "source"),
      node("src_customers", "source"),
      node("src_tickets", "source"),
      node("obj_order", "object"),
      node("obj_customer", "object"),
      node("obj_ticket", "object"),
      node("m_a", "metric"),
      node("m_b", "metric"),
      node("insight_x", "insight"),
      node("act_1", "action"),
    ];
    const edges: GraphEdge[] = [
      { id: "e1", source: "src_orders", target: "obj_order", kind: "feeds" },
      { id: "e2", source: "src_customers", target: "obj_customer", kind: "feeds" },
      { id: "e3", source: "src_tickets", target: "obj_ticket", kind: "feeds" },
      { id: "e4", source: "obj_order", target: "m_a", kind: "derives" },
      { id: "e5", source: "obj_customer", target: "m_a", kind: "derives" },
      { id: "e6", source: "obj_ticket", target: "m_b", kind: "derives" },
      { id: "e7", source: "obj_customer", target: "obj_order", kind: "join" },
      { id: "e8", source: "m_a", target: "insight_x", kind: "produces" },
      { id: "e9", source: "m_b", target: "insight_x", kind: "produces" },
      { id: "e10", source: "insight_x", target: "act_1", kind: "produces" },
    ];

    const positioned = layoutGraph(nodes, edges);
    for (let i = 0; i < positioned.length; i++) {
      for (let j = i + 1; j < positioned.length; j++) {
        const a = positioned[i];
        const b = positioned[j];
        const overlaps =
          a.x < b.x + NODE_WIDTH &&
          b.x < a.x + NODE_WIDTH &&
          a.y < b.y + NODE_HEIGHT &&
          b.y < a.y + NODE_HEIGHT;
        expect(`${a.id}/${b.id}:${overlaps}`).toBe(`${a.id}/${b.id}:false`);
      }
    }
  });
});
