import { useCallback, useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  useReactFlow,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphEdge, GraphNode } from "../types";
import { layoutGraph, NODE_WIDTH, NODE_HEIGHT } from "../layout";
import { upstream } from "../lineage";
import { FoundryNode, type FoundryFlowNode } from "./FoundryNode";

const nodeTypes = { foundry: FoundryNode };

// Steady blue illumination for the selected node's upstream path — same glow
// as the live trace pulse (FoundryNode's active box-shadow) but no animation,
// per design tokens (motion is only for events).
const SELECT_GLOW = "0 0 0 2px var(--color-agent-blue), 0 0 10px 2px var(--color-agent-blue)";
const DIMMED = 0.35;

type CanvasProps = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  activeNodeIds: ReadonlySet<string>;
  activeEdgeKeys: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
};

/**
 * The `fitView` prop on <ReactFlow> only fits to the nodes it was mounted
 * with (per xyflow docs: "initially provided"). Every SSE event re-runs
 * dagre and can shift/add node positions, so without this the viewport
 * silently drifts out of sync with where nodes actually are — new (or
 * reflowed) nodes render fully off-screen with no error. Re-fitting here
 * on every nodes/edges change, instead of once per event type in the
 * reducer, keeps the whole graph on screen no matter which event caused it.
 */
function FitViewOnDataChange({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    fitView();
  }, [nodes, edges, fitView]);
  return null;
}

export function Canvas({
  nodes,
  edges,
  activeNodeIds,
  activeEdgeKeys,
  selectedId,
  onSelect,
}: CanvasProps) {
  // Upstream lineage of the selection; empty sets when nothing is selected.
  const lineage = useMemo(
    () => (selectedId === null ? null : upstream({ nodes, edges }, selectedId)),
    [selectedId, nodes, edges],
  );

  // New nodes (from insight/action/ontology_term_proposed events) simply
  // change the `nodes` array reference, which re-runs this full dagre
  // layout — no incremental positioning needed for this board's scale.
  const flowNodes = useMemo<FoundryFlowNode[]>(() => {
    const positioned = layoutGraph(nodes, edges);
    return positioned.map((node) => {
      const inPath = lineage?.nodeIds.has(node.id) ?? false;
      const dimmed = lineage !== null && !inPath;
      return {
        id: node.id,
        type: "foundry",
        position: { x: node.x - NODE_WIDTH / 2, y: node.y - NODE_HEIGHT / 2 },
        style: inPath
          ? { boxShadow: SELECT_GLOW, borderRadius: 4 }
          : dimmed
            ? { opacity: DIMMED }
            : undefined,
        data: {
          label: node.label,
          kind: node.kind,
          status: node.status,
          meta: node.meta,
          active: activeNodeIds.has(node.id),
        },
      };
    });
  }, [nodes, edges, activeNodeIds, lineage]);

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => {
        const active = activeEdgeKeys.has(`${edge.source}::${edge.target}`);
        const inPath = lineage?.edgeIds.has(edge.id) ?? false;
        const dimmed = lineage !== null && !inPath;
        const highlighted = active || inPath;
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          animated: active, // motion only for live events, never for steady selection
          style: {
            stroke: highlighted ? "var(--color-agent-blue)" : "var(--color-hairline)",
            strokeWidth: highlighted ? 2 : 1,
            strokeDasharray: edge.kind === "join" ? "4 3" : undefined,
            opacity: dimmed ? DIMMED : 1,
          },
        };
      }),
    [edges, activeEdgeKeys, lineage],
  );

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => onSelect(node.id),
    [onSelect],
  );
  const onPaneClick = useCallback(() => onSelect(null), [onSelect]);

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      fitView
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
    >
      <Background variant={BackgroundVariant.Dots} color="#2B3444" gap={20} size={1} />
      <Controls showInteractive={false} className="foundry-controls" />
      <FitViewOnDataChange nodes={nodes} edges={edges} />
    </ReactFlow>
  );
}
