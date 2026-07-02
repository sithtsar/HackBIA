import { useStore } from "../store";

/** Fixed top-right stack of error toasts, fed by `error` SSE events (store auto-dismisses after ~6s). */
export function Toasts() {
  const { toasts, dismissToast } = useStore();

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-3 top-14 z-50 flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto flex items-start justify-between gap-2 rounded border px-3 py-2 text-[12px]"
          style={{ background: "var(--color-panel)", borderColor: "#E5484D", color: "#E5484D" }}
        >
          <span className="font-mono">{toast.message}</span>
          <button
            type="button"
            onClick={() => dismissToast(toast.id)}
            className="shrink-0 text-text-secondary hover:text-text-primary"
            aria-label="dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
