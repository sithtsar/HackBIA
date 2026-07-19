// Run: bun run check:captions
//
// Guards the one thing that actually broke last time: a re-capture shifts every beat and
// changes each clip's duration, and the caption tracks silently keep the old numbers. Stale
// cues either claim a thing happened before it does, or stop short of the clip end — and
// because each scene's duration derives from its max toMs (see scenarios.ts), stopping short
// truncates the footage.
//
// ponytail: asserts against the sidecars, no test framework. It cannot check that the cue
// TEXT is true — only a human looking at the frame can do that.

import { readFileSync } from "node:fs";
import { captions, techBand, type Caption, type CaptionTrack, type SceneId } from "./captions";
import { SCENARIOS } from "./scenarios";

interface Sidecar {
  duration_ms: number;
  beats: readonly { t_ms: number; name: string }[];
}

const fail: string[] = [];
const check = (ok: boolean, msg: string): void => {
  if (!ok) fail.push(msg);
};

/** Sorted, non-overlapping, positive-width — required by Caption.tsx's `find` lookup. */
const checkShape = (track: string, scene: SceneId, cues: readonly Caption[]): void => {
  cues.forEach((cue, i) => {
    check(cue.toMs > cue.fromMs, `${track}.${scene}[${i}]: toMs ${cue.toMs} <= fromMs ${cue.fromMs}`);
    const prev = cues[i - 1];
    if (prev) {
      check(
        cue.fromMs >= prev.toMs,
        `${track}.${scene}[${i}]: starts ${cue.fromMs} before previous ends ${prev.toMs}`,
      );
    }
  });
};

for (const track of ["captions", "techBand"] as const) {
  const data: CaptionTrack = track === "captions" ? captions : techBand;
  for (const scene of Object.keys(data) as SceneId[]) {
    checkShape(track, scene, data[scene]);
  }
}

for (const { id, footageFile } of SCENARIOS) {
  const path = new URL(`../raw/${footageFile.replace(/\.webm$/, ".json")}`, import.meta.url);
  const sidecar = JSON.parse(readFileSync(path, "utf8")) as Sidecar;
  const firstBeat = Math.min(...sidecar.beats.map((b) => b.t_ms));

  for (const track of ["captions", "techBand"] as const) {
    const cues = (track === "captions" ? captions : techBand)[id];
    const last = cues[cues.length - 1];
    const first = cues[0];
    if (!last || !first) {
      fail.push(`${track}.${id}: empty, but ${id} is a footage scene`);
      continue;
    }
    // The last cue must reach the real clip end, or scenarios.ts truncates the footage.
    check(
      last.toMs === sidecar.duration_ms,
      `${track}.${id}: last cue ends ${last.toMs} but ${id}.webm is ${sidecar.duration_ms}ms — footage would be cut`,
    );
    // Nothing may be captioned over the blank frames before the board even loads.
    check(
      first.fromMs >= firstBeat,
      `${track}.${id}: first cue at ${first.fromMs} precedes the first beat at ${firstBeat}`,
    );
    for (const cue of cues) {
      check(
        cue.toMs <= sidecar.duration_ms,
        `${track}.${id}: cue ends ${cue.toMs}, past the ${sidecar.duration_ms}ms clip`,
      );
    }
  }
}

if (fail.length > 0) {
  console.error(`captions.check: ${fail.length} problem(s)\n` + fail.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("captions.check: ok");
