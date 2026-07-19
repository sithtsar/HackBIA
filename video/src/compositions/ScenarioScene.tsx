import React from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { FootageOrFallback } from "../components/FootageOrFallback";
import { Chapter } from "../components/Chapter";
import { Caption } from "../components/Caption";
import type { ScenarioMeta } from "../scenarios";
import type { Caption as CaptionCue } from "../captions";

const CHAPTER_FADE_MS = 1400;

// `type`, not `interface` — Composition's props generic is constrained to
// Record<string, unknown> and only type-literal aliases satisfy that structurally.
export type ScenarioSceneProps = {
  scenario: ScenarioMeta;
  footageExists: boolean;
  captions: readonly CaptionCue[];
  /** This scene's own duration in frames — see the note in FootageOrFallback.tsx. */
  durationInFrames: number;
};

/** One act: footage (or fallback) full-bleed, a fading chapter title over the opening, captions throughout. */
export const ScenarioScene: React.FC<ScenarioSceneProps> = ({
  scenario,
  footageExists,
  captions,
  durationInFrames,
}) => {
  const { fps } = useVideoConfig();
  const fadeFrames = Math.round((CHAPTER_FADE_MS / 1000) * fps);

  return (
    <AbsoluteFill>
      <FootageOrFallback
        fileName={scenario.footageFile}
        exists={footageExists}
        label={scenario.id}
        durationInFrames={durationInFrames}
      />
      <Chapter
        title={scenario.chapterTitle}
        subtitle={scenario.chapterSubtitle}
        fadeOutDurationInFrames={fadeFrames}
      />
      <Caption cues={captions} />
    </AbsoluteFill>
  );
};
