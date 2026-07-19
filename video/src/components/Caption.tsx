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

/**
 * Two annotation tracks, one timing implementation.
 *
 * - `narrative` (default): the big lower-third that carries the spoken story.
 * - `tech`: a small monospace band pinned to the TOP of the frame naming what is actually
 *   executing at that beat (see the `techBand` track in captions.ts).
 *
 * They are deliberately anchored to opposite edges and never share vertical space, so the
 * two tracks can both be on screen for the whole scene without colliding.
 */
export type CaptionVariant = "narrative" | "tech";

// ponytail: a `variant` branch, not two components — the entry/exit timing is the whole
// substance here and it's identical for both tracks. Split them only if a track needs
// genuinely different motion.
const VARIANT_STYLE: Record<CaptionVariant, React.CSSProperties> = {
  narrative: {
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
  },
  tech: {
    margin: "48px 0 0 90px",
    maxWidth: "80%",
    padding: "10px 20px",
    borderBottom: `3px solid ${colors.committedGreen}`,
    background: "rgba(14, 17, 22, 0.72)",
    color: colors.committedGreen,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 24,
    lineHeight: 1.3,
    fontWeight: 500,
    letterSpacing: 0.5,
  },
};

/** Shows the cue (if any) active at the scene's current frame. */
export const Caption: React.FC<{ cues: readonly CaptionCue[]; variant?: CaptionVariant }> = ({
  cues,
  variant = "narrative",
}) => {
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
  // Each track slides in from its own edge: the lower-third rises, the tech band drops.
  const slideFrom = variant === "tech" ? -ENTER_SLIDE_PX : ENTER_SLIDE_PX;
  const translateY = interpolate(enter, [0, 1], [slideFrom, 0], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        justifyContent: variant === "tech" ? "flex-start" : "flex-end",
        alignItems: "flex-start",
      }}
    >
      <div style={{ ...VARIANT_STYLE[variant], opacity, transform: `translateY(${translateY}px)` }}>
        {active.text}
      </div>
    </AbsoluteFill>
  );
};
