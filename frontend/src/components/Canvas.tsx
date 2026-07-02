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
};

export function Canvas({ nodes, edges }: CanvasProps) {
  const flowNodes = useMemo<FoundryFlowNode[]>(() => {
    const positioned = layoutGraph(nodes, edges);
    return positioned.map((node) => ({
      id: node.id,
      type: "foundry",
      position: { x: node.x - NODE_WIDTH / 2, y: node.y - NODE_HEIGHT / 2 },
      data: { label: node.label, kind: node.kind, status: node.status },
    }));
  }, [nodes, edges]);

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        style: {
          stroke: "var(--color-hairline)",
          strokeDasharray: edge.kind === "join" ? "4 3" : undefined,
        },
      })),
    [edges],
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
