import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import type { Caption as CaptionCue } from "../captions";
import { colors } from "../colors";

const FADE_MS = 200;

/** Lower-third caption: shows the cue (if any) active at the scene's current frame. */
export const Caption: React.FC<{ cues: readonly CaptionCue[] }> = ({ cues }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = (frame / fps) * 1000;

  const active = cues.find((cue) => nowMs >= cue.fromMs && nowMs < cue.toMs);
  if (!active) return null;

  const opacity = interpolate(
    nowMs,
    [active.fromMs, active.fromMs + FADE_MS, active.toMs - FADE_MS, active.toMs],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-start" }}>
      <div
        style={{
          opacity,
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
