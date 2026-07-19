import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { Caption } from "../components/Caption";
import { colors } from "../colors";
import { captions, techBand } from "../captions";

// Same motion language as Chapter.tsx / Caption.tsx: overdamped springs (no bounce), a
// short slide-up on entry, elements building in sequence rather than all at once.
const BUILD_SPRING_CONFIG = { damping: 200, mass: 0.5 };
const BUILD_FRAMES = 18;
const SLIDE_PX = 22;

/**
 * The one scene with no footage — the architecture, drawn entirely in Remotion.
 *
 * EVERY claim rendered below is checked against the source. If you edit this file, re-check
 * it; a caption asserting something the code does not do is worse than no caption at all.
 *
 *   backend/app/agents.py    introspect() / infer_fks() (x_id -> x, >=0.90 containment,
 *                            confidence = the containment ratio) / guard_sql() (SELECT|WITH
 *                            only, single statement, DDL+DML regex denylist) / _explain()
 *                            (EXPLAIN against DuckDB) / run_ask()'s `for attempt in
 *                            range(2)` loop (exactly one retry, feeding the error text back)
 *                            / _emit_lineage() (node_touched + edge_traversed on real graph
 *                            ids) / the unconditional approval_required published after
 *                            every LLM-proposed metric / asyncio.to_thread around every
 *                            blocking DuckDB + LLM call.
 *   backend/app/ontology.py  save_ontology(): tempfile.mkstemp + os.replace (atomic write).
 *   agents.py _merge_bucket  approved terms are skipped, never overwritten by a later draft.
 *   baml_src/foundry.baml    exactly four functions: DraftOntologyMetrics, AskQuestion,
 *                            DraftActionTicket, InterpretQueryResult.
 *   baml_src/clients.baml    Cerebras client, model gemma-4-31b, retry_policy TwoRetries.
 *
 * The colour coding is the argument: exactly ONE box is agent-blue. Everything load-bearing
 * around it is deterministic Python (green) or a human (amber).
 */

const NODES: readonly {
  kicker: string;
  title: string;
  body: string;
  accent: string;
}[] = [
  {
    kicker: "PYTHON",
    title: "INGEST",
    body: "CSV → DuckDB.\nintrospect() reads the schema\n+ ≤10 sample rows per table.",
    accent: colors.committedGreen,
  },
  {
    kicker: "PYTHON",
    title: "JOINS",
    body: "Inferred deterministically:\ncolumn x_id → table x,\nconfirmed by ≥90% value\ncontainment. No LLM.",
    accent: colors.committedGreen,
  },
  {
    kicker: "LLM",
    title: "BAML",
    body: "gemma-4-31b on Cerebras.\nSchema-locked completions,\nparsed into a typed class.",
    accent: colors.agentBlue,
  },
  {
    kicker: "PYTHON",
    title: "SQL GUARD",
    body: "SELECT/WITH only, one\nstatement, no DDL or DML.\nThen EXPLAIN. Then it runs.",
    accent: colors.committedGreen,
  },
  {
    kicker: "HUMAN",
    title: "THE GATE",
    body: "Every proposed term waits\nfor a person. Approved terms\nare never overwritten.",
    accent: colors.pendingAmber,
  },
];

/** Frame at which each node lands, spread across the first half of the scene. */
const NODE_DELAY_FRAMES = [12, 45, 78, 111, 144];
const LINEAGE_DELAY_FRAMES = 255; // ~8.5s
const CHOICE_DELAY_FRAMES = 400; // ~13.3s

/** Fade + slide-up driven by an overdamped spring, gated on `delay`. */
const useBuild = (delay: number): { opacity: number; transform: string } => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = spring({ frame, fps, config: BUILD_SPRING_CONFIG, durationInFrames: BUILD_FRAMES, delay });
  return {
    opacity: t,
    transform: `translateY(${interpolate(t, [0, 1], [SLIDE_PX, 0])}px)`,
  };
};

const Node: React.FC<{ index: number }> = ({ index }) => {
  const node = NODES[index];
  const build = useBuild(NODE_DELAY_FRAMES[index] ?? 0);
  if (!node) return null;

  return (
    <div
      style={{
        ...build,
        width: 300,
        padding: "24px 22px",
        background: "rgba(255, 255, 255, 0.03)",
        borderTop: `4px solid ${node.accent}`,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ color: node.accent, fontSize: 17, fontWeight: 700, letterSpacing: 2 }}>
        {node.kicker}
      </div>
      <div style={{ color: colors.text, fontSize: 30, fontWeight: 700, letterSpacing: 0.5 }}>
        {node.title}
      </div>
      <div
        style={{
          color: colors.text,
          opacity: 0.72,
          fontSize: 19,
          lineHeight: 1.45,
          whiteSpace: "pre-line",
        }}
      >
        {node.body}
      </div>
    </div>
  );
};

/** The connector between two nodes — draws itself just before the node it points at. */
const Connector: React.FC<{ index: number }> = ({ index }) => {
  const build = useBuild((NODE_DELAY_FRAMES[index + 1] ?? 0) - 8);
  return (
    <div
      style={{
        width: 26,
        height: 3,
        background: colors.text,
        opacity: build.opacity * 0.35,
        flexShrink: 0,
      }}
    />
  );
};

export const ArchScene: React.FC = () => {
  const header = useBuild(0);
  const lineage = useBuild(LINEAGE_DELAY_FRAMES);
  const choice = useBuild(CHOICE_DELAY_FRAMES);

  return (
    <AbsoluteFill
      style={{
        background: colors.bg,
        fontFamily: "system-ui, -apple-system, sans-serif",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 46,
        paddingTop: 40,
      }}
    >
      <div style={{ ...header, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <div style={{ width: 84, height: 6, background: colors.agentBlue }} />
        <div style={{ color: colors.text, fontSize: 42, fontWeight: 700, letterSpacing: 3 }}>
          HOW IT ACTUALLY WORKS
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "stretch", gap: 0 }}>
        {NODES.map((node, i) => (
          <React.Fragment key={node.title}>
            <Node index={i} />
            {i < NODES.length - 1 ? <Connector index={i} /> : null}
          </React.Fragment>
        ))}
      </div>

      <div
        style={{
          ...lineage,
          color: colors.text,
          opacity: lineage.opacity * 0.85,
          fontSize: 24,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          letterSpacing: 0.5,
        }}
      >
        node_touched · edge_traversed → in-process event bus → SSE → client reducer
      </div>

      <div
        style={{
          ...choice,
          maxWidth: 1360,
          padding: "22px 32px",
          borderLeft: `6px solid ${colors.pendingAmber}`,
          background: "rgba(255, 255, 255, 0.03)",
          color: colors.text,
          fontSize: 26,
          lineHeight: 1.5,
          textAlign: "left",
        }}
      >
        <strong>No MCP. No skills. No hooks. No autonomous tool-calling loop.</strong> The contract
        demands an exact, deterministic event sequence — lineage traversal, threshold rules,
        approval gating. That is cleaner to emit from Python than to coax out of an agent loop.
      </div>

      <Caption cues={captions.arch} />
      <Caption cues={techBand.arch} variant="tech" />
    </AbsoluteFill>
  );
};
