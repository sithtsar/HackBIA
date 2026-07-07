import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Panel,
  useNodesState,
  useReactFlow,
  useStoreApi,
  type Connection,
  type Edge,
  type IsValidConnection,
  type NodeMouseHandler,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { ActionProposal, GraphEdge, GraphNode, OntologyTerm } from "../types";
import { layoutGraph, NODE_WIDTH, NODE_HEIGHT } from "../layout";
import { upstream } from "../lineage";
import { postOntologyJoin } from "../api";
import { useStore } from "../store";
import { FoundryNode, type FoundryFlowNode, type FoundryNodeData } from "./FoundryNode";

const nodeTypes = { foundry: FoundryNode };

const DIMMED = 0.35;

type CanvasProps = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  activeNodeIds: ReadonlySet<string>;
  activeEdgeKeys: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
};

/** One-line card description, joined client-side (no backend field):
 * metric/object node id == OntologyTerm id, action id == ActionProposal id.
 * For metrics, prefers meta.sql for inline provenance display. */
function describeNode(
  node: GraphNode,
  termDefById: ReadonlyMap<string, string>,
  actionsById: ReadonlyMap<string, ActionProposal>,
): string {
  switch (node.kind) {
    case "source":
      return node.meta.table ?? "";
    case "object":
      return node.meta.definition ?? termDefById.get(node.id) ?? "";
    case "metric":
      return node.meta.definition ?? termDefById.get(node.id) ?? "";
    case "insight":
      return node.meta.severity ?? "";
    case "action":
      return actionsById.get(node.id)?.body.split("\n")[0] ?? "";
  }
}

function LegendDot({ color }: { color: string }) {
  return (
    <span
      className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
      style={{ background: color }}
    />
  );
}

function LegendLine({ dashed }: { dashed: boolean }) {
  return (
    <span
      className="mr-1.5 inline-block w-4 align-middle"
      style={{ borderTop: `1px ${dashed ? "dashed" : "solid"} var(--color-text-secondary)` }}
    />
  );
}

function Legend() {
  return (
    <Panel position="bottom-left">
      <div className="rounded border border-hairline bg-panel px-2.5 py-2 font-mono text-[10px] leading-[18px] text-text-secondary">
        <div>
          <LegendDot color="var(--color-pending-amber)" /> proposed
        </div>
        <div>
          <LegendDot color="var(--color-committed-green)" /> approved
        </div>
        <div>
          <LegendDot color="var(--color-agent-blue)" /> live activity
        </div>
        <div>
          <LegendLine dashed /> join
        </div>
        <div>
          <LegendLine dashed={false} /> data flow
        </div>
      </div>
    </Panel>
  );
}

/**
 * Calm-viewport helper: the camera never moves on its own. When new nodes
 * appear (count increase) and any of them is not fully inside the current
 * viewport, show a "N new · fit view" chip instead of auto-fitting; the
 * user fits explicitly by clicking it (or via the Controls fit button).
 */
function NewNodesChip({ flowNodes }: { flowNodes: FoundryFlowNode[] }) {
  const { fitView } = useReactFlow();
  const storeApi = useStoreApi();
  const prevIds = useRef<ReadonlySet<string> | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    const ids = new Set(flowNodes.map((n) => n.id));
    const prev = prevIds.current;
    prevIds.current = ids;
    // Mount + first data population (store starts empty until GET /api/state
    // resolves) are covered by the fitView prop, not the chip.
    if (prev === null || prev.size === 0) return;
    const fresh = flowNodes.filter((n) => !prev.has(n.id));
    if (fresh.length === 0) return;
    const { width, height, transform } = storeApi.getState();
    const [tx, ty, zoom] = transform;
    const anyOffscreen = fresh.some((n) => {
      const left = n.position.x * zoom + tx;
      const top = n.position.y * zoom + ty;
      return (
        left < 0 ||
        top < 0 ||
        left + NODE_WIDTH * zoom > width ||
        top + NODE_HEIGHT * zoom > height
      );
    });
    // ponytail: chip clears only on its own click; a manual pan that reveals
    // the nodes leaves it up until clicked — add viewport-change dismissal
    // if that ever annoys anyone.
    if (anyOffscreen) setCount((c) => c + fresh.length);
  }, [flowNodes, storeApi]);

  if (count === 0) return null;
  return (
    <Panel position="bottom-center">
      <button
        type="button"
        onClick={() => {
          void fitView({ padding: 0.15, duration: 250 }); // motion on user gesture only
          setCount(0);
        }}
        className="rounded border border-hairline bg-panel px-2.5 py-1 font-mono text-[11px] text-text-secondary hover:text-text-primary"
      >
        {count} new · fit view
      </button>
    </Panel>
  );
}

/** Lets the command palette's "Fit view" reach the React Flow instance
 * without prop-drilling across the app (palette lives in the Topbar). */
function FitOnEvent() {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const onFit = (): void => {
      void fitView({ padding: 0.15, duration: 250 }); // user gesture, motion ok
    };
    window.addEventListener("foundry:fit", onFit);
    return () => window.removeEventListener("foundry:fit", onFit);
  }, [fitView]);
  return null;
}

function sameCardData(a: FoundryNodeData, b: FoundryNodeData): boolean {
  return (
    a.label === b.label &&
    a.status === b.status &&
    a.description === b.description &&
    a.meta === b.meta
  );
}

export function Canvas({
  nodes,
  edges,
  activeNodeIds,
  activeEdgeKeys,
  selectedId,
  onSelect,
}: CanvasProps) {
  const { pushToast, state } = useStore();
  const { terms, actions } = state;

  // React Flow owns node objects (positions included): drags flow through
  // onNodesChange/applyNodeChanges into this state and never re-run layout
  // or rebuild the array — moving one node re-renders only that node.
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<FoundryFlowNode>([]);

  // Reconcile board -> flow nodes. Layout runs on new ids only via dagre.
  useEffect(() => {
    const termDefById = new Map(terms.map((t: OntologyTerm) => [t.id, t.definition]));
    const actionsById = new Map(actions.map((a) => [a.id, a]));
    setFlowNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      const hasNew = nodes.some((n) => !prevById.has(n.id));
      const autoPos = hasNew
        ? new Map(
            layoutGraph(nodes, edges).map((n) => [
              n.id,
              { x: n.x, y: n.y },
            ]),
          )
        : null;
      return nodes.map((node): FoundryFlowNode => {
        const card: FoundryNodeData = {
          label: node.label,
          kind: node.kind,
          status: node.status,
          meta: node.meta,
          description: describeNode(node, termDefById, actionsById),
          active: false,
          inPath: false,
          dimmed: false,
        };
        const existing = prevById.get(node.id);
        if (existing) {
          // Position untouched; keep the same object ref when nothing
          // changed so React Flow skips re-rendering the node.
          if (sameCardData(existing.data, card)) return existing;
          return {
            ...existing,
            data: {
              ...card,
              active: existing.data.active,
              inPath: existing.data.inPath,
              dimmed: existing.data.dimmed,
            },
          };
        }
        return {
          id: node.id,
          type: "foundry",
          position: autoPos?.get(node.id) ?? { x: 0, y: 0 },
          connectable: node.kind === "object", // drag-to-connect joins are object->object only
          data: card,
        };
      });
    });
  }, [nodes, edges, terms, actions, setFlowNodes]);

  // Upstream lineage of the selection; null when nothing is selected.
  const lineage = useMemo(
    () => (selectedId === null ? null : upstream({ nodes, edges }, selectedId)),
    [selectedId, nodes, edges],
  );

  // Live-trace glow + selection lineage are data-only updates (no position,
  // no layout); unchanged nodes keep their object ref and don't re-render.
  useEffect(() => {
    setFlowNodes((prev) =>
      prev.map((n) => {
        const active = activeNodeIds.has(n.id);
        const inPath = lineage?.nodeIds.has(n.id) ?? false;
        const dimmed = lineage !== null && !inPath;
        if (n.data.active === active && n.data.inPath === inPath && n.data.dimmed === dimmed) {
          return n;
        }
        return { ...n, data: { ...n.data, active, inPath, dimmed } };
      }),
    );
  }, [activeNodeIds, lineage, setFlowNodes]);

  // Join edges reuse their term's id (backend convention), so a proposed
  // join renders pending-amber until approved.
  const termStatusById = useMemo(() => new Map(terms.map((t) => [t.id, t.status])), [terms]);

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => {
        const active = activeEdgeKeys.has(`${edge.source}::${edge.target}`);
        const inPath = lineage?.edgeIds.has(edge.id) ?? false;
        const dimmed = lineage !== null && !inPath;
        const highlighted = active || inPath;
        const pendingJoin = edge.kind === "join" && termStatusById.get(edge.id) === "proposed";
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          animated: active, // motion only for live events, never for steady selection
          style: {
            stroke: highlighted
              ? "var(--color-agent-blue)"
              : pendingJoin
                ? "var(--color-pending-amber)"
                : "var(--color-hairline)",
            strokeWidth: highlighted ? 2 : 1,
            strokeDasharray: edge.kind === "join" ? "4 3" : undefined,
            opacity: dimmed ? DIMMED : 1,
          },
        };
      }),
    [edges, activeEdgeKeys, lineage, termStatusById],
  );

  const kindById = useMemo(() => new Map(nodes.map((n) => [n.id, n.kind])), [nodes]);

  const isValidConnection = useCallback<IsValidConnection<Edge>>(
    (conn: Edge | Connection) =>
      conn.source !== conn.target &&
      kindById.get(conn.source) === "object" &&
      kindById.get(conn.target) === "object",
    [kindById],
  );

  const onConnect = useCallback<OnConnect>(
    (conn) => {
      if (kindById.get(conn.source) !== "object" || kindById.get(conn.target) !== "object") return;
      void postOntologyJoin(conn.source, conn.target)
        .then(() => pushToast("join proposed — see approvals", "success"))
        .catch((err: unknown) =>
          pushToast(err instanceof Error ? err.message : String(err), "error"),
        );
    },
    [kindById, pushToast],
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
      onNodesChange={onNodesChange}
      elementsSelectable={false}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      fitView // initial mount only; afterwards the camera moves solely on user gestures
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
    >
      <Background variant={BackgroundVariant.Dots} color="#2B3444" gap={20} size={1} />
      <Controls showInteractive={false} position="top-left" className="foundry-controls" />
      <Legend />
      <NewNodesChip flowNodes={flowNodes} />
      <FitOnEvent />
    </ReactFlow>
  );
}
