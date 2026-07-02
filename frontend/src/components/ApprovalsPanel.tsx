import { useState } from "react";
import type { ActionProposal, OntologyTerm, PendingItem } from "../types";
import { postApproval, type ApprovalDecision } from "../api";
import { useStore } from "../store";
import { PanelHeader } from "./PanelHeader";

type ApprovalsPanelProps = {
  pending: PendingItem[];
  terms: OntologyTerm[];
  actions: ActionProposal[];
};

type Row = {
  subjectId: string;
  name: string;
  kindChip: string;
  preview: string;
  confidence: number | null;
};

function toRow(item: PendingItem, terms: OntologyTerm[], actions: ActionProposal[]): Row | null {
  if (item.subject_kind === "ontology_term") {
    const term = terms.find((t) => t.id === item.subject_id);
    if (!term) return null;
    return {
      subjectId: term.id,
      name: term.name,
      kindChip: term.kind,
      preview: term.definition,
      confidence: term.confidence,
    };
  }
  const action = actions.find((a) => a.id === item.subject_id);
  if (!action) return null;
  return {
    subjectId: action.id,
    name: action.title,
    kindChip: action.kind,
    preview: action.body,
    confidence: null,
  };
}

export function ApprovalsPanel({ pending, terms, actions }: ApprovalsPanelProps) {
  const { refetch } = useStore();
  const [inFlight, setInFlight] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = pending
    .map((item) => toRow(item, terms, actions))
    .filter((row): row is Row => row !== null);

  const decide = async (subjectId: string, decision: ApprovalDecision) => {
    setInFlight(subjectId);
    setError(null);
    try {
      await postApproval(subjectId, decision);
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInFlight(null);
    }
  };

  return (
    <section className="flex min-h-0 flex-col">
      <PanelHeader>Approvals</PanelHeader>
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center">
            <p className="text-[12px] text-text-secondary">Nothing pending approval</p>
          </div>
        ) : (
          <ul>
            {rows.map((row) => (
              <li key={row.subjectId} className="border-b border-hairline px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[12px] text-text-primary">{row.name}</span>
                  <span className="shrink-0 rounded border border-hairline px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-text-secondary">
                    {row.kindChip}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] text-text-secondary">{row.preview}</p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="font-mono text-[11px] text-text-secondary">
                    {row.confidence === null ? "—" : `${Math.round(row.confidence * 100)}%`}
                  </span>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      disabled={inFlight === row.subjectId}
                      onClick={() => void decide(row.subjectId, "approved")}
                      className="rounded border border-agent-blue px-2 py-1 text-[10px] uppercase tracking-wider text-agent-blue disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={inFlight === row.subjectId}
                      onClick={() => void decide(row.subjectId, "rejected")}
                      className="rounded border border-hairline px-2 py-1 text-[10px] uppercase tracking-wider text-text-secondary disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {error ? (
          <p className="px-3 py-2 font-mono text-[11px] text-[#E5484D]">{error}</p>
        ) : null}
      </div>
    </section>
  );
}
