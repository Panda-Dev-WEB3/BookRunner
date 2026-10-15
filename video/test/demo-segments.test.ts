import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEMO_COPY } from "../src/demo-copy";
import {
  DEMO_CLIPS,
  DEMO_TIMING,
  SPEED_UP,
  cueMidFrame,
  layoutSegments,
  planDemo,
  speedSpans,
  srcToVideoFrame,
  type StepLog,
} from "../src/demos/segments";

const T = DEMO_TIMING;
const log = (steps: Array<[string, number]>): StepLog => ({ name: "t", steps: steps.map(([key, tMs]) => ({ key, tMs })) });

describe("speedSpans", () => {
  test("gaps up to minGapMs play at 1x as one merged span", () => {
    expect(speedSpans([1000, 5000, 9000], 1000, 13000, SPEED_UP)).toEqual([{ srcStartMs: 1000, srcEndMs: 13000, rate: 1 }]);
  });
  test("a long gap keeps keepAfterMs after the step and keepBeforeMs before the next at 1x, the rest at the rate", () => {
    expect(speedSpans([0, 10000], 0, 14000, SPEED_UP)).toEqual([
      { srcStartMs: 0, srcEndMs: 2000, rate: 1 },
      { srcStartMs: 2000, srcEndMs: 8500, rate: 2 },
      { srcStartMs: 8500, srcEndMs: 14000, rate: 1 },
    ]);
  });
  test("no rule: one 1x span", () => {
    expect(speedSpans([0, 10000], 0, 14000, null)).toEqual([{ srcStartMs: 0, srcEndMs: 14000, rate: 1 }]);
  });
  test("steps outside the range are ignored; an empty range throws", () => {
    expect(speedSpans([-5, 0, 99999], 0, 3000, SPEED_UP)).toEqual([{ srcStartMs: 0, srcEndMs: 3000, rate: 1 }]);
    expect(() => speedSpans([], 10, 10, SPEED_UP)).toThrow();
  });
});

describe("layoutSegments / srcToVideoFrame", () => {
  const segs = layoutSegments(speedSpans([0, 10000], 0, 14000, SPEED_UP), 30);
  test("output durations: 1x spans keep their length, sped-up spans shrink by the rate", () => {
    expect(segs.map((s) => [s.from, s.frames, s.trimBefore])).toEqual([
      [0, 60, 0],
      [60, 98, 60], // 6.5 s at x2 = 3.25 s = 97.5 -> cumulative rounding
      [158, 165, 255],
    ]);
    const total = segs.reduce((a, s) => a + s.frames, 0);
    expect(total).toBe(Math.round(((2000 + 6500 / 2 + 5500) * 30) / 1000));
  });
  test("maps source times through the rates", () => {
    expect(srcToVideoFrame(segs, 0)).toBe(0);
    expect(srcToVideoFrame(segs, 2000)).toBe(60);
    expect(srcToVideoFrame(segs, 4000)).toBe(90); // 2 s of x2 = 1 s
    expect(srcToVideoFrame(segs, 10000)).toBe(Math.round((5250 + 1500) * 30 / 1000));
    expect(srcToVideoFrame(segs, 14000)).toBe(323);
    expect(() => srcToVideoFrame(segs, 14001)).toThrow();
  });
  test("segment boundaries line up (each starts where the previous ends)", () => {
    for (let i = 1; i < segs.length; i++) expect(segs[i].from).toBe(segs[i - 1].from + segs[i - 1].frames);
  });
});

describe("planDemo", () => {
  // 24 steps 6 s apart: 144 s of source, long enough that the speed-up applies.
  const keys = Array.from({ length: 24 }, (_, i) => `s${i}`);
  const steps: Array<[string, number]> = [["__sync", 40], ["loaded", 20000], ...keys.map((k, i): [string, number] => [k, 21000 + i * 6000])];
  const plan = planDemo(log(steps), keys);

  test("starts at the first caption step (skips __sync / loaded) and ends tailMs after the last", () => {
    expect(plan.startMs).toBe(21000);
    expect(plan.endMs).toBe(21000 + 23 * 6000 + T.tailMs);
    expect(plan.segments[0].srcStartMs).toBe(21000);
    expect(plan.segments[0].trimBefore).toBe(630);
  });
  test("cards and cross-fades frame the video", () => {
    expect(plan.speedUp).toEqual(SPEED_UP);
    expect(plan.videoFrom).toBe(T.titleFrames - T.xfadeFrames);
    expect(plan.endFrom).toBe(plan.videoFrom + plan.videoFrames - T.xfadeFrames);
    expect(plan.totalFrames).toBe(plan.endFrom + T.endFrames);
    // 23 gaps of 6 s: 2.5 s at x2 each.
    const videoMs = 23 * (3500 + 2500 / 2) + T.tailMs;
    expect(plan.videoFrames).toBe(Math.round(videoMs * 30 / 1000));
  });
  test("captions start at their step's output frame (the first after the title card) and run to the next", () => {
    const c = plan.captions;
    expect(c.map((x) => x.key)).toEqual(keys);
    expect(c[0].from).toBe(T.titleFrames);
    expect(c[1].from).toBe(plan.videoFrom + Math.round(4750 * 30 / 1000));
    for (let i = 1; i < c.length; i++) expect(c[i - 1].to).toBe(c[i].from);
    expect(c[c.length - 1].to).toBe(plan.endFrom);
    expect(cueMidFrame(c[1])).toBe(Math.floor((c[1].from + c[1].to) / 2));
  });
  test("captions closer than captionMinFrames are pushed back so each holds the minimum", () => {
    const p = planDemo(log([["a", 0], ["b", 500], ["c", 70000]]), ["a", "b", "c"]);
    expect(p.captions[1].from).toBe(p.captions[0].from + T.captionMinFrames);
    for (const c of p.captions) expect(c.to - c.from).toBeGreaterThanOrEqual(T.captionMinFrames);
  });
  test("a clip that the speed-up would make shorter than minSeconds plays at 1x instead", () => {
    // 6 steps 9 s apart: 49 s of source; x2 would drop below 60 s of output with the cards.
    const k = ["a", "b", "c", "d", "e", "f"];
    const p = planDemo(log(k.map((x, i): [string, number] => [x, i * 9000])), k);
    expect(p.speedUp).toBeNull();
    expect(p.segments).toHaveLength(1);
    expect(p.videoFrames).toBe(Math.round((45000 + T.tailMs) * 30 / 1000));
  });
  test("a lead-in caption starts captionLeadHoldMs after the previous step when its own step comes later", () => {
    const steps: Array<[string, number]> = [["a", 0], ["b", 10000], ["c", 20000], ["d", 50000], ["e", 80000]];
    const k = steps.map(([x]) => x);
    const plain = planDemo(log(steps), k);
    const led = planDemo(log(steps), k, ["c"]);
    const at = (p: typeof plain, ms: number) => p.videoFrom + srcToVideoFrame(p.segments, ms);
    expect(led.captions[2].from).toBe(at(led, 10000 + T.captionLeadHoldMs));
    expect(led.captions[1].to).toBe(led.captions[2].from);
    expect(plain.captions[2].from).toBe(at(plain, 20000));
    // other captions and the video are unchanged
    expect(led.captions.map((c) => c.from).filter((_, i) => i !== 2)).toEqual(plain.captions.map((c) => c.from).filter((_, i) => i !== 2));
    expect(led.totalFrames).toBe(plain.totalFrames);
  });
  test("a caption key missing from the log throws", () => {
    expect(() => planDemo(log([["a", 0]]), ["a", "b"])).toThrow(/no step for caption/);
  });
});

describe("DEMO_CLIPS zoom", () => {
  test("the public site plays full frame; the app clips zoom x1.25 from the top and keep the app column (x 390-1530) in view", () => {
    expect(DEMO_CLIPS.map((c) => c.zoom.scale)).toEqual([1, 1.25, 1.25, 1.25]);
    for (const c of DEMO_CLIPS) {
      const half = 960 / c.zoom.scale; // visible source half-width around the centre
      expect(960 - half).toBeLessThanOrEqual(390);
      expect(960 + half).toBeGreaterThanOrEqual(1530);
      expect(c.zoom.originY).toBe(0); // top anchored: the app's nav and wallet button stay in frame
    }
  });
});

// The real recordings (gitignored; present on the machine that recorded them): every clip lands in 60–120 s.
const demos = path.join(import.meta.dir, "..", "public", "demos");
describe.if(DEMO_CLIPS.every((c) => existsSync(path.join(demos, `${c.name}.steps.json`))))("recorded clips", () => {
  for (const c of DEMO_CLIPS) {
    test(`${c.comp} is 60–120 s`, () => {
      const l = JSON.parse(readFileSync(path.join(demos, `${c.name}.steps.json`), "utf8")) as StepLog;
      const p = planDemo(l, Object.keys(DEMO_COPY[c.id].steps), c.lead);
      expect(p.totalFrames / 30).toBeGreaterThanOrEqual(T.minSeconds);
      expect(p.totalFrames / 30).toBeLessThanOrEqual(T.maxSeconds);
    });
  }
});
