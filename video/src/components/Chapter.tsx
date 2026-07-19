import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { colors } from "../colors";

// Overdamped (no bounce) — a build, not a bounce-in. Bar draws first, title rises in behind
// it, subtitle follows on a stagger, so the card reads as one small edit instead of a fade.
const BUILD_SPRING_CONFIG = { damping: 200, mass: 0.5 };
const BAR_BUILD_FRAMES = 16;
const TITLE_BUILD_FRAMES = 18;
const TITLE_DELAY_FRAMES = 5;
const SUBTITLE_BUILD_FRAMES = 18;
const SUBTITLE_DELAY_FRAMES = 11;

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
  const { fps } = useVideoConfig();

  const fadeOutOpacity =
    fadeOutDurationInFrames > 0
      ? interpolate(frame, [0, fadeOutDurationInFrames], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 1;

  const barIn = spring({ frame, fps, config: BUILD_SPRING_CONFIG, durationInFrames: BAR_BUILD_FRAMES });
  const titleIn = spring({
    frame,
    fps,
    config: BUILD_SPRING_CONFIG,
    durationInFrames: TITLE_BUILD_FRAMES,
    delay: TITLE_DELAY_FRAMES,
  });
  const subtitleIn = spring({
    frame,
    fps,
    config: BUILD_SPRING_CONFIG,
    durationInFrames: SUBTITLE_BUILD_FRAMES,
    delay: SUBTITLE_DELAY_FRAMES,
  });

  return (
    <AbsoluteFill
      style={{
        opacity: fadeOutOpacity,
        background: colors.bg,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          width: 84 * barIn,
          height: 6,
          background: accent,
          marginBottom: 36,
        }}
      />
      <div
        style={{
          opacity: titleIn,
          transform: `translateY(${interpolate(titleIn, [0, 1], [24, 0])}px)`,
          color: colors.text,
          fontSize: 76,
          fontWeight: 700,
          letterSpacing: 1,
        }}
      >
        {title}
      </div>
      {subtitle ? (
        <div
          style={{
            opacity: subtitleIn,
            transform: `translateY(${interpolate(subtitleIn, [0, 1], [18, 0])}px)`,
            color: accent,
            fontSize: 36,
            fontWeight: 500,
            marginTop: 20,
          }}
        >
          {subtitle}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
