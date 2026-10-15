// Timing plan for a product demo clip (pure; unit-tested in test/demo-segments.test.ts and imported by the Remotion
// composition and by scripts/demo-stills.mjs under plain node, so no runtime imports).
//
// Source time is the webm timeline in ms (the recorder's step tMs are already calibrated to it). The clip plays the
// webm from its first caption step to `tailMs` after its last one; idle stretches between two steps longer than
// `minGapMs` play at `rate`, except `keepAfterMs` after a step (the viewer sees its result) and `keepBeforeMs` before
// the next one (the action that leads to it), which stay at 1x. Output frames: a title card, the video (cross-faded in),
// an end card (cross-faded in); captions are placed at their step's output frame.
import type { DemoId } from "../demo-copy";

export const DEMO_FPS = 30;

/**
 * The four clips: composition id, recording name (public/demos/<name>.webm + .steps.json) and copy id. `lead`: steps
 * the scenario logs only once their action is done (form fields typed), so their caption leads in: it appears when
 * the previous caption has held `captionLeadHoldMs` of source, i.e. as the action starts (see planDemo).
 */
export const DEMO_CLIPS = [
  { n: 1, id: "site", name: "1-site", comp: "Demo1Site", lead: [] },
  { n: 2, id: "allocator", name: "2-allocator", comp: "Demo2Allocator", lead: [] },
  { n: 3, id: "sponsor", name: "3-sponsor", comp: "Demo3Sponsor", lead: ["market", "capital", "mandate"] },
  { n: 4, id: "risk", name: "4-risk", comp: "Demo4Risk", lead: [] },
] as const satisfies ReadonlyArray<{ n: number; id: DemoId; name: string; comp: string; lead: readonly string[] }>;
export type DemoClip = (typeof DEMO_CLIPS)[number];

export interface StepMark {
  key: string;
  tMs: number;
}
export interface StepLog {
  name: string;
  steps: StepMark[];
}

export interface SpeedRule {
  /** Only gaps between consecutive steps longer than this are sped up. */
  minGapMs: number;
  rate: number;
  /** Real-time (1x) source kept after a step and before the next one. */
  keepAfterMs: number;
  keepBeforeMs: number;
}
export const SPEED_UP: SpeedRule = { minGapMs: 5000, rate: 2, keepAfterMs: 2000, keepBeforeMs: 1500 };

export interface DemoTiming {
  titleFrames: number;
  endFrames: number;
  xfadeFrames: number;
  tailMs: number;
  captionMinFrames: number;
  captionFadeFrames: number;
  /** Source time a caption holds after its step before a lead-in caption (DEMO_CLIPS `lead`) replaces it. */
  captionLeadHoldMs: number;
  minSeconds: number;
  maxSeconds: number;
}
export const DEMO_TIMING: DemoTiming = {
  titleFrames: 90,
  endFrames: 90,
  /** Title -> video and video -> end card cross-fades. */
  xfadeFrames: 15,
  /** Source played after the last step. */
  tailMs: 4000,
  captionMinFrames: 75,
  captionFadeFrames: 8,
  captionLeadHoldMs: 2500,
  /** Target clip length (s); below the minimum the plan drops the speed-up. */
  minSeconds: 60,
  maxSeconds: 120,
};

/** A stretch of source played at one rate. */
export interface Span {
  srcStartMs: number;
  srcEndMs: number;
  rate: number;
}

/** A span placed on the video's output timeline: `from`/`frames` are video-relative output frames. */
export interface Segment extends Span {
  outStartMs: number;
  from: number;
  frames: number;
  /** Source start in output-fps frames (OffthreadVideo `trimBefore`, which playbackRate does not scale). */
  trimBefore: number;
}

/** One caption on the composition timeline (absolute frames, `to` exclusive). */
export interface CaptionCue {
  key: string;
  index: number;
  from: number;
  to: number;
}

export interface DemoPlan {
  startMs: number;
  endMs: number;
  /** The speed-up actually applied (null: the whole clip plays at 1x). */
  speedUp: SpeedRule | null;
  segments: Segment[];
  videoFrom: number;
  videoFrames: number;
  endFrom: number;
  totalFrames: number;
  captions: CaptionCue[];
}

/** Splits [startMs, endMs] into 1x and sped-up spans around the step times; adjacent equal-rate spans are merged. */
export function speedSpans(stepTimes: number[], startMs: number, endMs: number, rule: SpeedRule | null): Span[] {
  if (!(endMs > startMs)) throw new Error(`demo plan: empty source range ${startMs}..${endMs}`);
  const inner = [...new Set(stepTimes)].filter((t) => t > startMs && t < endMs).sort((a, b) => a - b);
  const cuts = [startMs, ...inner, endMs];
  const spans: Span[] = [];
  const push = (srcStartMs: number, srcEndMs: number, rate: number) => {
    if (srcEndMs <= srcStartMs) return;
    const last = spans[spans.length - 1];
    if (last && last.rate === rate && last.srcEndMs === srcStartMs) last.srcEndMs = srcEndMs;
    else spans.push({ srcStartMs, srcEndMs, rate });
  };
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    const fastA = rule ? a + rule.keepAfterMs : b;
    const fastB = rule ? b - rule.keepBeforeMs : a;
    if (rule && rule.rate !== 1 && b - a > rule.minGapMs && fastB > fastA) {
      push(a, fastA, 1);
      push(fastA, fastB, rule.rate);
      push(fastB, b, 1);
    } else push(a, b, 1);
  }
  return spans;
}

/** Places spans back to back on the output timeline; frame counts come from rounded cumulative times (no drift). */
export function layoutSegments(spans: Span[], fps = DEMO_FPS): Segment[] {
  let outMs = 0;
  return spans.map((s) => {
    const outStartMs = outMs;
    outMs += (s.srcEndMs - s.srcStartMs) / s.rate;
    const from = Math.round((outStartMs * fps) / 1000);
    return { ...s, outStartMs, from, frames: Math.round((outMs * fps) / 1000) - from, trimBefore: Math.round((s.srcStartMs * fps) / 1000) };
  });
}

/** Video-relative output frame at which source time `tMs` is shown. */
export function srcToVideoFrame(segments: Segment[], tMs: number, fps = DEMO_FPS): number {
  if (!segments.length) throw new Error("demo plan: no segments");
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (tMs < first.srcStartMs || tMs > last.srcEndMs) throw new Error(`demo plan: ${tMs} ms is outside the played source range`);
  const s = segments.find((x) => tMs < x.srcEndMs) ?? last;
  return Math.round(((s.outStartMs + (tMs - s.srcStartMs) / s.rate) * fps) / 1000);
}

function layout(log: StepLog, captionKeys: string[], lead: readonly string[], rule: SpeedRule | null, timing: DemoTiming, fps: number): DemoPlan {
  const keys = new Set(captionKeys);
  const marks = log.steps.filter((s) => keys.has(s.key));
  const missing = captionKeys.filter((k) => !marks.some((m) => m.key === k));
  if (missing.length) throw new Error(`demo plan: ${log.name} has no step for caption(s) ${missing.join(", ")}`);
  const startMs = marks[0].tMs;
  const endMs = marks[marks.length - 1].tMs + timing.tailMs;
  const segments = layoutSegments(
    speedSpans(marks.map((m) => m.tMs), startMs, endMs, rule),
    fps,
  );
  const lastSeg = segments[segments.length - 1];
  const videoFrames = lastSeg.from + lastSeg.frames;
  const videoFrom = timing.titleFrames - timing.xfadeFrames;
  const endFrom = videoFrom + videoFrames - timing.xfadeFrames;
  const totalFrames = endFrom + timing.endFrames;
  const captions: CaptionCue[] = [];
  for (const [index, m] of marks.entries()) {
    const prev = captions[index - 1];
    const anchorMs = index > 0 && lead.includes(m.key) ? Math.min(m.tMs, marks[index - 1].tMs + timing.captionLeadHoldMs) : m.tMs;
    const from = Math.max(videoFrom + srcToVideoFrame(segments, anchorMs, fps), timing.titleFrames, prev ? prev.from + timing.captionMinFrames : 0);
    if (prev) prev.to = from;
    captions.push({ key: m.key, index, from, to: endFrom });
  }
  const short = captions.find((c) => c.to - c.from < timing.captionMinFrames);
  if (short) throw new Error(`demo plan: ${log.name} caption "${short.key}" is on screen for only ${short.to - short.from} frames`);
  return { startMs, endMs, speedUp: rule, segments, videoFrom, videoFrames, endFrom, totalFrames, captions };
}

/**
 * The plan for one clip: speed-up applied unless that would make the clip shorter than `timing.minSeconds`, in which
 * case the clip plays at 1x (never padded). `captionKeys` are the clip's caption steps; other log keys are ignored.
 * A caption starts at its step's output frame, or for a `lead` key `captionLeadHoldMs` after the previous step if
 * that is earlier; never before the title card has faded out, and at least `captionMinFrames` after the previous one.
 */
export function planDemo(
  log: StepLog,
  captionKeys: string[],
  lead: readonly string[] = [],
  timing: DemoTiming = DEMO_TIMING,
  fps = DEMO_FPS,
): DemoPlan {
  if (!captionKeys.length) throw new Error(`demo plan: ${log.name} has no captions`);
  const fast = layout(log, captionKeys, lead, SPEED_UP, timing, fps);
  return fast.totalFrames >= timing.minSeconds * fps ? fast : layout(log, captionKeys, lead, null, timing, fps);
}

/** Middle frame of a caption's window (the review still for that step). */
export const cueMidFrame = (c: CaptionCue): number => Math.floor((c.from + c.to) / 2);
