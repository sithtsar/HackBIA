import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { GraphNode } from "../types";
import { Glyph } from "./Glyph";

export type FoundryNodeData = {
  label: string;
  kind: GraphNode["kind"];
  status: GraphNode["status"];
  meta: GraphNode["meta"];
  /** node_touched within the last ~2s (store decays this). */
  active: boolean;
};

export type FoundryFlowNode = Node<FoundryNodeData, "foundry">;

const RING_BY_STATUS: Record<GraphNode["status"], string> = {
  proposed: "var(--color-pending-amber)",
  approved: "var(--color-committed-green)",
  rejected: "var(--color-text-secondary)",
  neutral: "var(--color-hairline)",
};

const ERROR_RED = "#E5484D";

/** Insight nodes carry no approval status, so their ring color comes from
 * `meta.severity` (set by the `insight` event) instead of `status`. */
function ringColor(data: FoundryNodeData): string {
  if (data.kind === "insight") {
    if (data.meta.severity === "critical") return ERROR_RED;
    if (data.meta.severity === "warning") return "var(--color-pending-amber)";
  }
  return RING_BY_STATUS[data.status];
}

export function FoundryNode({ data }: NodeProps<FoundryFlowNode>) {
  const rejected = data.status === "rejected";
  const boxShadow = data.active
    ? "0 0 0 2px var(--color-agent-blue), 0 0 10px 2px var(--color-agent-blue)"
    : `0 0 0 1px ${ringColor(data)}`;

  return (
    <div
      className="flex items-center gap-2 rounded bg-panel px-2.5 py-2 text-text-primary transition-shadow duration-200"
      style={{ boxShadow, width: 200 }}
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
