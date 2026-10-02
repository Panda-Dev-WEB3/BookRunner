import { describe, expect, test } from "bun:test";
import { BREACH_TEXT, bookState, breachText, charterState, drawdownMeter, hedgeMeter, limitState, utilMeter } from "../src/lib/limits";
import { ladderModel, ladderPos, quoteFreshness } from "../src/lib/quote";

describe("limit meters", () => {
  test("utilisation tones: accent below soft, warn from 90%, critical above 100%", () => {
    expect(utilMeter(0.27).tone).toBe("accent");
    expect(utilMeter(0.9).tone).toBe("warn");
    expect(utilMeter(1.01).tone).toBe("critical");
    expect(utilMeter(3).fill).toBe(1); // track runs to 125%
    expect(utilMeter(null).fill).toBe(0);
    expect(utilMeter(0.5).marks.map((m) => m.label)).toEqual(["90%", "100%"]);
  });
  test("drawdown against the kill threshold", () => {
    const m = drawdownMeter(-400, -800);
    expect(m.util).toBe(0.5);
    expect(m.tone).toBe("accent");
    expect(drawdownMeter(-800, -800).tone).toBe("warn");
    expect(drawdownMeter(-900, -800).tone).toBe("critical");
    expect(drawdownMeter(-10, null).util).toBeNull();
    expect(drawdownMeter(25, -800).util).toBeCloseTo(0); // positive drawdown is 0
  });
  test("hedge band", () => {
    expect(hedgeMeter(8000, 5000, 12000)).toMatchObject({ inBand: true, tone: "good" });
    expect(hedgeMeter(0, 5000, 12000)).toMatchObject({ inBand: false, tone: "warn" });
    const below = hedgeMeter(null, 5000, 12000);
    expect(below.inBand).toBeNull();
    expect(below.band?.[0]).toBeLessThan(below.band?.[1] ?? 0);
  });
  test("state vocabulary falls back gracefully", () => {
    expect(limitState("killed").tone).toBe("critical");
    expect(limitState(undefined).label).toBe("No data");
    expect(limitState("weird").label).toBe("weird");
    expect(bookState("Live").tone).toBe("good");
    expect(charterState("Filed").label).toBe("Filed");
    expect(breachText("HEDGE_BAND")).toBe(BREACH_TEXT.HEDGE_BAND as string);
    expect(breachText("OTHER")).toBe("OTHER");
  });
});

describe("quote ladder", () => {
  const bounds = { minQuoteWidthBps: 8, maxSkewBps: 25 };
  test("legal quote: width and skew measured against the mandate", () => {
    const m = ladderModel({ bid: 189.9, ask: 190.1, oracle: 190, ts: 0 }, bounds);
    expect(m.widthBps).toBeCloseTo(10.526, 2);
    expect(m.skewBps).toBeCloseTo(0, 6);
    expect(m.widthOk).toBe(true);
    expect(m.skewOk).toBe(true);
    expect(m.crossed).toBe(false);
    expect(m.bandHigh).toBeCloseTo(190 * 1.0025);
    expect(m.widthHeadroom).toBeLessThan(1);
    expect(m.lo).toBeLessThan(m.bid);
    expect(m.hi).toBeGreaterThan(m.ask);
  });
  test("too narrow, too skewed, crossed", () => {
    expect(ladderModel({ bid: 189.99, ask: 190.01, oracle: 190, ts: 0 }, bounds).widthOk).toBe(false);
    const skewed = ladderModel({ bid: 190.6, ask: 190.8, oracle: 190, ts: 0 }, bounds);
    expect(skewed.skewOk).toBe(false);
    expect(skewed.skewUtil).toBeGreaterThan(1);
    expect(ladderModel({ bid: 190.2, ask: 190.1, oracle: 190, ts: 0 }, bounds).crossed).toBe(true);
  });
  test("ladder positions and freshness", () => {
    expect(ladderPos({ lo: 100, hi: 200 }, 200)).toBe(0);
    expect(ladderPos({ lo: 100, hi: 200 }, 150)).toBe(0.5);
    expect(ladderPos({ lo: 100, hi: 200 }, 50)).toBe(1);
    expect(ladderPos({ lo: 1, hi: 1 }, 1)).toBe(0.5);
    expect(quoteFreshness(0, 5_000)).toBe("fresh");
    expect(quoteFreshness(0, 30_000)).toBe("aging");
    expect(quoteFreshness(0, 120_000)).toBe("stale");
  });
});
