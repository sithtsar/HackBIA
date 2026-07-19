import React from "react";
import { Composition, type AnyZodObject } from "remotion";
import { TitleCard } from "./compositions/TitleCard";
import { Outro } from "./compositions/Outro";
import { ScenarioScene, type ScenarioSceneProps } from "./compositions/ScenarioScene";
import { DemoVideo, type DemoVideoProps, TRANSITION_FRAMES } from "./DemoVideo";
import { captions } from "./captions";
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
const outroDurationMs = sceneDurationMs(
  captions.outro.map((c) => c.toMs),
  BOOKEND_MIN_MS,
);
const scenes = SCENARIOS.map((scenario) => ({
  scenario,
  durationMs: sceneDurationMs(captions[scenario.id].map((c) => c.toMs)),
}));

const titleDurationInFrames = msToFrames(titleDurationMs, FPS);
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
        // sum of its parts by one TRANSITION_FRAMES per act boundary (scenes.length + 1 of
        // them: title->scene, scene->scene, scene->outro). See the note in DemoVideo.tsx.
        durationInFrames={
          titleDurationInFrames +
          sceneDurationsInFrames.reduce((a, b) => a + b, 0) +
          outroDurationInFrames -
          (scenes.length + 1) * TRANSITION_FRAMES
        }
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={{
          titleDurationInFrames,
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
