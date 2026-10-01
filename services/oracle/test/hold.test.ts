import { describe, expect, test } from "bun:test";
import { SESSIONS_24X5, SESSIONS_24X7, SESSIONS_NYSE_RTH, encodeSessions } from "@bookrunner/shared";
import { aggregate } from "../src/domain/aggregate";
import { type LastOpen, decide, marketOpen } from "../src/domain/hold";
import { indexAsAggregate, indexLevel } from "../src/domain/index-level";

const RTH = encodeSessions(SESSIONS_NYSE_RTH);
const H24X5 = encodeSessions(SESSIONS_24X5);
const ALWAYS = encodeSessions(SESSIONS_24X7);

const aggAt = (nowMs: number, price: number, n = 3) =>
  aggregate(
    Array.from({ length: n }, (_, i) => ({ name: `s${i}`, price, ts: nowMs })),
    { nowMs, outlierBps: 150, minSources: 3, maxAgeMs: 15_000 },
  );

/** Simulates the publish loop across `times`, returning (iso, held, price) per step. */
function run(sessions: string[], mode: string | undefined, steps: Array<[string, number]>) {
  let lastOpen: LastOpen | null = null;
  return steps.map(([iso, observed]) => {
    const nowMs = Date.parse(iso);
    const open = marketOpen(sessions as `0x${string}`[], new Date(nowMs), mode);
    const d = decide({ open, agg: aggAt(nowMs, observed), lastOpen, nowMs });
    lastOpen = d.lastOpen;
    return d.kind === "publish" ? { iso, held: d.held, price: d.price } : { iso, skip: d.reason };
  });
}

describe("session hold (NYSE RTH fixture)", () => {
  test("holds at the last open-session price from the 16:00 ET close through the weekend, live again Monday 09:30 ET", () => {
    const out = run([RTH], "charter", [
      ["2026-10-02T19:58:00Z", 191], // Fri 15:58 ET open
      ["2026-10-02T19:59:59Z", 192], // Fri 15:59:59 ET open (last open-session price)
      ["2026-10-02T20:00:00Z", 193], // Fri 16:00 ET closed -> held at 192
      ["2026-10-03T15:00:00Z", 180], // Sat
      ["2026-10-05T13:29:59Z", 175], // Mon 09:29:59 ET still closed
      ["2026-10-05T13:30:00Z", 176], // Mon 09:30 ET open -> live
    ]);
    expect(out).toEqual([
      { iso: "2026-10-02T19:58:00Z", held: false, price: 191 },
      { iso: "2026-10-02T19:59:59Z", held: false, price: 192 },
      { iso: "2026-10-02T20:00:00Z", held: true, price: 192 },
      { iso: "2026-10-03T15:00:00Z", held: true, price: 192 },
      { iso: "2026-10-05T13:29:59Z", held: true, price: 192 },
      { iso: "2026-10-05T13:30:00Z", held: false, price: 176 },
    ]);
  });

  test("holiday (Thanksgiving 2026-11-26) holds all day", () => {
    const out = run([RTH], "charter", [
      ["2026-11-25T20:59:00Z", 200], // Wed 15:59 ET
      ["2026-11-26T15:00:00Z", 210], // Thu holiday 10:00 ET
    ]);
    expect(out[1]).toEqual({ iso: "2026-11-26T15:00:00Z", held: true, price: 200 });
  });

  test("SESSIONS_MODE=24x7 overrides charter sessions", () => {
    const out = run([RTH], "24x7", [
      ["2026-10-03T15:00:00Z", 180],
      ["2026-10-03T15:00:01Z", 181],
    ]);
    expect(out.every((o) => "held" in o && o.held === false)).toBe(true);
  });
});

describe("session hold (24/5 fixture)", () => {
  test("Fri 20:00 ET close and Sun 20:00 ET reopen", () => {
    const out = run([H24X5], "charter", [
      ["2026-10-02T23:59:00Z", 300], // Fri 19:59 ET open
      ["2026-10-03T00:00:00Z", 301], // Fri 20:00 ET closed
      ["2026-10-04T23:59:00Z", 290], // Sun 19:59 ET closed
      ["2026-10-05T00:00:00Z", 289], // Sun 20:00 ET open
    ]);
    expect(out.map((o) => ("held" in o ? [o.held, o.price] : o.skip))).toEqual([
      [false, 300],
      [true, 300],
      [true, 300],
      [false, 289],
    ]);
  });
});

describe("decide edge cases", () => {
  test("multiple governing sessions: closed if any is closed", () => {
    const sat = new Date("2026-10-03T15:00:00Z");
    expect(marketOpen([ALWAYS], sat, "charter")).toBe(true);
    expect(marketOpen([ALWAYS, RTH], sat, "charter")).toBe(false);
    expect(marketOpen([], sat, "charter")).toBe(true);
  });

  test("open session with too few sources skips (keeps the hold state)", () => {
    const nowMs = Date.parse("2026-10-01T15:00:00Z");
    const d = decide({ open: true, agg: aggAt(nowMs, 100, 2), lastOpen: null, nowMs });
    expect(d.kind).toBe("skip");
  });

  test("off-hours start without history seeds the hold from the observable median, then stays constant", () => {
    const t0 = Date.parse("2026-10-03T15:00:00Z");
    const d0 = decide({ open: false, agg: aggAt(t0, 150, 2), lastOpen: null, nowMs: t0 });
    expect(d0).toMatchObject({ kind: "publish", held: true, price: 150, seeded: true, sourceCount: 2 });
    const d1 = decide({ open: false, agg: aggAt(t0 + 1000, 170), lastOpen: d0.lastOpen, nowMs: t0 + 1000 });
    expect(d1).toMatchObject({ kind: "publish", held: true, price: 150 });
    const d2 = decide({ open: false, agg: aggAt(t0, 1, 0), lastOpen: null, nowMs: t0 });
    expect(d2.kind).toBe("skip");
  });

  test("index seeded off-hours holds the weighted level and the weakest component count", () => {
    const comps = [
      { priceId: "NVDA", weightBps: 8000 },
      { priceId: "TSLA", weightBps: 2000 },
    ];
    const prices = new Map([
      ["NVDA", { price: 190, sourceCount: 3, ts: 1 }],
      ["TSLA", { price: 440, sourceCount: 4, ts: 1 }],
    ]);
    const agg = indexAsAggregate(indexLevel(comps, prices), 3);
    const t = Date.parse("2026-10-03T15:00:00Z");
    const d = decide({ open: false, agg, lastOpen: null, nowMs: t });
    expect(d).toMatchObject({ kind: "publish", held: true, sourceCount: 3, seeded: true });
    if (d.kind === "publish") expect(d.price).toBeCloseTo(240, 10); // 0.8*190 + 0.2*440, not the median 315
    const live = decide({ open: true, agg, lastOpen: null, nowMs: t });
    expect(live).toMatchObject({ kind: "publish", held: false, sourceCount: 3 });
  });
});
