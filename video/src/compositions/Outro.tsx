import React from "react";
import { AbsoluteFill } from "remotion";
import { Chapter } from "../components/Chapter";
import { Caption } from "../components/Caption";
import { colors } from "../colors";
import { captions } from "../captions";

export const Outro: React.FC = () => (
  <AbsoluteFill>
    <Chapter title="EVERY NUMBER TRACES BACK" subtitle="Amber = proposed. Green = committed." accent={colors.committedGreen} />
    <Caption cues={captions.outro} />
  </AbsoluteFill>
);
