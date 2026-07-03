import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { postOntologyMetric } from "../api";
import { useStore } from "../store";

const CANNED_QUESTIONS = [
  "How many active customers do we have?",
  "What's happening with support tickets in the last two weeks?",
  "Which customers have the most open tickets?",
] as const;

/** Board actions owned by Topbar (single implementation: its busy guards +
 * error reporting). The palette only ever calls through these. */
export type PaletteActions = {
  ask: (question: string) => Promise<void>;
  draft: () => Promise<void>;
  upload: () => void;
  replay: () => Promise<void>;
  reset: () => Promise<void>;
  exportYaml: () => Promise<void>;
};

type Command = { id: string; label: string; hint: string; run: () => void };

type Mode = "list" | "metric";

const INPUT_CLASS =
  "w-full rounded border border-hairline bg-canvas px-2.5 py-1.5 text-[12px] text-text-primary placeholder:text-text-secondary focus:border-agent-blue focus:outline-none";
const LABEL_CLASS =
  "mb-1 block font-mono text-[10px] uppercase tracking-wider text-text-secondary";

export function CommandPalette({ actions }: { actions: PaletteActions }) {
  const { state, pushToast, approveAll } = useStore();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("list");
  const [query, setQuery] = useState("");
  const [selIdx, setSelIdx] = useState(-1);

  // Metric form state.
  const [name, setName] = useState("");
  const [definition, setDefinition] = useState("");
  const [sql, setSql] = useState("");
  const [tablesChecked, setTablesChecked] = useState<ReadonlySet<string>>(new Set());
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const openPalette = (): void => {
    setMode("list");
    setQuery("");
    setSelIdx(-1);
    setName("");
    setDefinition("");
    setSql("");
    setTablesChecked(new Set());
    setFormError(null);
    setOpen(true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => {
          if (!o) openPalette();
          return !o;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // openPalette only calls stable setters — safe render-1 closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pendingCount = state.pending.length;

  const commands = useMemo<Command[]>(() => {
    const close = (): void => setOpen(false);
    return [
      ...CANNED_QUESTIONS.map((q) => ({
        id: q,
        label: q,
        hint: "ask",
        run: () => {
          void actions.ask(q);
          close();
        },
      })),
      { id: "draft", label: "Draft ontology", hint: "agent", run: () => { void actions.draft(); close(); } },
      { id: "metric", label: "New metric…", hint: "build", run: () => setMode("metric") },
      { id: "upload", label: "Add data (upload CSV)", hint: "build", run: () => { close(); actions.upload(); } },
      ...(pendingCount > 0
        ? [{
            id: "approve-all",
            label: `Approve all pending (${pendingCount})`,
            hint: "review",
            run: () => { void approveAll(); close(); },
          }]
        : []),
      { id: "replay", label: "Replay demo", hint: "demo", run: () => { void actions.replay(); close(); } },
      { id: "reset", label: "Reset board", hint: "demo", run: () => { void actions.reset(); close(); } },
      { id: "export", label: "Export ontology.yaml", hint: "file", run: () => { void actions.exportYaml(); close(); } },
      { id: "fit", label: "Fit view", hint: "canvas", run: () => { window.dispatchEvent(new Event("foundry:fit")); close(); } },
    ];
  }, [actions, approveAll, pendingCount]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  const onListKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      const cmd = selIdx >= 0 ? filtered[selIdx] : undefined;
      if (cmd) {
        cmd.run();
      } else if (query.trim()) {
        void actions.ask(query.trim());
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const tables = useMemo(() => {
    // Same table source the reducer's tableToObject uses: object nodes' meta.table.
    const set = new Set<string>();
    for (const n of state.graph.nodes) {
      if (n.kind === "object" && n.meta.table) set.add(n.meta.table);
    }
    return [...set];
  }, [state.graph.nodes]);

  const toggleTable = (table: string): void => {
    setTablesChecked((prev) => {
      const next = new Set(prev);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });
  };

  const submitMetric = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await postOntologyMetric({
        name: name.trim(),
        definition: definition.trim(),
        sql: sql.trim(),
        source_tables: [...tablesChecked],
      });
      // Node + object->metric derives edges arrive via SSE (reducer handles it).
      pushToast("metric proposed — see approvals", "success");
      setOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={openPalette}
        className="flex w-full max-w-md items-center gap-2 rounded border border-hairline bg-canvas px-3 py-1.5 text-left text-[12px] text-text-secondary hover:border-agent-blue hover:text-text-primary"
      >
        <kbd className="rounded border border-hairline px-1 font-mono text-[10px]">⌘K</kbd>
        ask or command
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 bg-black/50"
          onClick={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (mode === "metric") setMode("list");
              else setOpen(false);
            }
          }}
        >
          <div
            className="mx-auto mt-[16vh] w-full max-w-[560px] rounded border border-hairline bg-panel"
            onClick={(e) => e.stopPropagation()}
          >
            {mode === "list" ? (
              <>
                <div className="border-b border-hairline p-2">
                  <input
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    type="text"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setSelIdx(-1);
                    }}
                    onKeyDown={onListKeyDown}
                    placeholder="Ask a question about your data… or pick a command"
                    className={INPUT_CLASS}
                  />
                </div>
                <ul className="max-h-[320px] overflow-y-auto py-1" role="listbox">
                  {filtered.map((cmd, i) => (
                    <li key={cmd.id}>
                      <button
                        type="button"
                        onClick={cmd.run}
                        onMouseEnter={() => setSelIdx(i)}
                        className={`flex w-full items-center justify-between px-3 py-1.5 text-left font-mono text-[12px] ${
                          i === selIdx ? "bg-hairline text-text-primary" : "text-text-secondary"
                        }`}
                      >
                        <span className="truncate">{cmd.label}</span>
                        <span className="ml-3 shrink-0 text-[10px] uppercase tracking-wider opacity-50">
                          {cmd.hint}
                        </span>
                      </button>
                    </li>
                  ))}
                  {filtered.length === 0 ? (
                    <li className="px-3 py-1.5 font-mono text-[11px] text-text-secondary">
                      no matching command — Enter asks the agent
                    </li>
                  ) : null}
                </ul>
                <div className="border-t border-hairline px-3 py-1.5 font-mono text-[10px] text-text-secondary opacity-60">
                  ↑↓ select · Enter run/ask · Esc close
                </div>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitMetric();
                }}
                className="flex flex-col gap-3 p-3"
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMode("list")}
                    className="rounded border border-hairline px-1.5 py-0.5 font-mono text-[10px] text-text-secondary hover:text-text-primary"
                  >
                    ‹ back
                  </button>
                  <span className="font-mono text-[11px] uppercase tracking-wider text-text-secondary">
                    New metric
                  </span>
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="metric-name">Name</label>
                  <input
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    id="metric-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Orders per Customer"
                    className={INPUT_CLASS}
                  />
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="metric-definition">Definition</label>
                  <input
                    id="metric-definition"
                    type="text"
                    value={definition}
                    onChange={(e) => setDefinition(e.target.value)}
                    placeholder="What this metric means, in one sentence"
                    className={INPUT_CLASS}
                  />
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="metric-sql">SQL (optional)</label>
                  <textarea
                    id="metric-sql"
                    value={sql}
                    onChange={(e) => setSql(e.target.value)}
                    placeholder="SELECT …"
                    rows={3}
                    className={`${INPUT_CLASS} resize-y font-mono`}
                  />
                </div>
                <fieldset>
                  <legend className={LABEL_CLASS}>Source tables</legend>
                  <div className="flex flex-wrap gap-3">
                    {tables.map((table) => (
                      <label key={table} className="flex items-center gap-1.5 font-mono text-[12px] text-text-primary">
                        <input
                          type="checkbox"
                          checked={tablesChecked.has(table)}
                          onChange={() => toggleTable(table)}
                          className="accent-[#4C90F0]"
                        />
                        {table}
                      </label>
                    ))}
                  </div>
                </fieldset>
                {formError ? (
                  <p className="font-mono text-[11px] text-[#E5484D]">{formError}</p>
                ) : null}
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={submitting || !name.trim() || tablesChecked.size === 0}
                    className="rounded border border-agent-blue px-3 py-1 text-[11px] uppercase tracking-wider text-agent-blue disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {submitting ? "Proposing…" : "Propose metric"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
