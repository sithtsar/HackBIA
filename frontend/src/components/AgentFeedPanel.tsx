import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { PanelHeader } from "./PanelHeader";
import type { EventEnvelope, EventType } from "../types";

const ERROR_RED = "#E5484D";

// blue=flow/sql, amber=proposals/approvals, green=completions/pushes, red=error
const TYPE_COLOR: Record<EventType, string> = {
  run_started: "var(--color-agent-blue)",
  status: "var(--color-agent-blue)",
  node_touched: "var(--color-agent-blue)",
  edge_traversed: "var(--color-agent-blue)",
  sql_generated: "var(--color-agent-blue)",
  sql_result: "var(--color-agent-blue)",
  ontology_term_proposed: "var(--color-pending-amber)",
  action_proposed: "var(--color-pending-amber)",
  approval_required: "var(--color-pending-amber)",
  run_completed: "var(--color-committed-green)",
  action_pushed: "var(--color-committed-green)",
  approval_resolved: "var(--color-committed-green)",
  insight: "var(--color-pending-amber)",
  error: ERROR_RED,
  workflow_created: "var(--color-agent-blue)",
  workflow_renamed: "var(--color-agent-blue)",
  workflow_completed: "var(--color-committed-green)",
};

function colorFor(e: EventEnvelope): string {
  if (e.type === "insight") {
    if (e.payload.severity === "critical") return ERROR_RED;
    if (e.payload.severity === "info") return "var(--color-agent-blue)";
    return "var(--color-pending-amber)";
  }
  if (e.type === "approval_resolved") {
    return e.payload.decision === "approved" ? "var(--color-committed-green)" : "var(--color-text-secondary)";
  }
  return TYPE_COLOR[e.type];
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function summarize(e: EventEnvelope): string {
  switch (e.type) {
    case "run_started":
      return `run started (${e.payload.kind}): ${e.payload.input || "—"}`;
    case "status":
      return e.payload.message;
    case "node_touched":
      return `node → ${e.payload.node_id}`;
    case "edge_traversed":
      return `edge ${e.payload.source} → ${e.payload.target}`;
    case "ontology_term_proposed":
      return `${e.payload.term.kind} proposed: ${e.payload.term.name} (${Math.round(e.payload.term.confidence * 100)}%)`;
    case "sql_generated":
      return `SQL generated (${e.payload.terms_used.length} terms)`;
    case "sql_result":
      return `${e.payload.row_count} rows`;
    case "insight":
      return `[${e.payload.severity}] ${e.payload.text}`;
    case "action_proposed":
      return `${e.payload.action.kind} action proposed: ${e.payload.action.title}`;
    case "approval_required":
      return `approval required: ${e.payload.subject_kind} ${e.payload.subject_id}`;
    case "approval_resolved":
      return `${e.payload.subject_kind} ${e.payload.subject_id} → ${e.payload.decision}`;
    case "action_pushed":
      return `action pushed → ${e.payload.action_id}`;
    case "run_completed":
      return `run completed: ${e.payload.summary}`;
    case "error":
      return e.payload.message;
    case "workflow_created":
      return `workflow created: ${e.payload.title} (${e.payload.workflow_id})`;
    case "workflow_renamed":
      return `workflow renamed: ${e.payload.title}`;
    case "workflow_completed":
      return `workflow completed: ${e.payload.workflow_id}`;
  }
}

function renderBody(e: EventEnvelope) {
  if (e.type === "sql_generated") {
    return (
      <details>
        <summary className="cursor-pointer">{summarize(e)}</summary>
        <pre className="mt-1 max-w-full overflow-x-auto whitespace-pre-wrap break-words text-text-secondary">
          {e.payload.sql}
        </pre>
      </details>
    );
  }
  if (e.type === "sql_result") {
    const first = e.payload.rows[0];
    return (
      <>
        <p>{summarize(e)}</p>
        {first ? (
          <p className="truncate text-text-secondary">
            {first.map((v) => (v === null ? "null" : String(v))).join(" | ")}
          </p>
        ) : null}
      </>
    );
  }
  if (e.type === "action_pushed") {
    return (
      <p>
        action pushed →{" "}
        <a
          href={e.payload.external_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-agent-blue underline"
        >
          {e.payload.external_url}
        </a>
      </p>
    );
  }
  return <p className={e.type === "error" ? "text-[#E5484D]" : undefined}>{summarize(e)}</p>;
}

function FeedRow({ envelope }: { envelope: EventEnvelope }) {
  return (
    <li className="border-b border-hairline px-3 py-1.5 font-mono text-[11px] leading-snug">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-text-secondary">{formatTime(envelope.ts)}</span>
        <span className="shrink-0 uppercase tracking-wider" style={{ color: colorFor(envelope) }}>
          {envelope.type}
        </span>
      </div>
      <div className="mt-0.5 min-w-0 text-text-primary">{renderBody(envelope)}</div>
    </li>
  );
}

// Distance (px) from the bottom within which the panel keeps auto-scrolling
// on new events; beyond it, a manual scroll-up is treated as "reading history".
const STICK_THRESHOLD_PX = 32;

export function AgentFeedPanel() {
  const { feed } = useStore();
  const listRef = useRef<HTMLUListElement>(null);
  const stickToBottom = useRef(true);

  const handleScroll = (): void => {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distanceFromBottom < STICK_THRESHOLD_PX;
  };

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [feed]);

  return (
    <section className="flex min-h-0 flex-col border-b border-hairline">
      <PanelHeader>Agent Feed</PanelHeader>
      {feed.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center">
          <p className="text-[12px] text-text-secondary">
            No agent activity yet — run a draft or ask a question
          </p>
        </div>
      ) : (
        <ul ref={listRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
          {feed.map((envelope) => (
            <FeedRow key={envelope.id} envelope={envelope} />
          ))}
        </ul>
      )}
    </section>
  );
}
