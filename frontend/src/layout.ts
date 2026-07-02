import dagre from "@dagrejs/dagre";
import type { GraphEdge, GraphNode } from "./types";

const KIND_RANK: Record<GraphNode["kind"], number> = {
  source: 0,
  object: 1,
  metric: 2,
  insight: 3,
  action: 4,
};

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 52;

export type PositionedNode = GraphNode & { x: number; y: number };

/**
 * Lays out nodes left-to-right: sources -> objects -> metrics -> insights ->
 * actions, per contracts.md.
 *
 * ponytail: dagre ranks nodes by following edge direction, but contracts.md
 * defines "derives" edges as metric -> object (i.e. backwards relative to
 * the desired visual order). Rather than special-casing edge kinds, every
 * edge is fed to dagre pointing from the lower-KIND_RANK node to the
 * higher-KIND_RANK one for layout purposes only; the real edge direction
 * (used for rendering/arrows) is untouched.
 */
export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): PositionedNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 100 });
  g.setDefaultEdgeLabel(() => ({}));

  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const edge of edges) {
    const sourceNode = byId.get(edge.source);
    const targetNode = byId.get(edge.target);
    if (!sourceNode || !targetNode) continue;
    const forward = KIND_RANK[sourceNode.kind] <= KIND_RANK[targetNode.kind];
    const from = forward ? edge.source : edge.target;
    const to = forward ? edge.target : edge.source;
    g.setEdge(from, to);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id) as { x: number; y: number } | undefined;
    return { ...node, x: pos?.x ?? 0, y: pos?.y ?? 0 };
  });
}
