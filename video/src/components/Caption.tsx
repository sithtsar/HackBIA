import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import type { Caption as CaptionCue } from "../captions";
import { colors } from "../colors";

const EXIT_MS = 260;
const ENTER_BUILD_FRAMES = 12;
const ENTER_SLIDE_PX = 24;

// Overdamped spring for entry (no bounce) — captions carry the narration and must stay
// perfectly legible, so the text only ever moves during its own fade-in/out window, never
// while fully on screen, and it's isolated from Ken Burns / scene transitions (own layer).
const ENTER_SPRING_CONFIG = { damping: 200, mass: 0.5 };

/** Lower-third caption: shows the cue (if any) active at the scene's current frame. */
export const Caption: React.FC<{ cues: readonly CaptionCue[] }> = ({ cues }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = (frame / fps) * 1000;

  const active = cues.find((cue) => nowMs >= cue.fromMs && nowMs < cue.toMs);
  if (!active) return null;

  const startFrame = Math.round((active.fromMs / 1000) * fps);
  const enter = Math.min(
    1,
    spring({
      frame: frame - startFrame,
      fps,
      config: ENTER_SPRING_CONFIG,
      durationInFrames: ENTER_BUILD_FRAMES,
    }),
  );
  const exitOpacity = interpolate(nowMs, [active.toMs - EXIT_MS, active.toMs], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const opacity = Math.min(enter, exitOpacity);
  const translateY = interpolate(enter, [0, 1], [ENTER_SLIDE_PX, 0], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-start" }}>
      <div
        style={{
          opacity,
          transform: `translateY(${translateY}px)`,
          margin: "0 0 90px 90px",
          maxWidth: "70%",
          padding: "20px 32px",
          borderLeft: `6px solid ${colors.agentBlue}`,
          background: "rgba(14, 17, 22, 0.82)",
          color: colors.text,
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontSize: 38,
          lineHeight: 1.35,
          fontWeight: 500,
        }}
      >
        {active.text}
      </div>
    </AbsoluteFill>
  );
};
