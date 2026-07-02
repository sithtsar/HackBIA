import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { GraphNode } from "../types";
import { Glyph } from "./Glyph";

export type FoundryNodeData = {
  label: string;
  kind: GraphNode["kind"];
  status: GraphNode["status"];
};

export type FoundryFlowNode = Node<FoundryNodeData, "foundry">;

const RING_BY_STATUS: Record<GraphNode["status"], string> = {
  proposed: "var(--color-pending-amber)",
  approved: "var(--color-committed-green)",
  rejected: "var(--color-text-secondary)",
  neutral: "var(--color-hairline)",
};

export function FoundryNode({ data }: NodeProps<FoundryFlowNode>) {
  const ringColor = RING_BY_STATUS[data.status];
  const rejected = data.status === "rejected";

  return (
    <div
      className="flex items-center gap-2 rounded bg-panel px-2.5 py-2 text-text-primary"
      style={{ boxShadow: `0 0 0 1px ${ringColor}`, width: 200 }}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <span className="shrink-0 text-text-secondary">
        <Glyph kind={data.kind} />
      </span>
      <span
        className="truncate font-mono text-[12px]"
        style={rejected ? { textDecoration: "line-through", color: "var(--color-text-secondary)" } : undefined}
        title={data.label}
      >
        {data.label}
      </span>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
}

const handleStyle = {
  background: "var(--color-hairline)",
  width: 6,
  height: 6,
  border: "none",
};
