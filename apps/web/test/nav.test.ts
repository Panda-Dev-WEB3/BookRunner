import { describe, expect, test } from "bun:test";
import { hasTrancheSplit, navSeries, paddedDomain, ringPush, sharePriceSeries, timeTicks } from "../src/lib/nav";

const mark = (markId: number, ts: string, nav: string, s: string | null = null, j: string | null = null) => ({
  ts,
  markId,
  navUsd: nav,
  seniorNavUsd: s,
  juniorNavUsd: j,
  seniorSharePrice: s ? "1.0" : null,
  juniorSharePrice: j ? "1.1" : null,
});

describe("navSeries", () => {
  test("sorts by time, de-duplicates by mark id, skips malformed points", () => {
    const s = navSeries(
      [mark(3, "2026-10-02T06:10:00Z", "120"), mark(1, "2026-10-02T06:00:00Z", "100"), mark(1, "2026-10-02T06:00:00Z", "100"), mark(2, "bad", "110"), mark(4, "2026-10-02T06:15:00Z", "x")],
      null,
    );
    expect(s.map((p) => p.markId)).toEqual([1, 3]);
    expect(s.every((p) => p.kind === "mark")).toBe(true);
  });

  test("appends the live estimate only when newer than the last mark, kept distinct", () => {
    const pts = [mark(1, "2026-10-02T06:00:00Z", "100", "70", "30")];
    const live = { navUsd: "101.5", seniorNavUsd: "70", juniorNavUsd: "31.5", ts: "2026-10-02T06:02:00Z" };
    const s = navSeries(pts, live);
    expect(s).toHaveLength(2);
    expect(s[1]).toMatchObject({ kind: "live", markId: null, nav: 101.5, seniorPrice: null });
    expect(navSeries(pts, { ...live, ts: "2026-10-02T05:59:00Z" })).toHaveLength(1);
    expect(navSeries(pts, { ...live, navUsd: null })).toHaveLength(1);
    const noTs = navSeries(pts, { ...live, ts: null }, Date.parse("2026-10-02T06:03:00Z"));
    expect(noTs[1]?.t).toBe(Date.parse("2026-10-02T06:03:00Z"));
  });

  test("tranche split and share-price series", () => {
    const split = navSeries([mark(1, "2026-10-02T06:00:00Z", "100", "70", "30"), mark(2, "2026-10-02T06:05:00Z", "101", "70", "31")], null);
    expect(hasTrancheSplit(split)).toBe(true);
    expect(hasTrancheSplit(navSeries([mark(1, "2026-10-02T06:00:00Z", "100")], null))).toBe(false);
    expect(hasTrancheSplit([])).toBe(false);
    expect(sharePriceSeries(split, "junior").map((p) => p.price)).toEqual([1.1, 1.1]);
  });
});

describe("chart helpers", () => {
  test("paddedDomain never collapses", () => {
    expect(paddedDomain([])).toEqual([0, 1]);
    const [lo, hi] = paddedDomain([5, 5]);
    expect(hi).toBeGreaterThan(lo);
    const [a, b] = paddedDomain([0, 10], 0.1, true);
    expect(a).toBe(0);
    expect(b).toBeCloseTo(11);
  });
  test("ringPush keeps the last N and skips duplicates", () => {
    let buf: number[] = [];
    for (let i = 0; i < 5; i++) buf = ringPush(buf, i, 3);
    expect(buf).toEqual([2, 3, 4]);
    expect(ringPush(buf, 4, 3, (x, y) => x === y)).toBe(buf);
  });
  test("timeTicks", () => {
    expect(timeTicks(0, 300, 4)).toEqual([0, 100, 200, 300]);
    expect(timeTicks(5, 5)).toEqual([5]);
  });
});
