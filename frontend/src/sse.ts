import type { EventEnvelope } from "./types";

export type ConnectionStatus = "connected" | "reconnecting" | "offline";

const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 5000;

type SseHandlers = {
  onEvent: (envelope: EventEnvelope) => void;
  onStatus: (status: ConnectionStatus) => void;
  /**
   * Fired when the stream reopens after a prior connection was torn down.
   * The backend has no Last-Event-ID / replay support (see /api/events in
   * backend/app/main.py — a fresh asyncio.Queue per subscribe, nothing
   * buffered), so any events published during the gap are gone for good.
   * The caller should re-fetch full state to heal, since store.ts only
   * fetches GET /api/state once on mount and reduces incrementally after.
   * Not called for the initial connect.
   */
  onReconnect: () => void;
};

/**
 * Connects to GET /api/events with manual reconnect + capped exponential
 * backoff. Native EventSource already auto-reconnects, but its retry delay
 * isn't configurable from JS, so the source is closed + recreated here to
 * get the 1s -> 5s backoff the ops board wants. Returns a cleanup function.
 */
export function connectEvents({ onEvent, onStatus, onReconnect }: SseHandlers): () => void {
  let source: EventSource | null = null;
  let backoff = BACKOFF_START_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let connectCount = 0;

  const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

  const connect = () => {
    if (stopped) return;
    connectCount += 1;
    const isReconnect = connectCount > 1;
    source = new EventSource("/api/events");

    source.onopen = () => {
      backoff = BACKOFF_START_MS;
      onStatus("connected");
      if (isReconnect) onReconnect();
    };

    source.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(String(ev.data)) as EventEnvelope);
      } catch {
        // ponytail: drop a malformed SSE frame rather than crash the feed
      }
    };

    source.onerror = () => {
      source?.close();
      if (stopped) return;
      onStatus(isOffline() ? "offline" : "reconnecting");
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
    };
  };

  const handleOffline = () => onStatus("offline");
  const handleOnline = () => {
    if (source?.readyState !== EventSource.OPEN) {
      backoff = BACKOFF_START_MS;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
      connect();
    }
  };
  window.addEventListener("offline", handleOffline);
  window.addEventListener("online", handleOnline);

  onStatus(isOffline() ? "offline" : "reconnecting");
  connect();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    source?.close();
    window.removeEventListener("offline", handleOffline);
    window.removeEventListener("online", handleOnline);
  };
}
