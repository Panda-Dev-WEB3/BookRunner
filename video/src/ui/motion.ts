import { interpolate, spring } from "remotion";
import { FPS } from "../theme";

/** Opacity 0 -> 1 over `inFrames`, hold, then 1 -> 0 over the last `outFrames` of `duration`. */
export function fadeInOut(frame: number, duration: number, inFrames = 15, outFrames = 15): number {
  return interpolate(frame, [0, inFrames, duration - outFrames, duration], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

/** Soft spring entrance: fades in while rising 24px into place, starting at `delay` frames. */
export function rise(frame: number, delay = 0): { opacity: number; transform: string } {
  const p = spring({ frame: frame - delay, fps: FPS, config: { damping: 200 }, durationInFrames: 24 });
  return { opacity: p, transform: `translateY(${(1 - p) * 24}px)` };
}

/** Frame delay for the i-th item of a staggered group. */
export function stagger(i: number, step = 8): number {
  return i * step;
}

/** 0 -> 1 between frames `from` and `to`, clamped at both ends, optionally eased. */
export function ramp(frame: number, from: number, to: number, easing?: (t: number) => number): number {
  return interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    ...(easing ? { easing } : {}),
  });
}
