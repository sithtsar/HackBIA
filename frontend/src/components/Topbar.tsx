import { useEffect, useState } from "react";
import type { ConnectionStatus, RunTiming } from "../store";
import { useStore } from "../store";
import { postAsk, postOntologyDraft, postReplay } from "../api";

const DOT_COLOR: Record<ConnectionStatus, string> = {
  connected: "var(--color-committed-green)",
  reconnecting: "var(--color-pending-amber)",
  offline: "#E5484D",
};

const MANUAL_BASELINE = "45:00";

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(totalSec / 60))}:${pad2(totalSec % 60)}`;
}

/** Ticks a re-render every second while a run is in flight; freezes once endedAt is set. */
function useElapsedLabel(run: RunTiming): string {
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (run.startedAt === null || run.endedAt !== null) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [run.startedAt, run.endedAt]);

  if (run.startedAt === null) return "00:00";
  const end = run.endedAt ?? Date.now();
  return formatElapsed(end - run.startedAt);
}

export function Topbar() {
  const { connectionStatus, run, applyEvent } = useStore();
  const runActive = run.startedAt !== null && run.endedAt === null;
  const elapsed = useElapsedLabel(run);

  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState<"ask" | "replay" | "draft" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reportFailure = (err: unknown, fallbackMessage: string): void => {
    const message = err instanceof Error ? err.message : String(err);
    setActionError(message);
    // A failed POST (network/HTTP error) has no matching SSE `error` event —
    // surface it the same way a server-side error would via the feed/toast.
    applyEvent({
      id: `local_${Date.now()}`,
      ts: new Date().toISOString(),
      run_id: "",
      type: "error",
      payload: { message: `${fallbackMessage}: ${message}` },
    });
  };

  const submitAsk = async (): Promise<void> => {
    const trimmed = question.trim();
    if (!trimmed || runActive || busy) return;
    setBusy("ask");
    setActionError(null);
    try {
      await postAsk(trimmed);
      setQuestion("");
    } catch (err) {
      reportFailure(err, "ask failed");
    } finally {
      setBusy(null);
    }
  };

  const runReplay = async (): Promise<void> => {
    if (busy) return;
    setBusy("replay");
    setActionError(null);
    try {
      await postReplay();
    } catch (err) {
      reportFailure(err, "replay failed");
    } finally {
      setBusy(null);
    }
  };

  const runDraft = async (): Promise<void> => {
    if (busy) return;
    setBusy("draft");
    setActionError(null);
    try {
      await postOntologyDraft();
    } catch (err) {
      reportFailure(err, "draft failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <header className="flex h-12 items-center border-b border-hairline bg-panel px-3">
      <div className="flex flex-1 items-center gap-2">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: DOT_COLOR[connectionStatus] }}
          title={`SSE: ${connectionStatus}`}
        />
        <span className="font-mono text-[13px] tracking-wide text-text-primary">FOUNDRY-LITE</span>
      </div>

      <div className="flex flex-1 flex-col items-center">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submitAsk();
          }}
          disabled={runActive || busy === "ask"}
          placeholder="Ask the warehouse…"
          className="w-full max-w-md rounded border border-hairline bg-canvas px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-secondary disabled:cursor-not-allowed disabled:opacity-60"
        />
        {actionError ? (
          <span className="mt-0.5 max-w-md truncate font-mono text-[10px] text-[#E5484D]">{actionError}</span>
        ) : null}
      </div>

      <div className="flex flex-1 items-center justify-end gap-3">
        <span className="font-mono text-[12px] text-text-secondary">
          AGENT {elapsed} / MANUAL {MANUAL_BASELINE}
        </span>
        <button
          type="button"
          onClick={() => void runDraft()}
          disabled={busy === "draft"}
          className="rounded border border-hairline px-2.5 py-1 text-[11px] uppercase tracking-wider text-text-secondary hover:border-agent-blue hover:text-agent-blue disabled:cursor-not-allowed disabled:opacity-50"
        >
          Draft ontology
        </button>
        <button
          type="button"
          onClick={() => void runReplay()}
          disabled={busy === "replay"}
          className="rounded border border-hairline px-2.5 py-1 text-[11px] uppercase tracking-wider text-text-secondary hover:border-agent-blue hover:text-agent-blue disabled:cursor-not-allowed disabled:opacity-50"
        >
          Replay
        </button>
      </div>
    </header>
  );
}
