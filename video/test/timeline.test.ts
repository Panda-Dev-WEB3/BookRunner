import { expect, test } from "bun:test";
import { SCENE_IDS } from "../src/copy";
import { SCENES, TOTAL_FRAMES, sceneStart } from "../src/timeline";
test("150 s at 30 fps", () => expect(TOTAL_FRAMES).toBe(4500));
test("durations sum to the total", () => expect(SCENES.reduce((a, s) => a + s.frames, 0)).toBe(TOTAL_FRAMES));
test("scene order matches the storyboard", () => expect(SCENES.map((s) => s.id)).toEqual([...SCENE_IDS]));
test("starts", () => { expect(sceneStart("hook")).toBe(0); expect(sceneStart("problem")).toBe(300); expect(sceneStart("next")).toBe(4050); });
