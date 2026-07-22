import { useEffect, useState } from "react";
import { deleteGraphNode, getNodeSample } from "../api";
import { useStore } from "../store";
import type { ActionProposal, GraphEdge, GraphNode, NodeSample, OntologyTerm } from "../types";

const ERROR_RED = "#E5484D";

// Mirrors AgentFeedPanel's colorFor/FoundryNode's statusColor for insight severity.
const SEVERITY_COLOR: Record<string, string> = {
  critical: ERROR_RED,
  warning: "var(--color-pending-amber)",
  info: "var(--color-agent-blue)",
};

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="mt-2">
      <div className="text-[10px] uppercase tracking-wider text-text-secondary">{label}</div>
      <div className={`mt-0.5 text-[12px] text-text-primary ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function cell(v: string | number | null): string {
  return v === null ? "null" : String(v);
}

function SampleTable({ columns, rows }: { columns: string[]; rows: (string | number | null)[][] }) {
  return (
    <div className="mt-1 overflow-x-auto rounded border border-hairline">
      <table className="w-full border-collapse font-mono text-[10px]">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} className="whitespace-nowrap border-b border-hairline px-1.5 py-1 text-left text-text-secondary">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // eslint-disable-next-line react/no-array-index-key -- rows have no stable id
            <tr key={i}>
              {row.map((v, j) => (
                <td key={j} className="whitespace-nowrap px-1.5 py-1 text-text-primary">
                  {cell(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SampleSection({ nodeId }: { nodeId: string }) {
  const [sample, setSample] = useState<NodeSample | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSample(null);
    setError(null);
    getNodeSample(nodeId)
      .then(setSample)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [nodeId]);

  if (error) return null; // e.g. a stale/malformed stored SQL — not worth surfacing here
  if (!sample) {
    return <p className="mt-2 text-[11px] text-text-secondary">Loading sample…</p>;
  }
  if (sample.row_count === 0) return null; // e.g. an action node has no underlying query

  const hasMore = sample.row_count > sample.head.length;
  return (
    <div className="mt-3">
      <div className="text-[10px] uppercase tracking-wider text-text-secondary">
        Sample data ({sample.row_count} rows)
      </div>
      <SampleTable columns={sample.columns} rows={sample.head} />
      {hasMore ? (
        <>
          <div className="mt-1 text-center text-[10px] text-text-secondary">⋮</div>
          <SampleTable columns={sample.columns} rows={sample.tail} />
        </>
      ) : null}
    </div>
  );
}

function InsightSection({ node, edges, nodes }: { node: GraphNode; edges: GraphEdge[]; nodes: GraphNode[] }) {
  const { setSelectedId } = useStore();
  const severity = node.meta.severity ?? "info";
  const evidenceIds = edges.filter((e) => e.kind === "produces" && e.target === node.id).map((e) => e.source);
  const evidence = evidenceIds.map((id) => nodes.find((n) => n.id === id)).filter((n): n is GraphNode => n != null);

  return (
    <>
      <div className="mt-2 flex items-center gap-1.5">
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: SEVERITY_COLOR[severity] ?? SEVERITY_COLOR.info }}
        />
        <span className="text-[10px] uppercase tracking-wider text-text-secondary">{severity}</span>
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-text-primary">{node.label}</p>
      {evidence.length > 0 ? (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary">Evidence</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {evidence.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => setSelectedId(e.id)}
                className="rounded border border-hairline px-1.5 py-0.5 font-mono text-[10px] text-text-secondary hover:border-agent-blue hover:text-text-primary"
                title={`Jump to ${e.label}`}
              >
                {e.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {node.meta.sql_used ? (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary">Query used</div>
          <pre className="mt-0.5 overflow-x-auto rounded border border-hairline bg-canvas px-2 py-1.5 font-mono text-[11px] leading-relaxed text-text-secondary">
            {node.meta.sql_used}
          </pre>
        </div>
      ) : null}
    </>
  );
}

function DeleteNodeButton({ node }: { node: GraphNode }) {
  const { pushToast, setSelectedId } = useStore();
  const [deleting, setDeleting] = useState(false);

  const onDelete = async (): Promise<void> => {
    const ok = window.confirm(
      `Delete "${node.label}" and everything built downstream from it (derived metrics, insights, actions)? This can't be undone.`,
    );
    if (!ok || deleting) return;
    setDeleting(true);
    try {
      const { node_ids } = await deleteGraphNode(node.id);
      setSelectedId(null);
      pushToast(`Deleted ${node_ids.length} node${node_ids.length === 1 ? "" : "s"}`, "success");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void onDelete()}
      disabled={deleting}
      className="mt-3 w-full rounded border border-[#E5484D] px-2 py-1 text-[11px] uppercase tracking-wider text-[#E5484D] hover:bg-[#E5484D] hover:text-panel disabled:cursor-not-allowed disabled:opacity-50"
    >
      {deleting ? "Deleting…" : "Delete node"}
    </button>
  );
}

function NodeSection({ node }: { node: GraphNode }) {
  const { state } = useStore();
  const metaEntries = Object.entries(node.meta);
  return (
    <div className="border-b border-hairline px-3 py-3">
      {node.kind === "insight" ? (
        <InsightSection node={node} edges={state.graph.edges} nodes={state.graph.nodes} />
      ) : (
        <>
          <Field label="Kind" value={node.kind} mono />
          <Field label="Status" value={node.status} mono />
          {metaEntries.map(([key, value]) => (
            <Field key={key} label={key} value={value} mono />
          ))}
        </>
      )}
      <SampleSection nodeId={node.id} />
      <DeleteNodeButton node={node} />
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
