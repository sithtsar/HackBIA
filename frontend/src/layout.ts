import type { GraphEdge, GraphNode } from "./types";
import dagre from "@dagrejs/dagre";

export const NODE_WIDTH = 240;
/** Every kind uses one card height: glyph+label row, then a description row.
 * Metrics used to get a taller card for an inline SQL preview, but at that
 * size the SQL was truncated to unreadable noise — the full statement lives
 * in the agent feed (sql_generated) and in the detail panel instead. */
export const NODE_HEIGHT = 64;

export type PositionedNode = GraphNode & { x: number; y: number };

/**
 * Pure DAG layout using @dagrejs/dagre with rankdir="LR".
 * Edge topology drives positioning, not kind-columns.
 *
 * This returns positions for EVERY node, and callers must apply all of them.
 * Applying the result to only the new nodes leaves the rest at coordinates
 * from an earlier layout, which is what made agent-added nodes land on top
 * of existing ones.
 */
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): PositionedNode[] {
  if (nodes.length === 0) return [];

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  // Generous separation: this graph is read at a distance (demo video, a
  // projector) far more often than it is read at arm's length.
  g.setGraph({ rankdir: "LR", nodesep: 56, ranksep: 140, marginx: 48, marginy: 48 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
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
      y: dagNode.y - NODE_HEIGHT / 2,
    };
  });
}
