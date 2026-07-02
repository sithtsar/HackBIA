import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { BoardState, EventEnvelope } from "./types";
import { fetchState } from "./api";
import { reduceBoard } from "./reducer";
import { connectEvents, type ConnectionStatus } from "./sse";

export type { ConnectionStatus } from "./sse";

const EMPTY_STATE: BoardState = {
  graph: { nodes: [], edges: [] },
  terms: [],
  actions: [],
  pending: [],
};

const ACTIVITY_DECAY_MS = 2000;
const FEED_CAP = 200;
const TOAST_TTL_MS = 6000;

export type FetchStatus = "loading" | "ready" | "error";

export type RunTiming = { startedAt: number | null; endedAt: number | null };

export type ToastKind = "error" | "success";
export type ToastItem = { id: string; message: string; kind: ToastKind };

const NO_RUN: RunTiming = { startedAt: null, endedAt: null };

export type StoreValue = {
  state: BoardState;
  status: FetchStatus;
  error: string | null;
  /** Re-fetch GET /api/state and replace the whole board state. */
  refetch: () => Promise<void>;
  /** Reduces one SSE envelope into `state` (+ feed/activity/run/toasts). */
  applyEvent: (envelope: EventEnvelope) => void;
  /** Live envelopes, oldest first, capped at the last 200. */
  feed: EventEnvelope[];
  /** SSE connection health, drives the topbar status dot. */
  connectionStatus: ConnectionStatus;
  /** Node/edge ids touched in the last ~2s (node_touched/edge_traversed glow). Edge keys are `${source}::${target}`. */
  activeNodeIds: ReadonlySet<string>;
  activeEdgeKeys: ReadonlySet<string>;
  run: RunTiming;
  toasts: ToastItem[];
  dismissToast: (id: string) => void;
  /** Push a toast outside the SSE stream (e.g. an upload success confirmation). */
  pushToast: (message: string, kind: ToastKind) => void;
};

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BoardState>(EMPTY_STATE);
  const [status, setStatus] = useState<FetchStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<EventEnvelope[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("reconnecting");
  const [activeNodeIds, setActiveNodeIds] = useState<ReadonlySet<string>>(new Set<string>());
  const [activeEdgeKeys, setActiveEdgeKeys] = useState<ReadonlySet<string>>(new Set<string>());
  const [run, setRun] = useState<RunTiming>(NO_RUN);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const refetch = async (): Promise<void> => {
    setStatus("loading");
    setError(null);
    try {
      const next = await fetchState();
      setState(next);
      setStatus("ready");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markNodeActive = (id: string): void => {
    setActiveNodeIds((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setActiveNodeIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, ACTIVITY_DECAY_MS);
  };

  const markEdgeActive = (source: string, target: string): void => {
    const key = `${source}::${target}`;
    setActiveEdgeKeys((prev) => new Set(prev).add(key));
    setTimeout(() => {
      setActiveEdgeKeys((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, ACTIVITY_DECAY_MS);
  };

  const dismissToast = (id: string): void => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const pushToast = (message: string, kind: ToastKind): void => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => dismissToast(id), TOAST_TTL_MS);
  };

  const applyEvent = (envelope: EventEnvelope): void => {
    setState((prev) => reduceBoard(prev, envelope));
    setFeed((prev) => [...prev, envelope].slice(-FEED_CAP));

    switch (envelope.type) {
      case "node_touched":
        markNodeActive(envelope.payload.node_id);
        break;
      case "edge_traversed":
        markEdgeActive(envelope.payload.source, envelope.payload.target);
        break;
      case "run_started":
        setRun({ startedAt: Date.now(), endedAt: null });
        break;
      case "run_completed":
        setRun((prev) => ({ startedAt: prev.startedAt, endedAt: Date.now() }));
        break;
      case "error":
        pushToast(envelope.payload.message, "error");
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    // applyEvent only ever calls stable useState setters (several via the
    // functional-update form), so the render-1 closure captured here stays
    // correct for the app's lifetime — no need to reconnect on every render.
    return connectEvents({ onEvent: applyEvent, onStatus: setConnectionStatus });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: StoreValue = {
    state,
    status,
    error,
    refetch,
    applyEvent,
    feed,
    connectionStatus,
    activeNodeIds,
    activeEdgeKeys,
    run,
    toasts,
    dismissToast,
    pushToast,
  };

  return createElement(StoreContext.Provider, { value }, children);
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) {
    throw new Error("useStore must be used within a StoreProvider");
  }
  return ctx;
}
