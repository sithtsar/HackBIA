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
  type OnNodeDrag,
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

/** Shared by mount, the new-nodes chip, and the palette's Fit view, so the
 * camera lands identically however it was asked to. */
const FIT_OPTIONS = { padding: 0.18, maxZoom: 1 } as const;

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

/** One quiet row along the bottom edge. The five-row stacked box read as a
 * second panel competing with the graph; the same information fits inline. */
function Legend() {
  return (
    <Panel position="bottom-left">
      <div className="flex items-center gap-3.5 rounded border border-hairline/60 bg-panel/80 px-3 py-1.5 font-mono text-[10px] tracking-wide text-text-secondary backdrop-blur-sm">
        <span>
          <LegendDot color="var(--color-pending-amber)" />
          proposed
        </span>
        <span>
          <LegendDot color="var(--color-committed-green)" />
          approved
        </span>
        <span>
          <LegendDot color="var(--color-agent-blue)" />
          live
        </span>
        <span className="text-hairline">│</span>
        <span>
          <LegendLine dashed={false} />
          flow
        </span>
        <span>
          <LegendLine dashed />
          join
        </span>
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
          void fitView({ ...FIT_OPTIONS, duration: 400 }); // motion on user gesture only
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
      void fitView({ ...FIT_OPTIONS, duration: 400 }); // user gesture, motion ok
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

type XY = { x: number; y: number };

/** Time constant for the glide toward a new layout: positions close ~63% of
 * the remaining distance every TAU ms, so a move settles in roughly 300ms. */
const GLIDE_TAU_MS = 90;
/** Below this many px from target, snap and stop — avoids an endless tail. */
const SETTLE_PX = 0.5;

/**
 * Relayout is only correct if EVERY node moves to its new dagre position;
 * placing just the new nodes leaves the rest in the previous layout's frame
 * of reference and they overlap. Existing nodes therefore have to travel, and
 * teleporting them reads as the graph warping. This eases them instead.
 *
 * Positions are interpolated in React Flow's own node state (not via a CSS
 * transform transition) so edges re-path in lockstep with the cards; a CSS
 * transition animates the card but leaves edges snapping to their endpoints
 * a frame later.
 */
function useGlide(setFlowNodes: React.Dispatch<React.SetStateAction<FoundryFlowNode[]>>) {
  const targets = useRef<Map<string, XY>>(new Map());
  const raf = useRef<number | null>(null);
  const lastTs = useRef(0);

  useEffect(() => {
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, []);

  return useCallback(
    (next: Map<string, XY>) => {
      targets.current = next;
      if (next.size === 0 || raf.current !== null) return; // a running loop picks up new targets
      lastTs.current = performance.now();
      const step = (ts: number) => {
        // dt-based easing keeps the glide identical whether the board is
        // running at 60fps live or being driven by the capture harness.
        const dt = Math.min(ts - lastTs.current, 64);
        lastTs.current = ts;
        const k = 1 - Math.exp(-dt / GLIDE_TAU_MS);
        let moving = false;
        setFlowNodes((prev) =>
          prev.map((n) => {
            const t = targets.current.get(n.id);
            if (t === undefined) return n;
            const dx = t.x - n.position.x;
            const dy = t.y - n.position.y;
            if (Math.abs(dx) < SETTLE_PX && Math.abs(dy) < SETTLE_PX) {
              if (dx === 0 && dy === 0) return n;
              return { ...n, position: { x: t.x, y: t.y } };
            }
            moving = true;
            return { ...n, position: { x: n.position.x + dx * k, y: n.position.y + dy * k } };
          }),
        );
        raf.current = moving ? requestAnimationFrame(step) : null;
      };
      raf.current = requestAnimationFrame(step);
    },
    [setFlowNodes],
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

  const glide = useGlide(setFlowNodes);
  /** Nodes the user dragged: layout proposes, the human disposes. */
  const pinned = useRef<Set<string>>(new Set());
  /** Ids that already have a position on the board, so we know which nodes
   * are arriving (place at target, no travel) vs. moving (glide). */
  const placed = useRef<Set<string>>(new Set());
  const lastLayout = useRef<Map<string, XY>>(new Map());
  const lastTopology = useRef("");

  /** Relayout key. Edges are part of it deliberately: a proposed join adds no
   * node but re-ranks the DAG, and keying on node count alone left those
   * nodes sitting in the pre-join layout. */
  const topology = useMemo(
    () =>
      nodes
        .map((n) => n.id)
        .sort()
        .join("|") +
      "##" +
      edges
        .map((e) => `${e.source}>${e.target}`)
        .sort()
        .join("|"),
    [nodes, edges],
  );

  // Reconcile board -> flow nodes. Dagre re-runs whenever topology changes and
  // every unpinned node adopts the result.
  useEffect(() => {
    const termDefById = new Map(terms.map((t: OntologyTerm) => [t.id, t.definition]));
    const actionsById = new Map(actions.map((a) => [a.id, a]));

    const topoChanged = topology !== lastTopology.current;
    if (topoChanged) {
      lastTopology.current = topology;
      lastLayout.current = new Map(
        layoutGraph(nodes, edges).map((n) => [n.id, { x: n.x, y: n.y }]),
      );
    }
    const layout = lastLayout.current;

    setFlowNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
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
        // Arriving node: mount directly at its final slot. It should fade in
        // where it belongs, never fly in from the origin.
        return {
          id: node.id,
          type: "foundry",
          position: layout.get(node.id) ?? { x: 0, y: 0 },
          connectable: node.kind === "object", // drag-to-connect joins are object->object only
          data: card,
        };
      });
    });

    if (topoChanged) {
      const ids = new Set(nodes.map((n) => n.id));
      // Scenario switches rebuild the graph from scratch; drop ids that are
      // gone so a returning id isn't treated as already-placed or still-pinned.
      for (const s of [pinned.current, placed.current]) {
        for (const id of s) if (!ids.has(id)) s.delete(id);
      }
      const moving = new Map<string, XY>();
      for (const [id, p] of layout) {
        if (placed.current.has(id) && !pinned.current.has(id)) moving.set(id, p);
      }
      glide(moving);
      for (const id of ids) placed.current.add(id);
    }
  }, [nodes, edges, terms, actions, topology, setFlowNodes, glide]);

  /** A drag is an explicit statement about where a node belongs; pin it so the
   * next agent-driven relayout doesn't yank it back. */
  const onNodeDragStop = useCallback<OnNodeDrag<FoundryFlowNode>>((_event, node) => {
    pinned.current.add(node.id);
  }, []);

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
          // Orthogonal routing: lineage reads as a wiring diagram rather than
          // a bundle of overlapping curves once the graph gets wide.
          type: "smoothstep",
          pathOptions: { borderRadius: 8 },
          animated: active, // motion only for live events, never for steady selection
          zIndex: highlighted ? 1 : 0,
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
      onNodeDragStop={onNodeDragStop}
      onPaneClick={onPaneClick}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      fitView // initial mount only; afterwards the camera moves solely on user gestures
      // maxZoom 1 == cards at their designed size. Without it, a board with
      // only the three seed sources fits by blowing them up to fill 1080p.
      fitViewOptions={FIT_OPTIONS}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
      colorMode="dark"
    >
      {/* Dim, wide grid: enough to read as a workspace, not enough to compete
          with the cards for attention at video bitrates. */}
      <Background variant={BackgroundVariant.Dots} color="#1E2632" gap={28} size={1} />
      <Controls showInteractive={false} position="top-left" className="foundry-controls" />
      <Legend />
      <NewNodesChip flowNodes={flowNodes} />
      <FitOnEvent />
    </ReactFlow>
  );
}
