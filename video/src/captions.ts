// INTEGRATION CONTRACT — the narration agent fills these arrays in, the video reads them.
// Keys are scene ids; each scene's captions are timed relative to that scene's OWN start
// (0ms = first frame of the scene, not the whole video). Keep entries sorted by fromMs and
// non-overlapping — Caption.tsx shows at most one at a time per scene.

export type SceneId = "title" | "retail" | "supply" | "fintech" | "outro";

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
// see frontend/capture.mjs). All three scenarios now have real footage + beat sidecars.
//
// KNOWN GAP: no capture run includes a rejected term. capture.mjs's approveAllPending()
// only ever approves, so demo_events.jsonl (retail's replay log) and the live supply/fintech
// runs all walk straight to all-green. The captions below describe the gate truthfully (every
// term needs a human decision) without claiming this footage shows a reject, because it
// doesn't. The real "human refuses something" beat lives in docs/DEMO.md's Act 2 instead,
// where a live presenter clicks Reject for real.
export const captions: CaptionTrack = {
  title: [{ fromMs: 500, toMs: 3000, text: "Insights die in dashboards. No lineage, no trust." }],

  // Beats (video-relative, from video/raw/retail.json): board_loaded 2893, replay_started
  // 2898, term_proposed obj_customer/obj_order/obj_ticket 5640-6551, approval_required
  // 6857-7538, term_proposed m_active_customer 10287, insight_landed 15750, action_proposed
  // 17874, replay_finished 24578, approved:* 27027-34096 (script plays the human), all_approved
  // 34096, action_pushed 34100. Video duration 36240ms; last cue ends there so the whole
  // clip plays instead of getting cut short by Series.
  retail: [
    { fromMs: 2898, toMs: 5640, text: "The agent reads the raw CSVs and drafts an ontology." },
    { fromMs: 5640, toMs: 10287, text: "Customer, Order, Ticket: proposed. Amber means waiting on a human." },
    { fromMs: 10287, toMs: 15750, text: "A metric gets proposed too. Nothing is queryable until it's approved." },
    { fromMs: 15750, toMs: 19000, text: "Ticket volume up ~3x. SLA breaches 10% to 40% in 14 days. SQL visible." },
    { fromMs: 19000, toMs: 24578, text: "The insight becomes a drafted Jira ticket. Still amber." },
    { fromMs: 27027, toMs: 34096, text: "The human approves, one term at a time. Amber turns green." },
    { fromMs: 34100, toMs: 36240, text: "Ticket pushed. Every field traces back to a CSV row." },
  ],

  // Beats (video-relative, from video/raw/supply.json): board_loaded 2883, scenario_reset
  // 2887, draft_started 4392, term_proposed cluster (objects) 4699, term_proposed cluster
  // (joins+metrics) 5612, draft_completed 11856, approved:* 14476-24379, terms_approved
  // 25783, ask_started 27289, insight_landed 28533, ask_completed 34780. Video duration 37783ms.
  //
  // The insight caption names the answer this recorded run actually produced (read off the
  // agent feed panel, not the scenario's planted 12%->65% rate anomaly) -- the live agent's
  // SQL here groups by supplier and counts, so it surfaces the highest raw delay COUNT
  // (Kestrel Logistics) rather than computing a per-supplier RATE. That's a real, grounded
  // answer to the literal question asked, just not the deeper rate-based story beat; see
  // docs/DEMO.md for where a live presenter can dig into the rate manually. Do not caption
  // numbers that never appear on screen.
  supply: [
    { fromMs: 2887, toMs: 4392, text: "Switch scenarios live: supply chain, a schema the agent has never seen." },
    { fromMs: 4392, toMs: 5612, text: "It drafts again from scratch. Supplier, Shipment, Delay: all amber." },
    { fromMs: 5612, toMs: 11856, text: "Metrics and joins proposed too. No hardcoded rules for this domain." },
    { fromMs: 14476, toMs: 25783, text: "A human approves each term. Same gate, new domain." },
    { fromMs: 27289, toMs: 28533, text: "Ask: which supplier is driving late deliveries?" },
    { fromMs: 28533, toMs: 34780, text: "Kestrel Logistics surfaces as the top driver, with SQL and lineage both visible." },
    { fromMs: 34780, toMs: 37783, text: "Not hardcoded. The agent found this on its own." },
  ],

  // Beats (video-relative, from video/raw/fintech.json): board_loaded 2919, scenario_reset
  // 2920, draft_started 4429, term_proposed cluster (objects) 4737, term_proposed cluster
  // (joins+metrics) 5651, draft_completed 11874, approved:* 14498-24400, terms_approved
  // 25802, ask_started 27309, insight_landed 28853, ask_completed 35068. Video duration 38070ms.
  //
  // Same honesty note as supply above: this run's agent SQL groups transactions by channel
  // and counts chargebacks (not a per-channel rate), so it names "ecommerce" rather than the
  // scenario's planted mobile_wallet rate spike. Captioned to match the actual feed text.
  fintech: [
    { fromMs: 2920, toMs: 4429, text: "A third domain, same board: payments risk and chargebacks." },
    { fromMs: 4429, toMs: 5651, text: "It drafts again. Account, Chargeback, Transaction: all amber." },
    { fromMs: 5651, toMs: 11874, text: "Metrics and joins proposed too, same gate every time." },
    { fromMs: 14498, toMs: 25802, text: "A human approves each term before anything is queryable." },
    { fromMs: 27309, toMs: 28853, text: "Ask: which payment channel is driving chargebacks?" },
    { fromMs: 28853, toMs: 35068, text: "Ecommerce surfaces as the top driver, real SQL grounded in the data." },
    { fromMs: 35068, toMs: 38070, text: "Three domains. Same gate. Every number traces back to a row." },
  ],

  outro: [{ fromMs: 300, toMs: 3300, text: "An agent proposes. A human commits. Every hop is visible." }],
};
