import { describe, expect, test } from "bun:test";
import { aggregate, deviationBps, median } from "../src/domain/aggregate";

const NOW = 1_800_000_000_000;
const opts = { nowMs: NOW, outlierBps: 150, minSources: 3, maxAgeMs: 15_000 };
const q = (name: string, price: number, ageMs = 0) => ({ name, price, ts: NOW - ageMs });

describe("median", () => {
  test("odd and even sizes, input not mutated", () => {
    const xs = [3, 1, 2];
    expect(median(xs)).toBe(2);
    expect(xs).toEqual([3, 1, 2]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(() => median([])).toThrow();
  });
});

describe("aggregate", () => {
  test("median of three agreeing sources", () => {
    const r = aggregate([q("c", 190.2), q("a", 190), q("b", 190.1)], opts);
    expect(r.ok).toBe(true);
    expect(r.price).toBe(190.1);
    expect(r.accepted.map((s) => s.name)).toEqual(["a", "b", "c"]); // canonical order
  });

  test("an outlier beyond 150 bps is rejected; then 2 < 3 sources -> not ok", () => {
    const r = aggregate([q("a", 100), q("b", 100.1), q("c", 102)], opts);
    expect(r.rejected.map((x) => [x.name, x.reason])).toEqual([["c", "outlier"]]);
    expect(r.accepted).toHaveLength(2);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("2 of 3");
  });

  test("with four sources the outlier is dropped and the rest still publish", () => {
    const r = aggregate([q("a", 100), q("b", 100.1), q("c", 99.95), q("d", 90)], opts);
    expect(r.ok).toBe(true);
    expect(r.price).toBe(100);
    expect(r.rejected.map((x) => x.name)).toEqual(["d"]);
  });

  test("threshold is strict: exactly 150 bps from the median is kept", () => {
    // median of [100, 100, 101.5] = 100; 101.5 is exactly 150 bps away
    const r = aggregate([q("a", 100), q("b", 100), q("c", 101.5)], opts);
    expect(deviationBps(101.5, 100)).toBeCloseTo(150, 9);
    expect(r.ok).toBe(true);
    const r2 = aggregate([q("a", 100), q("b", 100), q("c", 101.51)], opts);
    expect(r2.ok).toBe(false);
  });

  test("stale, invalid and duplicate observations are excluded", () => {
    const r = aggregate(
      [q("a", 100), q("b", 100.05), q("c", 100.02, 20_000), q("d", Number.NaN), q("e", -1), { name: "f", price: 100, ts: NOW + 60_000 }, q("a", 99.9, 1_000)],
      { ...opts, minSources: 2 },
    );
    const reasons = Object.fromEntries(r.rejected.map((x) => [`${x.name}@${x.price}`, x.reason]));
    expect(reasons["c@100.02"]).toBe("stale");
    expect(reasons["d@NaN"]).toBe("invalid");
    expect(reasons["e@-1"]).toBe("invalid");
    expect(reasons["f@100"]).toBe("invalid");
    expect(reasons["a@99.9"]).toBe("duplicate"); // older duplicate dropped, newest kept
    expect(r.accepted.map((s) => s.name)).toEqual(["a", "b"]);
    expect(r.ok).toBe(true);
  });

  test("per-quote maxAgeMs overrides the default window", () => {
    const r = aggregate([q("a", 100), q("b", 100), { ...q("slow", 100, 600_000), maxAgeMs: 3_600_000 }], opts);
    expect(r.ok).toBe(true);
    expect(r.accepted.map((s) => s.name)).toContain("slow");
  });

  test("no fresh sources", () => {
    const r = aggregate([], opts);
    expect(r).toMatchObject({ ok: false, price: null, reason: "no fresh sources" });
  });
});
