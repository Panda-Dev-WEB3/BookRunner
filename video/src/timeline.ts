import type { SceneId } from "./copy";

/** Scene durations in frames at 30 fps (150 s total), in storyboard order. */
export const SCENES: ReadonlyArray<{ id: SceneId; frames: number }> = [
  { id: "hook", frames: 300 },
  { id: "problem", frames: 450 },
  { id: "book", frames: 600 },
  { id: "charter", frames: 450 },
  { id: "mandate", frames: 600 },
  { id: "waterfall", frames: 600 },
  { id: "proof", frames: 450 },
  { id: "live", frames: 600 },
  { id: "next", frames: 450 },
];

export const TOTAL_FRAMES = SCENES.reduce((sum, s) => sum + s.frames, 0);

/** First frame of a scene on the global timeline. */
export function sceneStart(id: SceneId): number {
  let at = 0;
  for (const s of SCENES) {
    if (s.id === id) return at;
    at += s.frames;
  }
  throw new Error(`unknown scene: ${id}`);
}
