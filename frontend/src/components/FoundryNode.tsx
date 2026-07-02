import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { GraphNode } from "../types";
import { NODE_HEIGHT, NODE_WIDTH } from "../layout";
import { Glyph } from "./Glyph";

export type FoundryNodeData = {
  label: string;
  kind: GraphNode["kind"];
  status: GraphNode["status"];
  meta: GraphNode["meta"];
  /** One-line card description, joined client-side in Canvas (term
   * definition / table name / severity / action body). Never undefined. */
  description: string;
  /** node_touched within the last ~2s (store decays this). */
  active: boolean;
  /** In the selected node's upstream lineage (steady blue, no animation). */
  inPath: boolean;
  /** A selection exists and this node is outside its lineage. */
  dimmed: boolean;
};

export type FoundryFlowNode = Node<FoundryNodeData, "foundry">;

const RING_BY_STATUS: Record<GraphNode["status"], string> = {
  proposed: "var(--color-pending-amber)",
  approved: "var(--color-committed-green)",
  rejected: "var(--color-text-secondary)",
  neutral: "var(--color-hairline)",
};

const ERROR_RED = "#E5484D";

// Same glow for live trace pulse and steady lineage selection, per design
// tokens (motion only for events — `active` animates via transition, `inPath`
// holds steady).
const BLUE_GLOW = "0 0 0 2px var(--color-agent-blue), 0 0 10px 2px var(--color-agent-blue)";

/** Insight nodes carry no approval status, so their ring color comes from
 * `meta.severity` (set by the `insight` event) instead of `status`. */
function ringColor(data: FoundryNodeData): string {
  if (data.kind === "insight") {
    if (data.meta.severity === "critical") return ERROR_RED;
    if (data.meta.severity === "warning") return "var(--color-pending-amber)";
  }
  return RING_BY_STATUS[data.status];
}

export function FoundryNode({ data, isConnectable }: NodeProps<FoundryFlowNode>) {
  const rejected = data.status === "rejected";
  const boxShadow =
    data.active || data.inPath ? BLUE_GLOW : `0 0 0 1px ${ringColor(data)}`;
  // Connection handles: subtle, hover-only on connectable (object) nodes;
  // invisible + inert everywhere else (edges still anchor to them).
  const handleClass = isConnectable
    ? "opacity-0 transition-opacity duration-150 group-hover:opacity-100"
    : "opacity-0";
  const handleStyle = isConnectable ? connectableHandleStyle : inertHandleStyle;

  return (
    <div
      className="group flex flex-col justify-center gap-0.5 rounded bg-panel px-2.5 py-1.5 text-text-primary transition-shadow duration-200"
      style={{ boxShadow, width: NODE_WIDTH, height: NODE_HEIGHT, opacity: data.dimmed ? 0.35 : 1 }}
    >
      <Handle type="target" position={Position.Left} className={handleClass} style={handleStyle} />
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-text-secondary">
          <Glyph kind={data.kind} />
        </span>
        <span
          className="truncate font-mono text-[12px]"
          style={
            rejected
              ? { textDecoration: "line-through", color: "var(--color-text-secondary)" }
              : undefined
          }
          title={data.label}
        >
          {data.label}
        </span>
      </div>
      <div
        className="truncate pl-6 font-mono text-[10px] text-text-secondary"
        title={data.description}
      >
        {data.description}
      </div>
      <Handle type="source" position={Position.Right} className={handleClass} style={handleStyle} />
    </div>
  );
}

const connectableHandleStyle = {
  background: "var(--color-hairline)",
  width: 8,
  height: 8,
  border: "1px solid var(--color-text-secondary)",
} as const;

const inertHandleStyle = {
  background: "var(--color-hairline)",
  width: 6,
  height: 6,
  border: "none",
  pointerEvents: "none",
} as const;
