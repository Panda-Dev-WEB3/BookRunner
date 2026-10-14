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
    expect(doc).toEqual({ name: "mint-deposit", startedAt: "2026-10-15T12:00:00.000Z", steps: [{ key: "a", tMs: 7 }] });
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
