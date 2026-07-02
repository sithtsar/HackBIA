import type { FetchStatus } from "../store";

const DOT_COLOR: Record<FetchStatus, string> = {
  ready: "var(--color-committed-green)",
  loading: "var(--color-text-secondary)",
  error: "#E5484D",
};

type TopbarProps = {
  status: FetchStatus;
};

export function Topbar({ status }: TopbarProps) {
  return (
    <header className="flex h-12 items-center border-b border-hairline bg-panel px-3">
      <div className="flex flex-1 items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: DOT_COLOR[status] }} />
        <span className="font-mono text-[13px] tracking-wide text-text-primary">FOUNDRY-LITE</span>
      </div>

      <div className="flex flex-1 justify-center">
        <input
          type="text"
          disabled
          placeholder="Ask the warehouse…"
          className="w-full max-w-md rounded border border-hairline bg-canvas px-3 py-1.5 text-[12px] text-text-secondary placeholder:text-text-secondary disabled:cursor-not-allowed"
        />
      </div>

      <div className="flex flex-1 items-center justify-end gap-3">
        <span className="font-mono text-[12px] text-text-secondary">
          AGENT 00:00 / MANUAL 45:00
        </span>
        <button
          type="button"
          disabled
          className="rounded border border-hairline px-2.5 py-1 text-[11px] uppercase tracking-wider text-text-secondary disabled:cursor-not-allowed"
        >
          Replay
        </button>
      </div>
    </header>
  );
}
