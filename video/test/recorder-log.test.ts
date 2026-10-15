import { deflateSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
// @ts-expect-error plain ESM module without types (video/demo runs in the Playwright container)
import * as L from "../demo/recorder-log.mjs";

function clock(start = 1000) {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

describe("step log", () => {
  test("tMs is relative to t0 and rounded", () => {
    const c = clock(1000);
    const log = L.createStepLog({ t0: 1000, now: c.now });
    c.set(1000.4);
    expect(log.step("open")).toBe(0);
    c.set(3250.6);
    expect(log.step("click-connect")).toBe(2251);
    expect(log.steps()).toEqual([{ key: "open", tMs: 0 }, { key: "click-connect", tMs: 2251 }]);
  });

  test("offsetMs is subtracted and clamped at 0", () => {
    const c = clock(500);
    const log = L.createStepLog({ t0: 500, now: c.now, offsetMs: 100 });
    c.set(550);
    expect(log.step("a")).toBe(0);
    c.set(900);
    expect(log.step("b")).toBe(300);
  });

  test("times never go backwards", () => {
    const c = clock(0);
    const log = L.createStepLog({ t0: 0, now: c.now });
    c.set(500);
    log.step("a");
    c.set(400);
    expect(log.step("b")).toBe(500);
  });

  test("rejects duplicate and malformed keys", () => {
    const log = L.createStepLog({ t0: 0, now: () => 1 });
    log.step("ok");
    expect(() => log.step("ok")).toThrow(/duplicate/);
    expect(() => log.step("")).toThrow(/bad step key/);
    expect(() => log.step("has space")).toThrow(/bad step key/);
    expect(() => log.step(5 as never)).toThrow(/bad step key/);
    expect(() => L.createStepLog({ t0: Number.NaN })).toThrow(/t0/);
  });

  test("steps() returns a copy", () => {
    const log = L.createStepLog({ t0: 0, now: () => 1 });
    log.step("a");
    log.steps()[0].tMs = 99;
    expect(log.steps()[0].tMs).toBe(1);
  });
});

describe("validateSteps / buildStepsDoc", () => {
  test("accepts a good log", () => {
    const steps = [{ key: "a", tMs: 0 }, { key: "b", tMs: 10 }, { key: "c", tMs: 10 }];
    expect(L.validateSteps(steps)).toBe(steps);
  });

  test("rejects bad logs", () => {
    expect(() => L.validateSteps("x")).toThrow();
    expect(() => L.validateSteps([{ key: "a", tMs: -1 }])).toThrow(/bad tMs/);
    expect(() => L.validateSteps([{ key: "a", tMs: 5 }, { key: "b", tMs: 4 }])).toThrow(/bad tMs/);
    expect(() => L.validateSteps([{ key: "a", tMs: Number.NaN }])).toThrow(/bad tMs/);
    expect(() => L.validateSteps([{ key: "a", tMs: 1 }, { key: "a", tMs: 2 }])).toThrow(/duplicate/);
  });

  test("builds { name, startedAt, steps }", () => {
    const doc = L.buildStepsDoc({ name: "mint-deposit", startedAtMs: Date.UTC(2026, 9, 15, 12, 0, 0), steps: [{ key: "a", tMs: 7, extra: 1 }] });
    expect(doc).toEqual({ name: "mint-deposit", startedAt: "2026-10-15T12:00:00.000Z", videoOffsetMs: 0, calibrated: false, steps: [{ key: "a", tMs: 7 }] });
  });

  test("records the video offset and calibration flag", () => {
    const doc = L.buildStepsDoc({ name: "x", startedAtMs: 0, steps: [{ key: "__sync", tMs: 900 }], videoOffsetMs: 120, calibrated: true });
    expect(doc.videoOffsetMs).toBe(120);
    expect(doc.calibrated).toBe(true);
    expect(() => L.buildStepsDoc({ name: "x", startedAtMs: 0, steps: [], videoOffsetMs: Number.NaN })).toThrow(/videoOffsetMs/);
  });

  test("reserved __sync key is accepted", () => {
    const log = L.createStepLog({ t0: 0, now: () => 1 });
    expect(log.step("__sync")).toBe(1);
  });

  test("scenario names are safe file stems", () => {
    expect(L.assertScenarioName("clip-2_x")).toBe("clip-2_x");
    for (const bad of ["", "../x", "a/b", "a b", ".hidden", "a.webm", 3]) expect(() => L.assertScenarioName(bad as never)).toThrow();
  });
});

describe("movePath", () => {
  test("ends exactly on target, monotone along the line, at least 25 points", () => {
    const pts = L.movePath({ x: 0, y: 0 }, { x: 10, y: 10 });
    expect(pts.length).toBe(25);
    expect(pts[pts.length - 1]).toEqual({ x: 10, y: 10 });
    for (let i = 1; i < pts.length; i++) expect(pts[i].x).toBeGreaterThanOrEqual(pts[i - 1].x);
  });

  test("long moves get more points, capped", () => {
    expect(L.movePath({ x: 0, y: 0 }, { x: 800, y: 0 }).length).toBe(58);
    expect(L.movePath({ x: 0, y: 0 }, { x: 5000, y: 0 }).length).toBe(90);
  });

  test("eases: first step is much smaller than the mean step", () => {
    const pts = L.movePath({ x: 0, y: 0 }, { x: 1000, y: 0 });
    expect(pts[0].x).toBeLessThan(1000 / pts.length / 3);
  });
});

describe("sync marker calibration", () => {
  const W = 16 * 9 * 3;
  /** frames: "w" white, "m" magenta */
  const buf = (pattern: string) => {
    const b = new Uint8Array(pattern.length * W);
    [...pattern].forEach((c, f) => {
      for (let i = 0; i < W; i += 3) b.set(c === "m" ? [255, 0, 255] : [255, 255, 255], f * W + i);
    });
    return b;
  };

  test("finds the start of the marker run at 100 Hz", () => {
    expect(L.findMarkerMs(buf("wwwwwmmmmmmww"), { frameBytes: W, fps: 100 })).toBe(50);
  });

  test("ignores runs shorter than minRun and returns null without a marker", () => {
    expect(L.findMarkerMs(buf("wwmwwmmww"), { frameBytes: W, fps: 100 })).toBeNull();
    expect(L.findMarkerMs(buf("wwwww"), { frameBytes: W, fps: 100 })).toBeNull();
    expect(L.findMarkerMs(new Uint8Array(0), { frameBytes: W, fps: 100 })).toBeNull();
  });

  test("a mixed frame whose mean is not magenta does not match", () => {
    const b = buf("mmm");
    for (let i = 0; i < W; i += 3) b.set([0, 255, 0], i); // first frame green
    expect(L.findMarkerMs(b, { frameBytes: W, fps: 100 })).toBeNull();
  });

  test("rejects bad geometry", () => {
    expect(() => L.findMarkerMs(buf("m"), { frameBytes: 10, fps: 100 })).toThrow(/geometry/);
    expect(() => L.findMarkerMs(buf("m"), { frameBytes: W, fps: 0 })).toThrow(/geometry/);
  });

  test("applyVideoOffset shifts, rounds and clamps at 0", () => {
    expect(L.applyVideoOffset([{ key: "a", tMs: 100 }, { key: "b", tMs: 250 }], 120.4)).toEqual([{ key: "a", tMs: 220 }, { key: "b", tMs: 370 }]);
    expect(L.applyVideoOffset([{ key: "a", tMs: 100 }], -300)).toEqual([{ key: "a", tMs: 0 }]);
    expect(() => L.applyVideoOffset([], Number.NaN)).toThrow();
  });
});

describe("readPng1x1", () => {
  const crc = (b: Uint8Array) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const png = (rgb: number[], { width = 1, colorType = 2 } = {}) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = colorType;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([0, ...rgb]))), chunk("IEND", new Uint8Array(0))]);
  };

  test("reads the pixel", () => {
    expect(L.readPng1x1(png([255, 0, 254]))).toEqual([255, 0, 254]);
  });

  test("rejects other geometry, colour types and non-PNG data", () => {
    expect(() => L.readPng1x1(png([1, 2, 3], { width: 2 }))).toThrow(/1x1/);
    expect(() => L.readPng1x1(png([1, 2, 3], { colorType: 6 }))).toThrow(/1x1/);
    expect(() => L.readPng1x1(Buffer.alloc(64))).toThrow(/not a PNG/);
  });
});
