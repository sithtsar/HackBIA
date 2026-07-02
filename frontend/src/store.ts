import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { BoardState, EventEnvelope } from "./types";
import { fetchState } from "./api";

const EMPTY_STATE: BoardState = {
  graph: { nodes: [], edges: [] },
  terms: [],
  actions: [],
  pending: [],
};

export type FetchStatus = "loading" | "ready" | "error";

export type StoreValue = {
  state: BoardState;
  status: FetchStatus;
  error: string | null;
  /** Re-fetch GET /api/state and replace the whole board state. */
  refetch: () => Promise<void>;
  /**
   * Seam for Task 5: the SSE client will call this with each event envelope
   * and it will reduce the envelope into `state` (node_touched glow,
   * approval_resolved status flips, etc.) without restructuring this store.
   * Deliberately unimplemented here — Task 4 only renders the initial
   * GET /api/state snapshot.
   */
  applyEvent: (envelope: EventEnvelope) => void;
};

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BoardState>(EMPTY_STATE);
  const [status, setStatus] = useState<FetchStatus>("loading");
  const [error, setError] = useState<string | null>(null);

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

  const applyEvent = (_envelope: EventEnvelope): void => {
    throw new Error("wired in Task 5");
  };

  const value = useMemo<StoreValue>(
    () => ({ state, status, error, refetch, applyEvent }),
    [state, status, error],
  );

  return createElement(StoreContext.Provider, { value }, children);
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) {
    throw new Error("useStore must be used within a StoreProvider");
  }
  return ctx;
}
