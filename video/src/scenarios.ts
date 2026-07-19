// Mirrors backend/app/scenarios.py — three switchable demo domains.

export type ScenarioId = "retail" | "supply" | "fintech";

export interface ScenarioMeta {
  id: ScenarioId;
  /** File name under video/raw/ (and therefore video/public/raw/, see README). */
  footageFile: string;
  chapterTitle: string;
  chapterSubtitle: string;
}

export const SCENARIOS: readonly ScenarioMeta[] = [
  {
    id: "retail",
    footageFile: "retail.webm",
    chapterTitle: "ACT 1 — RETAIL",
    chapterSubtitle: "Why did support tickets spike?",
  },
  {
    id: "supply",
    footageFile: "supply.webm",
    chapterTitle: "ACT 2 — SUPPLY CHAIN",
    chapterSubtitle: "Which supplier is driving late deliveries?",
  },
  {
    id: "fintech",
    footageFile: "fintech.webm",
    chapterTitle: "ACT 3 — FINTECH",
    chapterSubtitle: "Which payment channel is driving chargebacks?",
  },
];

const MIN_SCENE_MS = 6000;
const MIN_BOOKEND_MS = 3000;

/** Scene duration = latest caption end, floored so a scene with no captions yet still renders. */
export function sceneDurationMs(captionEndsMs: readonly number[], minMs = MIN_SCENE_MS): number {
  const latest = captionEndsMs.reduce((max, ms) => Math.max(max, ms), 0);
  return Math.max(latest, minMs);
}

export const BOOKEND_MIN_MS = MIN_BOOKEND_MS;

export function msToFrames(ms: number, fps: number): number {
  return Math.ceil((ms / 1000) * fps);
}
