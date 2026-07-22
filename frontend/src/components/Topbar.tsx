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
  postCreateWorkflow,
  patchWorkflowStatus,
} from "../api";
import { CommandPalette, type PaletteActions } from "./CommandPalette";

const DOT_COLOR: Record<ConnectionStatus, string> = {
  connected: "var(--color-committed-green)",
  reconnecting: "var(--color-pending-amber)",
  offline: "#E5484D",
};

const MANUAL_BASELINE = "45:00";

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

/** Dropdown to switch between workflows and create new ones. */
function WorkflowSwitcher() {
  const { state, refetch } = useStore();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const activeWf = state.workflows.find((w) => w.id === state.active_workflow_id);

  const switchWorkflow = async (id: string): Promise<void> => {
    await patchWorkflowStatus(id, "active");
    await refetch();
    setOpen(false);
  };

  const createNew = async (): Promise<void> => {
    if (creating) return;
    setCreating(true);
    try {
      await postCreateWorkflow("New investigation");
      await refetch();
    } catch {
      // toast handled by parent
    } finally {
      setCreating(false);
      setOpen(false);
    }
  };

  const startRename = (id: string, title: string): void => {
    setRenamingId(id);
    setRenameValue(title);
  };

  const commitRename = async (id: string): Promise<void> => {
    if (!renameValue.trim()) return;
    await patchWorkflowStatus(id, "active", renameValue.trim());
    setRenamingId(null);
    await refetch();
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded border border-hairline px-2 py-0.5 font-mono text-[11px] text-text-secondary hover:border-agent-blue hover:text-text-primary"
      >
        <span className="max-w-[120px] truncate">{activeWf?.title ?? "No workflow"}</span>
        <span className="text-[9px]">▼</span>
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded border border-hairline bg-panel shadow-lg">
            <div className="border-b border-hairline px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider text-text-secondary">
              Investigations
            </div>
            <ul className="max-h-48 overflow-y-auto py-1">
              {state.workflows.map((wf) => (
                <li key={wf.id}>
                  {renamingId === wf.id ? (
                    <form
                      onSubmit={(e) => { e.preventDefault(); void commitRename(wf.id); }}
                      className="flex items-center gap-1 px-2 py-1"
                    >
                      <input
                        autoFocus
                        className="min-w-0 flex-1 rounded border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[11px] outline-none focus:border-agent-blue"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => void commitRename(wf.id)}
                      />
                    </form>
                  ) : (
                    <div className="flex items-center">
                      <button
                        type="button"
                        onClick={() => void switchWorkflow(wf.id)}
                        className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px] ${
                          wf.id === state.active_workflow_id
                            ? "bg-agent-blue/10 text-agent-blue"
                            : "text-text-secondary hover:text-text-primary"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            wf.status === "active" ? "bg-committed-green" : "bg-text-secondary"
                          }`}
                        />
                        <span className="truncate">{wf.title}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => startRename(wf.id, wf.title)}
                        className="mr-1 shrink-0 px-1 text-[10px] text-text-secondary hover:text-agent-blue"
                        title="Rename"
                      >
                        ✎
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <div className="border-t border-hairline px-2 py-1.5">
              <button
                type="button"
                onClick={() => void createNew()}
                disabled={creating}
                className="w-full rounded border border-dashed border-hairline px-2 py-1 text-[11px] text-text-secondary hover:border-agent-blue hover:text-agent-blue disabled:opacity-50"
              >
                + New investigation
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function Topbar() {
  const { connectionStatus, run, applyEvent, refetch, pushToast } = useStore();
  const runActive = run.startedAt !== null && run.endedAt === null;
  const elapsed = useElapsedLabel(run);

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
      workflow_id: "",
      type: "error",
      payload: { message: `${fallbackMessage}: ${message}` },
    });
  };

  const submitAsk = async (question: string): Promise<void> => {
    const trimmed = question.trim();
    if (!trimmed || runActive || busy) return;
    setBusy("ask");
    setActionError(null);
    try {
      await postAsk(trimmed);
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

  const handleFilePicked = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so re-picking the same file still fires onChange
    if (!file || busy) return;
    setBusy("upload");
    setActionError(null);
    try {
      const result = await postDataUpload(file);
      await refetch(); // new source node lands on canvas ("N new" chip if off-screen)
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

  // Rebuilt each render on purpose: the closures must see current busy/run
  // guards (a useMemo([]) here would freeze busy=null forever).
  const paletteActions: PaletteActions = {
    ask: submitAsk,
    draft: runDraft,
    upload: () => fileInputRef.current?.click(),
    replay: runReplay,
    reset: runReset,
    exportYaml: runExport,
  };

  return (
    <header className="flex h-12 items-center gap-3 border-b border-hairline bg-panel px-3">
      <div className="flex flex-none items-center gap-2">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: DOT_COLOR[connectionStatus] }}
          title={`SSE: ${connectionStatus}`}
        />
        <span className="font-mono text-[13px] tracking-wide text-text-primary">FOUNDRY-LITE</span>
        <WorkflowSwitcher />
      </div>

      <div className="flex min-w-0 flex-1 flex-col items-center">
        <CommandPalette actions={paletteActions} />
        {actionError ? (
          <span className="mt-0.5 max-w-md truncate font-mono text-[10px] text-[#E5484D]">{actionError}</span>
        ) : null}
      </div>

      <div className="flex flex-none items-center justify-end gap-3">
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
