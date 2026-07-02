import { useStore } from "../store";
import type { ActionProposal, GraphNode, OntologyTerm } from "../types";

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="mt-2">
      <div className="text-[10px] uppercase tracking-wider text-text-secondary">{label}</div>
      <div className={`mt-0.5 text-[12px] text-text-primary ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function NodeSection({ node }: { node: GraphNode }) {
  const metaEntries = Object.entries(node.meta);
  return (
    <div className="border-b border-hairline px-3 py-3">
      <Field label="Kind" value={node.kind} mono />
      <Field label="Status" value={node.status} mono />
      {metaEntries.map(([key, value]) => (
        <Field key={key} label={key} value={value} mono />
      ))}
    </div>
  );
}

function TermSection({ term }: { term: OntologyTerm }) {
  return (
    <div className="border-b border-hairline px-3 py-3">
      <div className="text-[10px] uppercase tracking-wider text-text-secondary">Definition</div>
      <p className="mt-0.5 text-[12px] leading-snug text-text-primary">{term.definition}</p>
      {term.sql ? (
        <pre className="mt-2 overflow-x-auto rounded border border-hairline bg-canvas px-2 py-1.5 font-mono text-[11px] leading-relaxed text-text-secondary">
          {term.sql}
        </pre>
      ) : null}
      <Field label="Confidence" value={`${Math.round(term.confidence * 100)}%`} mono />
    </div>
  );
}

function ActionSection({ action }: { action: ActionProposal }) {
  return (
    <div className="border-b border-hairline px-3 py-3">
      <Field label="Title" value={action.title} />
      <div className="mt-2 text-[10px] uppercase tracking-wider text-text-secondary">Body</div>
      <p className="mt-0.5 text-[12px] leading-snug text-text-primary">{action.body}</p>
      <Field label="Status" value={action.status} mono />
      <Field label="Insight ref" value={action.insight_ref} mono />
    </div>
  );
}

export function DetailPanel() {
  const { state, selectedId, setSelectedId } = useStore();
  if (selectedId === null) return null;

  const node = state.graph.nodes.find((n) => n.id === selectedId);
  const term = state.terms.find((t) => t.id === selectedId);
  const action = state.actions.find((a) => a.id === selectedId);
  if (!node && !term && !action) return null;

  const heading = node?.label ?? term?.name ?? action?.title ?? selectedId;

  return (
    <div className="absolute right-0 top-0 bottom-0 z-10 flex w-80 flex-col border-l border-hairline bg-panel">
      <div className="flex items-center justify-between border-b border-hairline px-3 py-2">
        <span className="truncate font-mono text-[13px] text-text-primary" title={heading}>
          {heading}
        </span>
        <button
          type="button"
          aria-label="Close"
          onClick={() => setSelectedId(null)}
          className="shrink-0 px-1 text-[16px] leading-none text-text-secondary hover:text-text-primary"
        >
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {node ? <NodeSection node={node} /> : null}
        {term ? <TermSection term={term} /> : null}
        {action ? <ActionSection action={action} /> : null}
      </div>
    </div>
  );
}
