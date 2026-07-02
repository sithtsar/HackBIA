import type { GraphEdge, GraphNode } from "./types";

export type Lineage = { nodeIds: Set<string>; edgeIds: Set<string> };

/**
 * The upstream neighbor of `current` across one edge, or null if this edge
 * doesn't lead upstream from it. Orientation per contracts.md:
 *   feeds    source -> object   : upstream of the object is the source
 *   join     object <-> object  : undirected, either endpoint pulls the other
 *   derives  metric -> object   : upstream of a metric is its object (follow FROM the metric)
 *   produces insight -> action  : upstream of the action is the insight
 * Only actual edges are followed — insight node_ids are not edges, so we never invent them.
 */
function upstreamNeighbor(edge: GraphEdge, current: string): string | null {
  switch (edge.kind) {
    case "feeds":
    case "produces":
      return edge.target === current ? edge.source : null;
    case "derives":
      return edge.source === current ? edge.target : null;
    case "join":
      if (edge.source === current) return edge.target;
      if (edge.target === current) return edge.source;
      return null;
  }
}

/**
 * Full upstream lineage of `nodeId`: the node itself plus every ancestor
 * reachable by walking edges backwards, and the edges on those paths.
 * BFS; the visited-node guard makes join cycles terminate.
 */
export function upstream(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  nodeId: string,
): Lineage {
  const nodeIds = new Set<string>([nodeId]);
  const edgeIds = new Set<string>();
  const queue: string[] = [nodeId];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of graph.edges) {
      const next = upstreamNeighbor(edge, current);
      if (next === null) continue;
      edgeIds.add(edge.id);
      if (!nodeIds.has(next)) {
        nodeIds.add(next);
        queue.push(next);
      }
    }
  }

  return { nodeIds, edgeIds };
}
