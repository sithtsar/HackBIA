import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { colors } from "../colors";

/**
 * Thin top-edge progress bar spanning the whole DemoVideo so a viewer always knows how far
 * into the ~2min video they are. Reads useVideoConfig's durationInFrames directly, which is
 * only correct because this is mounted once at DemoVideo's own top level (never re-nested
 * inside another Sequence, where that value would report the wrong, outer duration).
 */
export const ProgressBar: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = frame / Math.max(durationInFrames - 1, 1);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 4,
          background: "rgba(230, 237, 243, 0.12)",
        }}
      >
        <div style={{ height: "100%", width: `${progress * 100}%`, background: colors.agentBlue }} />
      </div>
    </AbsoluteFill>
  );
};
