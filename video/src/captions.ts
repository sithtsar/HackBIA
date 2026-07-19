// INTEGRATION CONTRACT — the narration agent fills these arrays in, the video reads them.
// Keys are scene ids; each scene's captions are timed relative to that scene's OWN start
// (0ms = first frame of the scene, not the whole video). Keep entries sorted by fromMs and
// non-overlapping — Caption.tsx shows at most one at a time per scene.

export type SceneId = "title" | "arch" | "retail" | "supply" | "fintech" | "outro";

export interface Caption {
  /** Scene-relative start time, inclusive, in milliseconds. */
  fromMs: number;
  /** Scene-relative end time, exclusive, in milliseconds. Must be > fromMs. */
  toMs: number;
  /** Lower-third caption text. Keep it one short line — this is a video, not a subtitle track. */
  text: string;
}

export type CaptionTrack = Readonly<Record<SceneId, readonly Caption[]>>;

// Timings below are synced to the REAL captured beats in video/raw/{retail,supply,fintech}.json
// (t_ms is video-relative: capture.mjs sets t0 right after the recording context is created,
// see frontend/capture.mjs). Read from the sidecars directly, not transcribed from memory.
//
// The harness now also emits fit_view beats DURING the streaming phase, so the camera visibly
// re-frames mid-scene. Those are real on-screen movements and are listed below as anchors, but
// a cue boundary is only placed on one where it also lines up with a semantic beat — cutting
// text on a camera move alone just makes the caption look like it flinched.
//
// KNOWN GAP: no capture run includes a rejected term. capture.mjs's approveAllPending()
// only ever approves, so demo_events.jsonl (retail's replay log) and the live supply/fintech
// runs all walk straight to all-green. The captions below describe the gate truthfully (every
// term needs a human decision) without claiming this footage shows a reject, because it
// doesn't. The real "human refuses something" beat lives in docs/DEMO.md's Act 2 instead,
// where a live presenter clicks Reject for real.
export const captions: CaptionTrack = {
  title: [{ fromMs: 500, toMs: 3000, text: "Insights die in dashboards. No lineage, no trust." }],

  // ARCH is the only scene with no footage — it's drawn entirely in Remotion
  // (compositions/ArchScene.tsx), so these timings drive the diagram build rather than
  // tracking a capture. Every claim here is checked against backend/app/agents.py,
  // baml_src/foundry.baml and baml_src/clients.baml; see ArchScene.tsx for the per-node
  // source references. Do not add a claim here without finding it in that source first.
  arch: [
    { fromMs: 700, toMs: 5200, text: "One LLM, on a short leash. Everything around it is plain Python." },
    { fromMs: 5200, toMs: 9800, text: "Joins aren't guessed. They're measured against the real data." },
    { fromMs: 9800, toMs: 14000, text: "Every generated query is guarded, then validated, before it can run." },
    { fromMs: 14000, toMs: 17400, text: "No agent loop, no MCP: the contract needs an exact event sequence." },
    { fromMs: 17400, toMs: 20000, text: "And nothing reaches the ontology until a human approves it." },
  ],

  // Beats (video-relative, from video/raw/retail.json): board_loaded 2863, replay_started 2886,
  // term_proposed obj_customer 5616 / obj_order 5920 / obj_ticket 6526, approval_required obj_*
  // 6828/7132/7435, fit_view 8701, term_proposed m_active_customer 10316, approval_required
  // m_active_customer 11368, fit_view 12583, insight_landed 16317, fit_view 17666,
  // action_proposed 18370, approval_required act_0001 18978, fit_view 20226, replay_finished
  // 25222, approved obj_customer 27636 / obj_order 29040 / obj_ticket 30446 / m_active_customer
  // 31857 / act_0001 33276, all_approved 34857, action_pushed 34867. Video duration 36987ms;
  // the last cue ends there so the whole clip plays instead of being cut short by Series.
  //
  // The insight numbers are read off the INSIGHT line in the agent feed at 16317:
  // "~3x baseline (4-6/day vs 1-2/day). SLA breach rate surged from ~10% to ~35-50%."
  retail: [
    { fromMs: 2886, toMs: 5616, text: "The agent reads the raw CSVs and drafts an ontology." },
    { fromMs: 5616, toMs: 10316, text: "Customer, Order, Ticket: proposed. Amber means waiting on a human." },
    { fromMs: 10316, toMs: 16317, text: "A metric gets proposed too. Nothing is queryable until it's approved." },
    { fromMs: 16317, toMs: 18370, text: "Ticket volume ~3x baseline. SLA breaches from ~10% to ~35-50%." },
    { fromMs: 18370, toMs: 25222, text: "The insight becomes a drafted Jira ticket. Still amber." },
    { fromMs: 27636, toMs: 34867, text: "The human approves, one term at a time. Amber turns green." },
    { fromMs: 34867, toMs: 36987, text: "Ticket pushed. Every field traces back to a CSV row." },
  ],

  // Beats (video-relative, from video/raw/supply.json): board_loaded 2833, scenario_reset 2839,
  // draft_started 4343, term_proposed+approval_required obj_delay/obj_shipment/obj_supplier
  // 4661, term_proposed+approval_required m_on_time_delivery_rate/m_total_delay_cost_impact/
  // m_avg_days_late_per_supplier_tier 5614, term_proposed join_delays_shipments/
  // join_delays_suppliers/join_shipments_suppliers + m_delay_cost_per_unit/
  // m_high_risk_region_cost 5998, fit_view 8111, draft_completed 12010, approved:* 14625-24605,
  // terms_approved 26007, ask_started 27512, insight_landed 29062, fit_view 30554,
  // ask_completed 35125. Video duration 38128ms.
  //
  // This run's agent computes a RATE, so the insight caption states it. Verified against the
  // frame at 33s: SQL_RESULT row "Kestrel Logistics | 303 | 0.16501650165016502" and the
  // INSIGHT line "[warning] Kestrel Logistics has the highest late delivery rate at 16.5%,
  // leading a group of suppliers where nearly all exhibit double-digit late rates."
  //
  // Still true and still worth not captioning: the scenario PLANTS a 12%->65% anomaly, and
  // that is not what the agent found. Caption what is on screen, never the planted figure.
  supply: [
    { fromMs: 2839, toMs: 4343, text: "Switch scenarios live: supply chain, a schema the agent has never seen." },
    { fromMs: 4343, toMs: 5614, text: "It drafts again from scratch. Supplier, Shipment, Delay: all amber." },
    { fromMs: 5614, toMs: 12010, text: "Metrics and joins proposed too. No hardcoded rules for this domain." },
    { fromMs: 14625, toMs: 26007, text: "A human approves each term. Same gate, new domain." },
    { fromMs: 27512, toMs: 29062, text: "Ask: which supplier is driving late deliveries?" },
    { fromMs: 29062, toMs: 35125, text: "Kestrel Logistics: the highest late delivery rate, 16.5%. A rate, not a count." },
    { fromMs: 35125, toMs: 38128, text: "Not hardcoded. The agent found this on its own." },
  ],

  // Beats (video-relative, from video/raw/fintech.json): board_loaded 2745, scenario_reset 2747,
  // draft_started 4251, term_proposed+approval_required obj_account/obj_chargeback/
  // obj_transaction 4560, m_chargeback_rate 5800, m_high_risk_exposure_amount 6187,
  // m_unresolved_chargeback_value + m_avg_txn_value_by_channel 6864,
  // join_chargebacks_transactions/join_transactions_accounts + m_kyc_verification_rate 7238,
  // fit_view 8851, draft_completed 13257, approved:* 15875-25745, terms_approved 27147,
  // ask_started 28651, insight_landed 33424, fit_view 34745, ask_completed 39506. Video
  // duration 42508ms — ~4.4s longer than the previous capture, and the ask_started ->
  // insight_landed gap is now 4.8s, so that stretch is split into two cues rather than
  // holding one short line on screen for five seconds.
  //
  // Rate-based here too. Verified against the frame at 37s: SQL_RESULT row
  // "ecommerce | 1478 | 0.015561569688768605" and the INSIGHT line "[warning] The ecommerce
  // channel has the highest chargeback rate (1.56%), which is more than double the rate of
  // card-present transactions (0.68%)." The planted mobile_wallet spike is NOT what the agent
  // found, so it is not captioned.
  fintech: [
    { fromMs: 2747, toMs: 4251, text: "A third domain, same board: payments risk and chargebacks." },
    { fromMs: 4251, toMs: 5800, text: "It drafts again. Account, Chargeback, Transaction: all amber." },
    { fromMs: 5800, toMs: 13257, text: "Metrics and joins proposed too, same gate every time." },
    { fromMs: 15875, toMs: 27147, text: "A human approves each term before anything is queryable." },
    { fromMs: 28651, toMs: 31200, text: "Ask: which payment channel is driving chargebacks?" },
    { fromMs: 31200, toMs: 33424, text: "It can only reach for terms the human already signed off on." },
    { fromMs: 33424, toMs: 39506, text: "Ecommerce: a 1.56% chargeback rate, more than double card-present at 0.68%." },
    { fromMs: 39506, toMs: 42508, text: "Three domains. Same gate. Every number traces back to a row." },
  ],

  outro: [{ fromMs: 300, toMs: 3300, text: "An agent proposes. A human commits. Every hop is visible." }],
};

// SECOND annotation track. `captions` above is the narrative lower-third; this one is a
// small monospace band pinned to the TOP of the frame (Caption variant="tech"), naming what
// is actually executing at that beat — event names, function names, real thresholds. Same
// shape and same rules: scene-relative, sorted, non-overlapping within a scene.
//
// Timings are anchored to the SAME captured beats listed in the comments above each
// `captions` entry — no new beats were invented. Where several real beats land within a few
// hundred ms (e.g. supply's whole object cluster fires at 4661, and its joins + remaining
// metrics at 5998) the band spans them as one cue rather than flashing text nobody can read.
//
// Run `bun run check:captions` after any re-capture: it re-reads the sidecars and fails if a
// track drifted, overlaps, or stops short of the clip's real duration.
//
// TRUTHFULNESS: retail is a REPLAY of demo_events.jsonl (see the replay_started/
// replay_finished beats), so retail's band names only the event/wire-level facts, which are
// true of the replay. Supply and fintech are live agent runs, so those bands may name the
// actual BAML functions and Python call sites being executed. title/outro are full-screen
// chapter cards with nothing executing behind them, so they get no band.
export const techBand: CaptionTrack = {
  title: [],

  arch: [
    { fromMs: 300, toMs: 5200, text: "cerebras/gemma-4-31b via baml_client · Schema-Aligned Parsing" },
    { fromMs: 5200, toMs: 9800, text: "infer_fks(): x_id → x · containment ≥ 0.90 · confidence = ratio" },
    { fromMs: 9800, toMs: 14000, text: "guard_sql() → EXPLAIN → one retry with the error text" },
    { fromMs: 14000, toMs: 17400, text: "orchestration: plain python · asyncio.to_thread → bus → SSE" },
    { fromMs: 17400, toMs: 20000, text: "approval_required → ontology.yaml via tempfile + os.replace" },
  ],

  retail: [
    { fromMs: 2886, toMs: 5616, text: "replay_started · SSE /events → client reducer" },
    { fromMs: 5616, toMs: 6828, text: "ontology_term_proposed · kind=object · status=proposed" },
    { fromMs: 6828, toMs: 10316, text: "approval_required · subject_kind=ontology_term" },
    { fromMs: 10316, toMs: 16317, text: "metric term · confidence capped at 0.85 · gated either way" },
    { fromMs: 16317, toMs: 18370, text: "insight · sql_used · node_touched / edge_traversed" },
    { fromMs: 18370, toMs: 25222, text: "action_proposed · status=proposed · insight_ref set" },
    { fromMs: 27636, toMs: 34857, text: "approved → ontology.yaml rewritten atomically" },
    { fromMs: 34867, toMs: 36987, text: "all_approved → action_pushed" },
  ],

  supply: [
    { fromMs: 2839, toMs: 4343, text: "scenario_reset · DuckDB rebuilt from CSV" },
    { fromMs: 4343, toMs: 5614, text: "introspect() · information_schema + ≤10 sample rows/table" },
    { fromMs: 5614, toMs: 12010, text: "infer_fks() ≥ 0.90 containment · then DraftOntologyMetrics" },
    { fromMs: 14625, toMs: 26007, text: "approved terms are never clobbered by a later draft" },
    { fromMs: 27512, toMs: 29062, text: "AskQuestion → guard_sql() → EXPLAIN · one retry" },
    { fromMs: 29062, toMs: 35125, text: "InterpretQueryResult · node_touched / edge_traversed" },
    { fromMs: 35125, toMs: 38128, text: "no agent loop, no MCP — orchestration is plain Python" },
  ],

  fintech: [
    { fromMs: 2747, toMs: 4251, text: "same code path · zero domain-specific rules" },
    { fromMs: 4251, toMs: 5800, text: "introspect() → build_schema_prompt() · 65k context budget" },
    { fromMs: 5800, toMs: 13257, text: "DraftOntologyMetrics → validated against a BAML class" },
    { fromMs: 15875, toMs: 27147, text: "human approval required regardless of self-reported confidence" },
    { fromMs: 28651, toMs: 33424, text: "SELECT/WITH only · single statement · DDL/DML denylist" },
    { fromMs: 33424, toMs: 39506, text: "sql_result → InterpretQueryResult → insight" },
    { fromMs: 39506, toMs: 42508, text: "4 LLM call sites total: Draft · Ask · Interpret · DraftAction" },
  ],

  outro: [],
};
