import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { colors } from "../colors";

/**
 * Full-bleed title/chapter card. Used standalone (TitleCard, Outro) and as a fading intro
 * overlay at the start of each scenario scene.
 */
export const Chapter: React.FC<{
  title: string;
  subtitle?: string;
  accent?: string;
  /** Frames over which this card fades out. 0 = stays fully opaque (e.g. the title card). */
  fadeOutDurationInFrames?: number;
}> = ({ title, subtitle, accent = colors.agentBlue, fadeOutDurationInFrames = 0 }) => {
  const frame = useCurrentFrame();
  const opacity =
    fadeOutDurationInFrames > 0
      ? interpolate(frame, [0, fadeOutDurationInFrames], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 1;

  return (
    <AbsoluteFill
      style={{
        opacity,
        background: colors.bg,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          width: 84,
          height: 6,
          background: accent,
          marginBottom: 36,
        }}
      />
      <div style={{ color: colors.text, fontSize: 76, fontWeight: 700, letterSpacing: 1 }}>
        {title}
      </div>
      {subtitle ? (
        <div style={{ color: accent, fontSize: 36, fontWeight: 500, marginTop: 20 }}>
          {subtitle}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
