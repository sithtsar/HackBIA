import React from "react";
import { Composition, type AnyZodObject } from "remotion";
import { TitleCard } from "./compositions/TitleCard";
import { Outro } from "./compositions/Outro";
import { ScenarioScene, type ScenarioSceneProps } from "./compositions/ScenarioScene";
import { ArchScene } from "./compositions/ArchScene";
import { DemoVideo, type DemoVideoProps, TRANSITION_FRAMES } from "./DemoVideo";
import { captions, techBand } from "./captions";
import { SCENARIOS, sceneDurationMs, msToFrames, BOOKEND_MIN_MS } from "./scenarios";
import { footageExists } from "./footage";

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const titleDurationMs = sceneDurationMs(
  captions.title.map((c) => c.toMs),
  BOOKEND_MIN_MS,
);
// The arch scene has no footage — its length is simply "as long as its captions run".
const archDurationMs = sceneDurationMs(captions.arch.map((c) => c.toMs));
const outroDurationMs = sceneDurationMs(
  captions.outro.map((c) => c.toMs),
  BOOKEND_MIN_MS,
);
const scenes = SCENARIOS.map((scenario) => ({
  scenario,
  durationMs: sceneDurationMs(captions[scenario.id].map((c) => c.toMs)),
}));

const titleDurationInFrames = msToFrames(titleDurationMs, FPS);
const archDurationInFrames = msToFrames(archDurationMs, FPS);
const outroDurationInFrames = msToFrames(outroDurationMs, FPS);
const sceneDurationsInFrames = scenes.map((s) => msToFrames(s.durationMs, FPS));

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="TitleCard"
        component={TitleCard}
        durationInFrames={titleDurationInFrames}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />

      <Composition
        id="Arch"
        component={ArchScene}
        durationInFrames={archDurationInFrames}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />

      {scenes.map(({ scenario, durationMs }, i) => (
        <Composition<AnyZodObject, ScenarioSceneProps>
          key={scenario.id}
          id={capitalize(scenario.id)}
          component={ScenarioScene}
          durationInFrames={sceneDurationsInFrames[i] ?? msToFrames(durationMs, FPS)}
          fps={FPS}
          width={WIDTH}
          height={HEIGHT}
          defaultProps={{
            scenario,
            footageExists: false,
            captions: captions[scenario.id],
            techBand: techBand[scenario.id],
            durationInFrames: sceneDurationsInFrames[i] ?? msToFrames(durationMs, FPS),
          }}
          calculateMetadata={async ({ props }) => ({
            props: { ...props, footageExists: await footageExists(scenario.footageFile) },
          })}
        />
      ))}

      <Composition
        id="Outro"
        component={Outro}
        durationInFrames={outroDurationInFrames}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />

      <Composition<AnyZodObject, DemoVideoProps>
        id="DemoVideo"
        component={DemoVideo}
        // Crossfades overlap adjacent sequences, so the assembled video is shorter than the
        // sum of its parts by one TRANSITION_FRAMES per act boundary (scenes.length + 2 of
        // them: title->arch, arch->scene, scene->scene, scene->outro). See DemoVideo.tsx.
        durationInFrames={
          titleDurationInFrames +
          archDurationInFrames +
          sceneDurationsInFrames.reduce((a, b) => a + b, 0) +
          outroDurationInFrames -
          (scenes.length + 2) * TRANSITION_FRAMES
        }
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={{
          titleDurationInFrames,
          archDurationInFrames,
          outroDurationInFrames,
          scenes: scenes.map(({ scenario, durationMs }, i) => ({
            scenario,
            durationInFrames: sceneDurationsInFrames[i] ?? msToFrames(durationMs, FPS),
            footageExists: false,
          })),
        }}
        calculateMetadata={async ({ props }) => ({
          props: {
            ...props,
            scenes: await Promise.all(
              props.scenes.map(async (s) => ({
                ...s,
                footageExists: await footageExists(s.scenario.footageFile),
              })),
            ),
          },
        })}
      />
    </>
  );
};
