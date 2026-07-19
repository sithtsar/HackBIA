import React from "react";
import { AbsoluteFill } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { TitleCard } from "./compositions/TitleCard";
import { Outro } from "./compositions/Outro";
import { ScenarioScene } from "./compositions/ScenarioScene";
import { ArchScene } from "./compositions/ArchScene";
import { ProgressBar } from "./components/ProgressBar";
import { captions, techBand } from "./captions";
import type { ScenarioMeta } from "./scenarios";

export type DemoVideoScene = {
  scenario: ScenarioMeta;
  durationInFrames: number;
  footageExists: boolean;
};

// `type`, not `interface` — see the note in compositions/ScenarioScene.tsx.
export type DemoVideoProps = {
  titleDurationInFrames: number;
  /** The all-Remotion architecture explainer, between the title card and Act 1. */
  archDurationInFrames: number;
  outroDurationInFrames: number;
  scenes: readonly DemoVideoScene[];
};

// A crossfade at every act boundary instead of a hard cut. Each TransitionSeries.Sequence
// still gets its own full local frame range (0..durationInFrames-1) — captions and Ken Burns
// key off that local frame, so overlapping the boundary does NOT desync them. What it does
// change: the total assembled video is shorter than the sum of the scene durations, by
// TRANSITION_FRAMES per boundary (title->arch->3 scenes->outro = 5 boundaries) — Root.tsx's DemoVideo composition
// duration accounts for that explicitly so playback doesn't run past the real content.
export const TRANSITION_FRAMES = 15;

const transition = () => (
  <TransitionSeries.Transition
    presentation={fade()}
    timing={linearTiming({ durationInFrames: TRANSITION_FRAMES })}
  />
);

/** The deliverable: title -> architecture -> one scene per scenario -> outro, crossfading at each cut. */
export const DemoVideo: React.FC<DemoVideoProps> = ({
  titleDurationInFrames,
  archDurationInFrames,
  outroDurationInFrames,
  scenes,
}) => (
  <AbsoluteFill>
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={titleDurationInFrames}>
        <TitleCard />
      </TransitionSeries.Sequence>
      {transition()}
      <TransitionSeries.Sequence durationInFrames={archDurationInFrames}>
        <ArchScene />
      </TransitionSeries.Sequence>
      {transition()}
      {scenes.map((scene, i) => (
        <React.Fragment key={scene.scenario.id}>
          <TransitionSeries.Sequence durationInFrames={scene.durationInFrames}>
            <ScenarioScene
              scenario={scene.scenario}
              footageExists={scene.footageExists}
              captions={captions[scene.scenario.id]}
              techBand={techBand[scene.scenario.id]}
              durationInFrames={scene.durationInFrames}
            />
          </TransitionSeries.Sequence>
          {i < scenes.length - 1 ? transition() : null}
        </React.Fragment>
      ))}
      {transition()}
      <TransitionSeries.Sequence durationInFrames={outroDurationInFrames}>
        <Outro />
      </TransitionSeries.Sequence>
    </TransitionSeries>
    <ProgressBar />
  </AbsoluteFill>
);
