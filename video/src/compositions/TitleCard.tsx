import React from "react";
import { AbsoluteFill } from "remotion";
import { Chapter } from "../components/Chapter";
import { Caption } from "../components/Caption";
import { colors } from "../colors";
import { captions } from "../captions";

export const TitleCard: React.FC = () => (
  <AbsoluteFill>
    <Chapter title="FOUNDRY-LITE" subtitle="Propose. Approve. Trace." accent={colors.agentBlue} />
    <Caption cues={captions.title} />
  </AbsoluteFill>
);
