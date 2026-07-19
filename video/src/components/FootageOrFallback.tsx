import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import { colors } from "../colors";

/**
 * Plays public/raw/<fileName> if it exists, else degrades to a colored placeholder card so
 * the pipeline renders end to end before footage is captured. `exists` is computed Node-side
 * in a calculateMetadata callback (see footage.ts) — never probed at render time.
 */
export const FootageOrFallback: React.FC<{
  fileName: string;
  exists: boolean;
  label: string;
}> = ({ fileName, exists, label }) => {
  if (exists) {
    return <OffthreadVideo src={staticFile(`raw/${fileName}`)} />;
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
