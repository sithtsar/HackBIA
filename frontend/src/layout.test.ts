import { describe, expect, test } from "bun:test";
import { columnX, layoutGraph } from "./layout";
import type { GraphEdge, GraphNode } from "./types";

function node(id: string, kind: GraphNode["kind"]): GraphNode {
  return { id, kind, label: id, status: "neutral", meta: {} };
}

describe("layoutGraph (fixed kind-columns)", () => {
  test("every node lands in its kind's column, connected or not", () => {
    const nodes: GraphNode[] = [
      node("src_orders", "source"),
      node("obj_order", "object"),
      node("m_orphan", "metric"), // no edges at all — the old dagre floating-node case
      node("insight_x", "insight"),
      node("act_1", "action"),
    ];
    const edges: GraphEdge[] = [
      { id: "e_feeds_orders", source: "src_orders", target: "obj_order", kind: "feeds" },
    ];

    const positioned = layoutGraph(nodes, edges);
    const byId = new Map(positioned.map((n) => [n.id, n]));

    for (const n of nodes) {
      expect(byId.get(n.id)?.x).toBe(columnX(n.kind));
    }
    // Columns are strictly ordered left -> right.
    expect(columnX("source")).toBeLessThan(columnX("object"));
    expect(columnX("object")).toBeLessThan(columnX("metric"));
    expect(columnX("metric")).toBeLessThan(columnX("insight"));
    expect(columnX("insight")).toBeLessThan(columnX("action"));
  });

  test("within a column, nodes follow the barycenter of their left neighbors", () => {
    const nodes: GraphNode[] = [
      node("src_a", "source"),
      node("src_b", "source"),
      // Input order deliberately inverted relative to their sources:
      node("obj_b", "object"),
      node("obj_a", "object"),
    ];
    const edges: GraphEdge[] = [
      { id: "e1", source: "src_a", target: "obj_a", kind: "feeds" },
      { id: "e2", source: "src_b", target: "obj_b", kind: "feeds" },
    ];

    const byId = new Map(layoutGraph(nodes, edges).map((n) => [n.id, n]));
    const objA = byId.get("obj_a");
    const objB = byId.get("obj_b");
    const srcA = byId.get("src_a");
    const srcB = byId.get("src_b");

    expect(srcA && srcB && srcA.y < srcB.y).toBe(true);
    // obj_a follows src_a to the top row despite coming later in input order.
    expect(objA && objB && objA.y < objB.y).toBe(true);
  });

  test("unconnected nodes stack below connected ones in stable input order", () => {
    const nodes: GraphNode[] = [
      node("obj_a", "object"),
      node("m_orphan_1", "metric"),
      node("m_orphan_2", "metric"),
      node("m_linked", "metric"),
    ];
    const edges: GraphEdge[] = [
      { id: "e1", source: "m_linked", target: "obj_a", kind: "derives" },
    ];

    const byId = new Map(layoutGraph(nodes, edges).map((n) => [n.id, n]));
    const linked = byId.get("m_linked");
    const o1 = byId.get("m_orphan_1");
    const o2 = byId.get("m_orphan_2");

    expect(linked && o1 && linked.y < o1.y).toBe(true);
    expect(o1 && o2 && o1.y < o2.y).toBe(true); // stable order among orphans
    expect(o1?.x).toBe(columnX("metric"));
  });
});
