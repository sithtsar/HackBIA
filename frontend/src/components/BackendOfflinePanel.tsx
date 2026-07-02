type BackendOfflinePanelProps = {
  message: string | null;
};

export function BackendOfflinePanel({ message }: BackendOfflinePanelProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <p className="text-[13px] text-text-primary">Backend offline</p>
      <p className="max-w-sm text-[12px] text-text-secondary">
        start it with:
      </p>
      <code className="rounded border border-hairline bg-panel px-3 py-2 font-mono text-[12px] text-agent-blue">
        uv run uvicorn backend.app.main:app --port 8400
      </code>
      {message ? (
        <p className="max-w-sm font-mono text-[11px] text-text-secondary">{message}</p>
      ) : null}
    </div>
  );
}
