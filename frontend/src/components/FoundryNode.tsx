import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { GraphNode } from "../types";
import { NODE_WIDTH, NODE_HEIGHT } from "../layout";
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

const STATUS_COLOR: Record<GraphNode["status"], string> = {
  proposed: "var(--color-pending-amber)",
  approved: "var(--color-committed-green)",
  rejected: "var(--color-text-secondary)",
  neutral: "var(--color-hairline)",
};

const ERROR_RED = "#E5484D";
const AGENT_BLUE = "var(--color-agent-blue)";

/** Insight nodes carry no approval status, so their accent comes from
 * `meta.severity` (set by the `insight` event) instead of `status`. */
function statusColor(data: FoundryNodeData): string {
  if (data.kind === "insight") {
    if (data.meta.severity === "critical") return ERROR_RED;
    if (data.meta.severity === "warning") return "var(--color-pending-amber)";
  }
  return STATUS_COLOR[data.status];
}

export function FoundryNode({ data, isConnectable }: NodeProps<FoundryFlowNode>) {
  const rejected = data.status === "rejected";
  const lit = data.active || data.inPath;
  const accent = statusColor(data);

  // Status lives on a solid left rail rather than a 1px ring around the whole
  // card: at projector/video scale a hairline ring loses its hue entirely,
  // while a rail stays legible and keeps every card the same visual weight.
  const border = lit ? AGENT_BLUE : "var(--color-hairline)";
  const boxShadow = lit ? `0 0 0 1px ${AGENT_BLUE}, 0 0 12px -2px ${AGENT_BLUE}` : "none";

  // Connection handles: subtle, hover-only on connectable (object) nodes;
  // invisible + inert everywhere else (edges still anchor to them).
  const handleClass = isConnectable
    ? "opacity-0 transition-opacity duration-150 group-hover:opacity-100"
    : "opacity-0";
  const handleStyle = isConnectable ? connectableHandleStyle : inertHandleStyle;

  return (
    <div
      className="group relative flex flex-col justify-center overflow-hidden rounded border bg-panel pl-4 pr-3 text-text-primary transition-[box-shadow,border-color,opacity] duration-200"
      style={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        borderColor: border,
        boxShadow,
        opacity: data.dimmed ? 0.3 : 1,
      }}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: accent }}
      />
      <Handle type="target" position={Position.Left} className={handleClass} style={handleStyle} />

      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-text-secondary opacity-80">
          <Glyph kind={data.kind} />
        </span>
        <span
          className="truncate font-mono text-[12.5px] font-medium leading-tight"
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
        className="truncate pl-[22px] pt-1 font-mono text-[10px] leading-tight text-text-secondary"
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
