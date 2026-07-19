import React from "react";
import { Series } from "remotion";
import { TitleCard } from "./compositions/TitleCard";
import { Outro } from "./compositions/Outro";
import { ScenarioScene } from "./compositions/ScenarioScene";
import { captions } from "./captions";
import type { ScenarioMeta } from "./scenarios";

export type DemoVideoScene = {
  scenario: ScenarioMeta;
  durationInFrames: number;
  footageExists: boolean;
};

// `type`, not `interface` — see the note in compositions/ScenarioScene.tsx.
export type DemoVideoProps = {
  titleDurationInFrames: number;
  outroDurationInFrames: number;
  scenes: readonly DemoVideoScene[];
};

/** The deliverable: title card -> one scene per scenario -> outro, back to back. */
export const DemoVideo: React.FC<DemoVideoProps> = ({
  titleDurationInFrames,
  outroDurationInFrames,
  scenes,
}) => (
  <Series>
    <Series.Sequence durationInFrames={titleDurationInFrames}>
      <TitleCard />
    </Series.Sequence>
    {scenes.map((scene) => (
      <Series.Sequence key={scene.scenario.id} durationInFrames={scene.durationInFrames}>
        <ScenarioScene
          scenario={scene.scenario}
          footageExists={scene.footageExists}
          captions={captions[scene.scenario.id]}
        />
      </Series.Sequence>
    ))}
    <Series.Sequence durationInFrames={outroDurationInFrames}>
      <Outro />
    </Series.Sequence>
  </Series>
);
