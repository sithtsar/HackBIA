# Foundry-Lite demo video (Remotion)

Separate Bun package, not part of `frontend/`. 1920x1080, 30fps, six compositions
(`TitleCard`, `Arch`, `Retail`, `Supply`, `Fintech`, `Outro`) assembled into one
deliverable composition, `DemoVideo`. `Arch` is the all-Remotion architecture
explainer (no footage); the three scenario scenes play captured board footage.

## Footage placement — READ THIS IF YOU'RE DROPPING IN CAPTURED CLIPS

Remotion only serves `staticFile()` assets from `public/`. Raw capture lands in
`video/raw/` (owned by the capture agent). **`public/raw` is a symlink to `../raw`** —
so just drop files straight into `video/raw/`, nothing to copy or sync.

Expected file names (must match exactly, case-sensitive):

```
video/raw/retail.webm
video/raw/supply.webm
video/raw/fintech.webm
```

If a file is missing, that scene renders a colored "FOOTAGE MISSING" placeholder card
instead of crashing — the pipeline is testable before capture exists. Existence is
checked per-scene via `calculateMetadata` doing a `HEAD` request against the static
file server (not `fs`, since `calculateMetadata` runs inside the same bundle as every
component — no separate Node phase, so `node:fs` can't be imported anywhere in the
module graph).

## Narration contract — `src/captions.ts`

Typed, scene-keyed caption track another agent fills in with real narration:

```ts
export type SceneId = "title" | "retail" | "supply" | "fintech" | "outro";
export interface Caption { fromMs: number; toMs: number; text: string }
export type CaptionTrack = Readonly<Record<SceneId, readonly Caption[]>>;
```

`fromMs`/`toMs` are **scene-relative** (0 = first frame of that scene, not the whole
video). Scene duration is derived from the latest `toMs` in that scene's array
(floored at 6s for scenario scenes, 3s for title/outro) — extending captions
automatically extends the scene, no duration to hand-sync elsewhere.

## Commands

```bash
bun install
bunx tsc --noEmit                                  # typecheck
bunx remotion studio src/index.ts                   # preview / scrub
bunx remotion render src/index.ts DemoVideo out/demo-video.mp4   # the deliverable
```

## Layout

- `src/colors.ts` — board palette, hand-synced with `docs/contracts.md`.
- `src/scenarios.ts` — the 3 scenario metadata + duration-from-captions helper.
- `src/captions.ts` — the narration contract (above).
- `src/footage.ts` — HEAD-request existence probe (Node-fs-free, see above).
- `src/components/` — `Caption` (lower third), `Chapter` (full-bleed title card),
  `FootageOrFallback` (`OffthreadVideo` or placeholder card).
- `src/compositions/` — `TitleCard`, `Outro`, `ScenarioScene` (footage + chapter +
  captions for one act).
- `src/DemoVideo.tsx` + `src/Root.tsx` — `<Series>` assembly and composition registry.
