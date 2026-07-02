import type { BoardState } from "./types";
import fixtureStateRaw from "./fixtures/state.json";

// ponytail: JSON imports widen string literal fields (e.g. "status") to
// `string`, so they don't structurally satisfy BoardState's literal unions.
// Assert through `unknown` rather than fighting TS's JSON inference — the
// fixture is hand-written to match contracts.md, so this is safe.
const fixtureState = fixtureStateRaw as unknown as BoardState;

const USE_FIXTURE = import.meta.env.VITE_USE_FIXTURE === "1";

export async function fetchState(): Promise<BoardState> {
  if (USE_FIXTURE) {
    return fixtureState;
  }
  const res = await fetch("/api/state");
  if (!res.ok) {
    throw new Error(`GET /api/state failed: ${res.status}`);
  }
  return (await res.json()) as BoardState;
}

export type ApprovalDecision = "approved" | "rejected";

export async function postApproval(
  subjectId: string,
  decision: ApprovalDecision,
): Promise<void> {
  const res = await fetch(`/api/approvals/${subjectId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/approvals/${subjectId} failed: ${res.status}`);
  }
}
