import { describe, expect, test } from "bun:test";
import { upstream } from "./lineage";
import type { GraphEdge, GraphNode } from "./types";

// sources -> objects (feeds), object <-> object (join), metric -> object
// (derives), insight -> action (produces).
const nodes: GraphNode[] = [
  { id: "customers", kind: "source", label: "customers", status: "neutral", meta: {} },
  { id: "orders", kind: "source", label: "orders", status: "neutral", meta: {} },
  { id: "obj_customer", kind: "object", label: "Customer", status: "approved", meta: {} },
  { id: "obj_order", kind: "object", label: "Order", status: "approved", meta: {} },
  { id: "m_active", kind: "metric", label: "Active Customer", status: "approved", meta: {} },
  { id: "insight_1", kind: "insight", label: "spike", status: "neutral", meta: {} },
  { id: "act_1", kind: "action", label: "File ticket", status: "proposed", meta: {} },
];
const edges: GraphEdge[] = [
  { id: "e_feeds_customers", source: "customers", target: "obj_customer", kind: "feeds" },
  { id: "e_feeds_orders", source: "orders", target: "obj_order", kind: "feeds" },
  { id: "e_join", source: "obj_order", target: "obj_customer", kind: "join" },
  { id: "e_derives", source: "m_active", target: "obj_order", kind: "derives" },
  { id: "e_produces", source: "insight_1", target: "act_1", kind: "produces" },
];
const graph = { nodes, edges };

describe("upstream", () => {
  test("metric walks derives -> object -> (join sibling + feeds sources), includes itself", () => {
    const { nodeIds, edgeIds } = upstream(graph, "m_active");
    // m_active -> obj_order (derives), obj_order <-> obj_customer (join),
    // obj_order <- orders (feeds), obj_customer <- customers (feeds).
    expect([...nodeIds].sort()).toEqual(
      ["customers", "m_active", "obj_customer", "obj_order", "orders"].sort(),
    );
    expect(edgeIds.has("e_derives")).toBe(true);
    expect(edgeIds.has("e_join")).toBe(true);
    expect(edgeIds.has("e_feeds_orders")).toBe(true);
    expect(edgeIds.has("e_feeds_customers")).toBe(true);
    // Never pulls the downstream produces edge.
    expect(edgeIds.has("e_produces")).toBe(false);
  });

  test("source node has no upstream but includes itself", () => {
    const { nodeIds, edgeIds } = upstream(graph, "customers");
    expect([...nodeIds]).toEqual(["customers"]);
    expect(edgeIds.size).toBe(0);
  });

  test("action walks produces edge back to its insight", () => {
    const { nodeIds, edgeIds } = upstream(graph, "act_1");
    expect([...nodeIds].sort()).toEqual(["act_1", "insight_1"]);
    expect(edgeIds.has("e_produces")).toBe(true);
  });
});
