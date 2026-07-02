import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { ConnectionStatus, RunTiming } from "../store";
import { useStore } from "../store";
import {
  fetchOntologyExport,
  postAsk,
  postDataUpload,
  postDemoReset,
  postOntologyDraft,
  postReplay,
} from "../api";

const DOT_COLOR: Record<ConnectionStatus, string> = {
  connected: "var(--color-committed-green)",
  reconnecting: "var(--color-pending-amber)",
  offline: "#E5484D",
};

const MANUAL_BASELINE = "45:00";

const CANNED_QUESTIONS = [
  "How many active customers do we have?",
  "What's happening with support tickets in the last two weeks?",
  "Which customers have the most open tickets?",
] as const;

type BusyState = "ask" | "replay" | "draft" | "upload" | "reset" | "export" | null;

// ponytail: module-level counter, not a UUID lib — same-millisecond local
// error envelopes would otherwise collide on React key.
let localErrorSeq = 0;

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
  const { connectionStatus, run, applyEvent, refetch, pushToast } = useStore();
  const runActive = run.startedAt !== null && run.endedAt === null;
  const elapsed = useElapsedLabel(run);

  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState<BusyState>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reportFailure = (err: unknown, fallbackMessage: string): void => {
    const message = err instanceof Error ? err.message : String(err);
    setActionError(message);
    // A failed POST (network/HTTP error) has no matching SSE `error` event —
    // surface it the same way a server-side error would via the feed/toast.
    applyEvent({
      id: `local_${Date.now()}_${localErrorSeq++}`,
      ts: new Date().toISOString(),
      run_id: "",
      type: "error",
      payload: { message: `${fallbackMessage}: ${message}` },
    });
  };

  const submitAsk = async (override?: string): Promise<void> => {
    const trimmed = (override ?? question).trim();
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

  const clickChip = (chip: string): void => {
    setQuestion(chip);
    void submitAsk(chip);
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

  const handleFilePicked = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so re-picking the same file still fires onChange
    if (!file || busy) return;
    setBusy("upload");
    setActionError(null);
    try {
      const result = await postDataUpload(file);
      await refetch(); // new source node lands in the SOURCE column ("N new" chip if off-screen)
      pushToast(
        `table ${result.table} added — ${result.rows} rows, ${result.columns.length} columns`,
        "success",
      );
    } catch (err) {
      reportFailure(err, "upload failed");
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

  const runReset = async (): Promise<void> => {
    if (busy) return;
    setBusy("reset");
    setActionError(null);
    try {
      await postDemoReset();
      await refetch();
    } catch (err) {
      reportFailure(err, "reset failed");
    } finally {
      setBusy(null);
    }
  };

  const runExport = async (): Promise<void> => {
    if (busy) return;
    setBusy("export");
    setActionError(null);
    try {
      const blob = await fetchOntologyExport();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ontology.yaml";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      reportFailure(err, "export failed");
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
          placeholder="Ask a question about your data…"
          className="w-full max-w-md rounded border border-hairline bg-canvas px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-secondary disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="mt-1 flex max-w-md gap-1.5">
          {CANNED_QUESTIONS.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => clickChip(chip)}
              disabled={runActive || busy === "ask"}
              title={chip}
              className="truncate rounded border border-hairline bg-panel px-1.5 py-0.5 font-mono text-[11px] text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {chip}
            </button>
          ))}
        </div>
        {actionError ? (
          <span className="mt-0.5 max-w-md truncate font-mono text-[10px] text-[#E5484D]">{actionError}</span>
        ) : null}
      </div>

      <div className="flex flex-1 items-center justify-end gap-3">
        <span className="font-mono text-[12px] text-text-secondary">
          AGENT {elapsed} / MANUAL {MANUAL_BASELINE}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => void handleFilePicked(e)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy === "upload"}
          className="rounded border border-hairline px-2.5 py-1 text-[11px] uppercase tracking-wider text-text-secondary hover:border-agent-blue hover:text-agent-blue disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === "upload" ? "Uploading…" : "Add data"}
        </button>
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
        <button
          type="button"
          onClick={() => void runReset()}
          disabled={busy === "reset"}
          className="rounded border border-hairline px-2.5 py-1 text-[11px] uppercase tracking-wider text-text-secondary hover:border-agent-blue hover:text-agent-blue disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === "reset" ? "Resetting…" : "Reset"}
        </button>
        <button
          type="button"
          onClick={() => void runExport()}
          disabled={busy === "export"}
          className="rounded border border-hairline px-2.5 py-1 text-[11px] uppercase tracking-wider text-text-secondary hover:border-agent-blue hover:text-agent-blue disabled:cursor-not-allowed disabled:opacity-50"
        >
          Export
        </button>
      </div>
    </header>
  );
}
