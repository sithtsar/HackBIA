import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphEdge, GraphNode } from "../types";
import { layoutGraph, NODE_WIDTH, NODE_HEIGHT } from "../layout";
import { FoundryNode, type FoundryFlowNode } from "./FoundryNode";

const nodeTypes = { foundry: FoundryNode };

type CanvasProps = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  activeNodeIds: ReadonlySet<string>;
  activeEdgeKeys: ReadonlySet<string>;
};

export function Canvas({ nodes, edges, activeNodeIds, activeEdgeKeys }: CanvasProps) {
  // New nodes (from insight/action/ontology_term_proposed events) simply
  // change the `nodes` array reference, which re-runs this full dagre
  // layout — no incremental positioning needed for this board's scale.
  const flowNodes = useMemo<FoundryFlowNode[]>(() => {
    const positioned = layoutGraph(nodes, edges);
    return positioned.map((node) => ({
      id: node.id,
      type: "foundry",
      position: { x: node.x - NODE_WIDTH / 2, y: node.y - NODE_HEIGHT / 2 },
      data: {
        label: node.label,
        kind: node.kind,
        status: node.status,
        meta: node.meta,
        active: activeNodeIds.has(node.id),
      },
    }));
  }, [nodes, edges, activeNodeIds]);

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => {
        const active = activeEdgeKeys.has(`${edge.source}::${edge.target}`);
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          animated: active,
          style: {
            stroke: active ? "var(--color-agent-blue)" : "var(--color-hairline)",
            strokeWidth: active ? 2 : 1,
            strokeDasharray: edge.kind === "join" ? "4 3" : undefined,
          },
        };
      }),
    [edges, activeEdgeKeys],
  );

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      fitView
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
    >
      <Background variant={BackgroundVariant.Dots} color="#2B3444" gap={20} size={1} />
      <Controls showInteractive={false} className="foundry-controls" />
    </ReactFlow>
  );
}
