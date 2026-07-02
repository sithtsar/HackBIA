import type { GraphEdge, GraphNode } from "./types";

export const KIND_RANK: Record<GraphNode["kind"], number> = {
  source: 0,
  object: 1,
  metric: 2,
  insight: 3,
  action: 4,
};

export const COLUMN_ORDER: readonly GraphNode["kind"][] = [
  "source",
  "object",
  "metric",
  "insight",
  "action",
];

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 60; // two-row card: title + one-line description
const COLUMN_GUTTER = 120;
const ROW_GAP = 28;

const COL_PITCH = NODE_WIDTH + COLUMN_GUTTER;
const ROW_PITCH = NODE_HEIGHT + ROW_GAP;

/** x center of a kind's fixed column. */
export function columnX(kind: GraphNode["kind"]): number {
  return KIND_RANK[kind] * COL_PITCH;
}

export type PositionedNode = GraphNode & { x: number; y: number };

// Nodes with no already-placed left-column neighbor sink to the bottom of
// their column in stable input order (finite so the sort comparator never
// yields NaN).
const UNRANKED = Number.MAX_SAFE_INTEGER;

/**
 * Fixed kind-columns layout: SOURCE | OBJECT | METRIC | INSIGHT | ACTION.
 * Every node lands in its kind's column whether or not it has edges — a
 * proposed metric awaiting approval still stacks in METRIC instead of
 * floating at a dagre rank-0 spot. Within a column, nodes are ordered by
 * the barycenter (mean y) of their already-placed neighbors in columns to
 * the left, which keeps edges roughly horizontal.
 * ponytail: one left-to-right barycenter pass, not dagre — upgrade to
 * per-column crossing minimization only if boards get dense enough to tangle.
 */
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): PositionedNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Undirected adjacency: contract edges point both ways relative to the
  // visual order (e.g. `derives` is metric -> object).
  const neighbors = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const list = neighbors.get(a);
    if (list) list.push(b);
    else neighbors.set(a, [b]);
  };
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }

  const placedY = new Map<string, number>();
  const out: PositionedNode[] = [];

  for (const kind of COLUMN_ORDER) {
    const column = nodes.filter((n) => n.kind === kind);
    const rank = KIND_RANK[kind];

    const barycenter = new Map<string, number>();
    for (const node of column) {
      const leftYs = (neighbors.get(node.id) ?? [])
        .filter((id) => {
          const nb = byId.get(id);
          return nb !== undefined && KIND_RANK[nb.kind] < rank && placedY.has(id);
        })
        .map((id) => placedY.get(id) ?? 0);
      barycenter.set(
        node.id,
        leftYs.length > 0 ? leftYs.reduce((a, b) => a + b, 0) / leftYs.length : UNRANKED,
      );
    }

    // Array.prototype.sort is stable: ties (and unconnected nodes) keep input order.
    const ordered = [...column].sort(
      (a, b) => (barycenter.get(a.id) ?? UNRANKED) - (barycenter.get(b.id) ?? UNRANKED),
    );
    ordered.forEach((node, row) => {
      const y = row * ROW_PITCH;
      placedY.set(node.id, y);
      out.push({ ...node, x: columnX(kind), y });
    });
  }

  return out;
}
