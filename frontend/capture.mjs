// ponytail: capture harness for the demo video. Playwright drives the real
// board (headless chromium, bundled — no channel:"chrome", it isn't
// installed here) and records raw .webm footage while this script plays
// "human approver" against the live API and timestamps the beats Remotion
// needs to caption. Modeled on shots.mjs: SSE means networkidle never
// fires, so domcontentloaded + explicit waits.
//
// Orchestration polls GET /api/state (contracts.md explicitly allows this
// instead of watching SSE) rather than subscribing to /api/events itself:
// Bun's fetch/http streaming does not deliver text/event-stream chunks
// incrementally on this machine (verified — curl streams fine, bun's
// reader.read() never resolves until the connection closes), so an SSE
// subscriber here would just hang. The page's own EventSource is what
// actually renders the board for the video; polling only needs to know
// what to approve and when a run has settled.
import { chromium } from "playwright";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    return [k, rest.length ? rest.join("=") : true];
  }),
);
const scenario = argv.scenario ?? "retail";
const baseUrl = argv.url ?? "http://localhost:8420";
if (!["retail", "supply", "fintech"].includes(scenario)) {
  console.error(`unknown --scenario ${scenario} (want retail|supply|fintech)`);
  process.exit(1);
}

const QUESTIONS = {
  retail: "Why did support tickets spike recently?",
  supply: "Which supplier is driving our late deliveries?",
  fintech: "Which payment channel is driving chargebacks?",
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "video", "raw");
await mkdir(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJSON(pathname, body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`POST ${pathname} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchState() {
  const res = await fetch(`${baseUrl}/api/state`);
  if (!res.ok) throw new Error(`GET /api/state -> ${res.status}`);
  return res.json();
}

async function approve(subjectId) {
  return postJSON(`/api/approvals/${subjectId}`, { decision: "approved" });
}

// --- beat log ---------------------------------------------------------
// t0 is set right after the recording context is created, so beat times
// are milliseconds from the start of the .webm — exactly what Remotion
// needs to sync captions.
let t0 = 0;
const beats = [];
function beat(name) {
  const t_ms = Date.now() - t0;
  beats.push({ name, t_ms });
  console.log(`[${(t_ms / 1000).toFixed(1)}s] ${name}`);
}

// --- state polling / diffing ------------------------------------------
// Tracks what we've already seen so repeated polls only beat on change.
const seen = { terms: new Set(), pending: new Set(), actions: new Map(), insightNodes: new Set() };

function diffAndBeat(state) {
  for (const t of state.terms) {
    if (!seen.terms.has(t.id)) {
      seen.terms.add(t.id);
      beat(`term_proposed:${t.id}`);
    }
  }
  for (const p of state.pending) {
    if (!seen.pending.has(p.subject_id)) {
      seen.pending.add(p.subject_id);
      beat(`approval_required:${p.subject_id}`);
    }
  }
  for (const a of state.actions) {
    const prevStatus = seen.actions.get(a.id);
    if (prevStatus === undefined) beat(`action_proposed:${a.id}`);
    if (prevStatus !== a.status) {
      if (a.status === "pushed") beat(`action_pushed:${a.id}`);
      seen.actions.set(a.id, a.status);
    }
  }
  for (const n of state.graph.nodes) {
    if (n.kind === "insight" && !seen.insightNodes.has(n.id)) {
      seen.insightNodes.add(n.id);
      beat("insight_landed");
    }
  }
}

function snapshotKey(state) {
  return JSON.stringify({
    terms: state.terms.map((t) => t.id).sort(),
    pending: state.pending.map((p) => p.subject_id).sort(),
    actions: state.actions.map((a) => `${a.id}:${a.status}`).sort(),
    nodes: state.graph.nodes.map((n) => n.id).sort(),
  });
}

// Polls until the board stops changing for `stableFor` ms — the closest
// polling proxy for "the run finished" (run_completed isn't exposed via
// /api/state, only via the event stream). stableFor must comfortably clear
// the longest real gap between state-touching events: in the recorded
// retail log that's ~5.3s (the ask flow's SQL execution between the last
// ontology approval and the insight landing), so 6s with margin.
async function waitForQuiescence({ timeout = 90000, stableFor = 6000, interval = 300, label = "run" } = {}) {
  const start = Date.now();
  let lastKey = null;
  let lastChangeAt = Date.now();
  let state = null;
  for (;;) {
    state = await fetchState();
    diffAndBeat(state);
    const key = snapshotKey(state);
    if (key !== lastKey) {
      lastKey = key;
      lastChangeAt = Date.now();
    }
    if (Date.now() - lastChangeAt >= stableFor) {
      await fitViewIfGrown(state);
      return state;
    }
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label} to settle`);
    await sleep(interval);
  }
}

// --- viewport fit ---------------------------------------------------------
// Canvas.tsx's calm viewport (frontend/src/components/Canvas.tsx) never
// moves the camera on its own: new nodes surface a "N new · fit view" chip
// (NewNodesChip, bottom-center) for a human to click, or accept a
// `foundry:fit` window event (FitOnEvent). This harness has no human in it,
// so once a burst of new nodes has landed and settled -- i.e. right where
// waitForQuiescence's poll loop above already detects stability, not on
// every single mutation -- drive the same path a human would: click the
// chip when it's showing (a real user gesture, visible in the footage as
// intentional), else dispatch the event when the node count grew without a
// chip appearing (e.g. the growth was already inside the viewport).
// fitView animates over 250ms; the sleep below outlasts that before the
// next action starts.
let lastFitNodeCount = 0;
async function fitViewIfGrown(state) {
  if (state.graph.nodes.length <= lastFitNodeCount) return;
  lastFitNodeCount = state.graph.nodes.length;
  const chip = page.getByRole("button", { name: /new · fit view/ });
  if (await chip.isVisible().catch(() => false)) {
    await chip.click();
    beat("fit_view:chip");
  } else {
    await page.evaluate(() => window.dispatchEvent(new Event("foundry:fit")));
    beat("fit_view:event");
  }
  await sleep(400);
}

// Approve pending subjects one at a time with a visible gap between clicks
// so the amber->green transition and lineage glow are each on screen long
// enough to read, not a single blurred flash.
async function approveAllPending(ids, { gap = 1400 } = {}) {
  for (const id of ids) {
    await sleep(gap);
    await approve(id);
    beat(`approved:${id}`);
  }
  await sleep(gap);
}

// --- drive the board ----------------------------------------------------
// Reset the backend to THIS scenario's clean baseline before the browser
// even exists. frontend/src/store.ts fetches GET /api/state exactly once on
// mount and every SSE event after that is reduced incrementally onto that
// snapshot (see reduceBoard in frontend/src/reducer.ts) -- there is no
// "clear the graph" event. Capture runs share one long-lived backend
// process (retail, then supply, then fintech, back to back), so if the page
// were loaded first and reset second (the old order), the page would mount
// on the PREVIOUS scenario's fully-approved board and the new scenario's
// nodes would just pile on top of it for the rest of the recording. Reset
// now, before the page (or even the browser) exists, so the page's one
// mount-time fetch is already clean.
await postJSON("/api/demo/reset", { scenario });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: OUT_DIR, size: { width: 1920, height: 1080 } },
});
t0 = Date.now();

const page = await context.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
await sleep(2500);
beat("board_loaded");
// Baseline for fitViewIfGrown: the nodes present at mount are already
// framed by ReactFlow's own `fitView` prop, so only count nodes added
// after this point as a "burst" worth fitting for.
lastFitNodeCount = (await fetchState()).graph.nodes.length;

if (scenario === "retail") {
  // Already reset above; skip /api/replay's own reset:true so it doesn't
  // reseed (and briefly re-blank the now-connected board) a second time.
  await postJSON("/api/replay", { speed: 0.8, reset: false });
  beat("replay_started");
  const state = await waitForQuiescence({ timeout: 30000, label: "replay" });
  beat("replay_finished");
  await sleep(1000);
  await approveAllPending(state.pending.map((p) => p.subject_id));
  beat("all_approved");
  // One more settle pass: approving the action kicks off an async push
  // (action_pushed), catch it and hold the final green state on screen.
  await waitForQuiescence({ timeout: 8000, stableFor: 2000, label: "post-approval settle" });
} else {
  beat("scenario_reset");
  await sleep(1500);

  await postJSON("/api/ontology/draft", {});
  beat("draft_started");
  const afterDraft = await waitForQuiescence({ timeout: 120000, label: "ontology draft" });
  beat("draft_completed");
  await sleep(1200);

  await approveAllPending(afterDraft.pending.map((p) => p.subject_id));
  beat("terms_approved");
  await sleep(1500);

  await postJSON("/api/ask", { question: QUESTIONS[scenario] });
  beat("ask_started");
  await waitForQuiescence({ timeout: 120000, label: "ask" });
  beat("ask_completed");
  await sleep(3000);
}

const durationMs = Date.now() - t0;
await context.close();
await browser.close();

const videoPath = await page.video().path();
const dest = path.join(OUT_DIR, `${scenario}.webm`);
await rm(dest, { force: true });
await rename(videoPath, dest);

const sidecar = {
  scenario,
  url: baseUrl,
  recorded_at: new Date(t0).toISOString(),
  duration_ms: durationMs,
  beats,
};
await writeFile(path.join(OUT_DIR, `${scenario}.json`), JSON.stringify(sidecar, null, 2));

console.log(`DONE: ${dest} (${(durationMs / 1000).toFixed(1)}s)`);
process.exit(0);
