import { useStore } from "../store";
import type { ToastKind } from "../store";

// Color = state (contracts.md): red = error, green = committed/success.
const TOAST_COLOR: Record<ToastKind, string> = {
  error: "#E5484D",
  success: "var(--color-committed-green)",
};

/** Fixed top-right stack of toasts, fed by `error` SSE events and local success confirmations (store auto-dismisses after ~6s). */
export function Toasts() {
  const { toasts, dismissToast } = useStore();

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-3 top-14 z-50 flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto flex items-start justify-between gap-2 rounded border px-3 py-2 text-[12px]"
          style={{
            background: "var(--color-panel)",
            borderColor: TOAST_COLOR[toast.kind],
            color: TOAST_COLOR[toast.kind],
          }}
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
