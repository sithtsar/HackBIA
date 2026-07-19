import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, interpolate } from "remotion";
import { colors } from "../colors";

// Ken Burns ceiling — never below 1.0 (would expose the video's edges) and kept small
// because this is a UI screen recording: heavy zoom makes small text mushy and unreadable.
//
// The pan direction is load-bearing, not taste. `scale(s) translate(x%, y%)` applies
// right-to-left, so the pan is scaled too and STACKS with the symmetric crop instead of
// cancelling it: at 1.06 with x=-1.5% the left edge lost 3% + 1.5%*1.06 ≈ 88px, which ate
// the first word of the legend in the bottom-left corner. Positive x / negative y bias the
// surviving frame toward that corner, and a lower ceiling keeps the crop small enough that
// the board's chrome survives at every point in the drift.
const KEN_BURNS_MAX_SCALE = 1.03;
const KEN_BURNS_PAN_X_PERCENT = 0.4;
const KEN_BURNS_PAN_Y_PERCENT = -0.4;

/**
 * Plays public/raw/<fileName> if it exists, else degrades to a colored placeholder card so
 * the pipeline renders end to end before footage is captured. `exists` is computed Node-side
 * in a calculateMetadata callback (see footage.ts) — never probed at render time.
 *
 * `durationInFrames` is this scene's own local duration (not useVideoConfig's, which reports
 * the whole DemoVideo when nested) — it's what the Ken Burns drift paces itself against.
 */
export const FootageOrFallback: React.FC<{
  fileName: string;
  exists: boolean;
  label: string;
  durationInFrames: number;
}> = ({ fileName, exists, label, durationInFrames }) => {
  const frame = useCurrentFrame();

  if (exists) {
    const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    const scale = interpolate(progress, [0, 1], [1, KEN_BURNS_MAX_SCALE]);
    const panX = interpolate(progress, [0, 1], [0, KEN_BURNS_PAN_X_PERCENT]);
    const panY = interpolate(progress, [0, 1], [0, KEN_BURNS_PAN_Y_PERCENT]);

    return (
      <AbsoluteFill style={{ overflow: "hidden" }}>
        <OffthreadVideo
          src={staticFile(`raw/${fileName}`)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: `scale(${scale}) translate(${panX}%, ${panY}%)`,
            transformOrigin: "center center",
          }}
        />
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill
      style={{
        background: colors.bg,
        border: `3px dashed ${colors.pendingAmber}`,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ color: colors.pendingAmber, fontSize: 44, fontWeight: 700 }}>
        FOOTAGE MISSING
      </div>
      <div style={{ color: colors.text, fontSize: 28, marginTop: 12, opacity: 0.7 }}>
        expected public/raw/{fileName} — {label}
      </div>
    </AbsoluteFill>
  );
};
