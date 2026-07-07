import type { GraphEdge, GraphNode } from "./types";
import dagre from "@dagrejs/dagre";

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 60; // two-row card: title + one-line description
export const METRIC_NODE_HEIGHT = 80; // three-row card for metrics with SQL

export type PositionedNode = GraphNode & { x: number; y: number };

function nodeHeight(node: GraphNode): number {
  return node.kind === "metric" || node.kind === "insight" ? METRIC_NODE_HEIGHT : NODE_HEIGHT;
}

/**
 * Pure DAG layout using @dagrejs/dagre with rankdir="LR".
 * Edge topology drives positioning, not kind-columns.
 * Existing positions (from user drags) are preserved; layout only
 * assigns positions to new node ids.
 */
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): PositionedNode[] {
  if (nodes.length === 0) return [];

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80, marginx: 40, marginy: 40 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: nodeHeight(node) });
  }
  for (const edge of edges) {
    if (nodes.some((n) => n.id === edge.source) && nodes.some((n) => n.id === edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const dagNode = g.node(node.id);
    return {
      ...node,
      x: dagNode.x - NODE_WIDTH / 2,
      y: dagNode.y - nodeHeight(node) / 2,
    };
  });
}

/** Legacy columnX — kept for backward compat in Canvas fallback, but no
 * longer used for layout. Returns 0 for all kinds. */
export function columnX(_kind: GraphNode["kind"]): number {
  return 0;
}
