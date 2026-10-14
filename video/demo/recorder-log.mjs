// Pure step-log helpers for the demo recorder (no Playwright, unit-tested in test/recorder-log.test.ts).
//
// Timing model: Playwright's recordVideo starts a page's video when the page is created, so the recorder takes its
// reference clock (`t0`, a performance.now() reading) immediately BEFORE context.newPage(). Every step's tMs is
// `now - t0`, i.e. milliseconds since (a hair before) the video's first frame; the lag between the reference and the
// true first frame is the page-creation latency, a few tens of ms, far below caption resolution. Callers that need
// to correct it can pass a measured `offsetMs` (subtracted from every tMs, clamped at 0).

const KEY_RE = /^[a-z0-9][a-z0-9_.-]*$/i;

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

/** The `<name>.steps.json` document: { name, startedAt (ISO, wall clock of t0), steps: [{ key, tMs }] }. */
export function buildStepsDoc({ name, startedAtMs, steps }) {
  assertScenarioName(name);
  if (!Number.isFinite(startedAtMs)) throw new Error("recorder: startedAtMs must be finite");
  validateSteps(steps);
  return { name, startedAt: new Date(startedAtMs).toISOString(), steps: steps.map(({ key, tMs }) => ({ key, tMs })) };
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
