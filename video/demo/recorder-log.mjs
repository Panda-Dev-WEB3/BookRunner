// Pure step-log helpers for the demo recorder (no Playwright, unit-tested in test/recorder-log.test.ts).
//
// Timing model: Playwright's recordVideo starts a page's video when the page is created, so the recorder takes its
// reference clock (`t0`, a performance.now() reading) immediately BEFORE context.newPage(). Every step's tMs is
// `now - t0`, i.e. milliseconds since (a hair before) the video's first frame; the lag between the reference and the
// true first frame is the page-creation latency, a few tens of ms, far below caption resolution. Callers that need
// to correct it can pass a measured `offsetMs` (subtracted from every tMs, clamped at 0).
//
// Calibration (recorder.mjs): right after page creation the recorder paints a solid magenta overlay and logs the step
// `__sync` just before doing so. After the context closed, findMarkerMs() locates the first webm frame showing the
// overlay; videoOffsetMs = markerMs - rawSyncTMs, and applyVideoOffset() shifts every step by it, so tMs is the time
// at which the step's effect shows up in the webm (this includes the screencast's capture latency, which is the same
// for every visible event). The renderer needs no further correction.

import { inflateSync } from "node:zlib";

const KEY_RE = /^[a-z0-9_][a-z0-9_.-]*$/i; // leading "_" allowed for reserved keys such as __sync

/** Safe file-name stem for a scenario: letters, digits, dash, underscore. */
export function assertScenarioName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new Error(`recorder: bad scenario name ${JSON.stringify(name)}`);
  return name;
}

/**
 * A step log anchored at `t0` (ms, same clock as the `now` function). `step(key)` appends `{ key, tMs }` with tMs =
 * now() - t0 - offsetMs (integer ms, >= 0, never before the previous step). Keys must be unique identifiers.
 */
export function createStepLog({ t0, now = () => performance.now(), offsetMs = 0 }) {
  if (!Number.isFinite(t0)) throw new Error("recorder: t0 must be a finite number");
  const steps = [];
  return {
    step(key) {
      if (typeof key !== "string" || !KEY_RE.test(key)) throw new Error(`recorder: bad step key ${JSON.stringify(key)}`);
      if (steps.some((s) => s.key === key)) throw new Error(`recorder: duplicate step key "${key}"`);
      const prev = steps.length ? steps[steps.length - 1].tMs : 0;
      const tMs = Math.max(prev, Math.max(0, Math.round(now() - t0 - offsetMs)));
      steps.push({ key, tMs });
      return tMs;
    },
    steps: () => steps.map((s) => ({ ...s })),
  };
}

/** Validates a finished log: array of unique keys with finite, non-negative, non-decreasing tMs. Returns it. */
export function validateSteps(steps) {
  if (!Array.isArray(steps)) throw new Error("recorder: steps must be an array");
  const seen = new Set();
  let prev = 0;
  for (const s of steps) {
    if (!s || typeof s.key !== "string" || !KEY_RE.test(s.key)) throw new Error(`recorder: bad step key ${JSON.stringify(s?.key)}`);
    if (seen.has(s.key)) throw new Error(`recorder: duplicate step key "${s.key}"`);
    seen.add(s.key);
    if (!Number.isFinite(s.tMs) || s.tMs < 0 || s.tMs < prev) throw new Error(`recorder: step "${s.key}" has bad tMs ${s.tMs}`);
    prev = s.tMs;
  }
  return steps;
}

/**
 * The `<name>.steps.json` document: { name, startedAt (ISO, wall clock of t0), videoOffsetMs, calibrated, steps }.
 * `steps` are already shifted by videoOffsetMs (video time); `calibrated` is false when no sync marker was found
 * (offset then 0 and the times are the raw, uncalibrated ones).
 */
export function buildStepsDoc({ name, startedAtMs, steps, videoOffsetMs = 0, calibrated = false }) {
  assertScenarioName(name);
  if (!Number.isFinite(startedAtMs)) throw new Error("recorder: startedAtMs must be finite");
  if (!Number.isFinite(videoOffsetMs)) throw new Error("recorder: videoOffsetMs must be finite");
  validateSteps(steps);
  return {
    name,
    startedAt: new Date(startedAtMs).toISOString(),
    videoOffsetMs,
    calibrated: Boolean(calibrated),
    steps: steps.map(({ key, tMs }) => ({ key, tMs })),
  };
}

/** Shifts every step by `offsetMs` (rounded, clamped at 0). Returns a new array. */
export function applyVideoOffset(steps, offsetMs) {
  if (!Number.isFinite(offsetMs)) throw new Error("recorder: offsetMs must be finite");
  return steps.map((s) => ({ key: s.key, tMs: Math.max(0, Math.round(s.tMs + offsetMs)) }));
}

/**
 * Reads the single pixel of a 1x1, 8-bit RGB, non-interlaced PNG (what ffmpeg writes for `scale=1:1 -pix_fmt rgb24`).
 * For a one-pixel image every PNG filter type leaves the byte unchanged, so no unfiltering is needed.
 */
export function readPng1x1(png) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 33 || sig.some((v, i) => png[i] !== v)) throw new Error("recorder: not a PNG");
  const idat = [];
  let hdr = null;
  for (let o = 8; o + 8 <= png.length; ) {
    const len = (png[o] << 24) | (png[o + 1] << 16) | (png[o + 2] << 8) | png[o + 3];
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    const data = png.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") hdr = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  const u32 = (d, i) => ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
  if (!hdr || u32(hdr, 0) !== 1 || u32(hdr, 4) !== 1 || hdr[8] !== 8 || hdr[9] !== 2 || hdr[12] !== 0) throw new Error("recorder: PNG is not 1x1 8-bit RGB");
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < 4) throw new Error("recorder: truncated PNG pixel");
  return [raw[1], raw[2], raw[3]];
}

/** True when an rgb mean is the sync marker colour (magenta, #ff00ff). */
export function isMarkerColour(r, g, b) {
  return r > 200 && g < 60 && b > 200;
}

/**
 * Time (ms) of the first frame of the sync marker in raw rgb24 frames (`frameBytes` bytes each, sampled at `fps`),
 * or null. A frame counts when its mean colour is the marker's; `minRun` consecutive frames are required, so a
 * stray frame cannot match. Returns the start of the run: index * 1000 / fps.
 */
export function findMarkerMs(rgb, { frameBytes, fps, minRun = 3 }) {
  if (!(frameBytes >= 3 && frameBytes % 3 === 0) || !(fps > 0)) throw new Error("recorder: bad frame geometry");
  const frames = Math.floor(rgb.length / frameBytes);
  let run = 0;
  for (let f = 0; f < frames; f++) {
    let r = 0, g = 0, b = 0;
    const base = f * frameBytes;
    for (let i = 0; i < frameBytes; i += 3) {
      r += rgb[base + i];
      g += rgb[base + i + 1];
      b += rgb[base + i + 2];
    }
    const px = frameBytes / 3;
    run = isMarkerColour(r / px, g / px, b / px) ? run + 1 : 0;
    if (run >= minRun) return Math.round(((f - minRun + 1) * 1000) / fps);
  }
  return null;
}

/**
 * Eased cursor path: points from `from` to `to` with smootherstep easing, so the pointer accelerates and settles
 * like a hand. The count is derived from the distance: at least `min` (25) points, one per ~`pxPerStep` pixels, at
 * most `max`. The recorder plays them with a ~16 ms pause each (Playwright's own `steps` option sends them with no
 * pause, which a 25 fps video would show as a jump).
 */
export function movePath(from, to, { min = 25, max = 90, pxPerStep = 14 } = {}) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const n = Math.min(max, Math.max(min, Math.ceil(dist / pxPerStep)));
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const e = t * t * t * (t * (t * 6 - 15) + 10);
    pts.push({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
  }
  return pts;
}
