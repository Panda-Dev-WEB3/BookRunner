// Classification over scenario fixtures (evaluate() -> normative classifyLimits).
import { describe, expect, test } from "bun:test";
import { HEDGE_BAND_GRACE_SECONDS, usd, wad } from "@bookrunner/shared";
import { evaluate } from "../src/domain/evaluate";
import type { BookObservation, HedgeBandState } from "../src/types";
import { MANDATE, T0, chainObs, observation, quoteAt } from "./fakes";

const OPTS = { quoteMaxAgeMs: 15_000, bandMaxGapSec: 60 };
const IN_BAND: HedgeBandState = { outOfBandSince: null, lastObservedAt: null };

const run = (o: Partial<BookObservation> = {}, band: HedgeBandState = IN_BAND) => evaluate(observation(o), band, OPTS);
const exposure = (netExposureUsd: bigint, deskHedgeUsd = 0n) => ({ netExposureUsd, deskHedgeUsd });

describe("baseline", () => {
  test("healthy book is ok", () => {
    const ev = run();
    expect(ev.snapshot.state).toBe("ok");
    expect(ev.snapshot.breaches).toEqual([]);
    expect(ev.snapshot.inventoryUtil).toBeCloseTo(0.4, 6);
    expect(ev.snapshot.hedgeRatioBps).toBe(8000);
    expect(ev.snapshot.drawdownBps).toBe(0);
    expect(ev.snapshot.offHours).toBe(false);
  });

  test("killed mandate classifies as killed even with breaches", () => {
    const ev = run({ killed: true, ...exposure(usd(80_000)) });
    expect(ev.snapshot.state).toBe("killed");
    expect(ev.snapshot.breaches).toContain("INVENTORY");
  });
});

describe("inventory utilisation", () => {
  test("util > 100% is a breach (normative util resolution is 1e-6)", () => {
    const ev = run(exposure(usd(-50_000.05), usd(40_000)));
    expect(ev.snapshot.inventoryUtil).toBe(1.000001);
    expect(ev.snapshot.state).toBe("breach");
    expect(ev.snapshot.breaches).toEqual(["INVENTORY"]);
  });

  test("util exactly 100% is not a breach (strict >), but warns", () => {
    const ev = run(exposure(usd(-50_000), usd(40_000)));
    expect(ev.snapshot.inventoryUtil).toBe(1);
    expect(ev.snapshot.breaches).toEqual([]);
    expect(ev.snapshot.state).toBe("warn");
  });

  test("util >= 90% is a soft warn", () => {
    const ev = run(exposure(usd(-46_000), usd(40_000)));
    expect(ev.snapshot.state).toBe("warn");
  });

  test("long exposure util > 100% breaches regardless of hedge", () => {
    const ev = run(exposure(usd(75_000), 0n));
    expect(ev.snapshot.breaches).toContain("INVENTORY");
  });
});

describe("quote skew / width on a live quote", () => {
  const now = T0 * 1000;

  test("in-bounds quote is ok", () => {
    // mid 190.02 (+1.05 bps), width 0.2/190.02 = 10.5 bps
    const ev = run({ quote: quoteAt(now - 1000, 189.92, 190.12) });
    expect(ev.snapshot.state).toBe("ok");
    expect(ev.quote?.used).toBe(true);
    expect(ev.snapshot.skewUtil).toBeLessThan(1);
  });

  test("skew > maxSkewBps is a breach", () => {
    // mid 190.57 -> +30 bps vs 190
    const ev = run({ quote: quoteAt(now - 1000, 190.47, 190.67) });
    expect(ev.snapshot.breaches).toEqual(["SKEW"]);
    expect(ev.snapshot.state).toBe("breach");
    expect(ev.snapshot.skewUtil).toBeGreaterThan(1);
  });

  test("width < minQuoteWidthBps is a breach", () => {
    // width 0.1 / 190 = 5.3 bps < 8
    const ev = run({ quote: quoteAt(now - 1000, 189.95, 190.05) });
    expect(ev.snapshot.breaches).toEqual(["WIDTH"]);
  });

  test("skew and width together", () => {
    const ev = run({ quote: quoteAt(now - 1000, 190.6, 190.65) });
    expect(ev.snapshot.breaches).toEqual(["SKEW", "WIDTH"]);
  });

  test("a stale quote is not live and is not checked", () => {
    const ev = run({ quote: quoteAt(now - 20_000, 190.6, 190.65) });
    expect(ev.quote?.used).toBe(false);
    expect(ev.snapshot.breaches).toEqual([]);
  });

  test("a one-sided (reduce-only) quote has no mid and is not checked", () => {
    const q = { ...quoteAt(now - 1000, 190.6, 190.65), sides: { bid: false, ask: true } };
    const ev = run({ quote: q });
    expect(ev.quote?.used).toBe(false);
    expect(ev.snapshot.breaches).toEqual([]);
  });

  test("an agent reference far from the attested oracle cannot hide a skewed quote", () => {
    // agent claims oracle 190.6 (its quote looks centred), attested oracle is 190 -> +31.6 bps skew
    const ev = run({ quote: quoteAt(now - 1000, 190.5, 190.7, 190.6) });
    expect(ev.quote?.reference).toBe("oracle");
    expect(ev.snapshot.breaches).toEqual(["SKEW"]);
  });

  test("an agent reference within tolerance is used as the quote's reference", () => {
    // attested 190 vs agent 190.1 (5.3 bps apart); quote centred on 190.1
    const ev = run({ quote: quoteAt(now - 1000, 190.0, 190.2, 190.1) });
    expect(ev.quote?.reference).toBe("agent");
    expect(ev.snapshot.breaches).toEqual([]);
  });
});

describe("drawdown (live NAV vs perf index high-water)", () => {
  const withNav = (deployed: number, desk = 16_000, hw = wad(1), idx = wad(1)) => {
    const c = chainObs({
      adapter: { ...chainObs().adapter, deployedValueUsd: usd(deployed) },
      desk: { hedgeNotionalUsd: usd(desk), valueUsd: usd(desk) },
      perfIndexWad: idx,
      highWaterWad: hw,
    });
    return observation({}, c);
  };

  test("drawdown exactly at killAtDrawdownBps (-800) is a breach", () => {
    const ev = evaluate(withNav(76_000), IN_BAND, OPTS); // NAV 92k vs 100k accounted
    expect(ev.snapshot.drawdownBps).toBe(-800);
    expect(ev.snapshot.breaches).toEqual(["DRAWDOWN"]);
    expect(ev.snapshot.state).toBe("breach");
  });

  test("one micro-dollar above the threshold is not a breach (-799.99 truncates to -799)", () => {
    const ev = evaluate(withNav(76_000.000001), IN_BAND, OPTS);
    expect(ev.snapshot.drawdownBps).toBe(-799);
    expect(ev.snapshot.breaches).toEqual([]);
  });

  test("drawdown is measured from the high-water mark, not from the index", () => {
    // index 0.97 at the last mark, high-water 1.0; live NAV flat vs accounted -> still -300
    const ev = evaluate(withNav(84_000, 16_000, wad(1), wad(0.97)), IN_BAND, OPTS);
    expect(ev.snapshot.drawdownBps).toBe(-300);
    // a further 5.2% intra-mark loss: 0.97 * 0.948 = 0.91956 -> -804 bps
    const ev2 = evaluate(withNav(78_800, 16_000, wad(1), wad(0.97)), IN_BAND, OPTS);
    expect(ev2.snapshot.drawdownBps).toBe(-804);
    expect(ev2.snapshot.breaches).toContain("DRAWDOWN");
  });
});

describe("hedge band grace timing", () => {
  // short 20k with only 6k long spot: ratio 3000 < 5000 -> out of band
  const outOfBand = exposure(usd(-20_000), usd(6_000));

  test("out of band starts as warn and the clock starts", () => {
    const ev = run(outOfBand);
    expect(ev.inBand).toBe(false);
    expect(ev.snapshot.state).toBe("warn");
    expect(ev.band.outOfBandSince).toBe(T0);
  });

  test("still warn at exactly the grace period, breach one second after", () => {
    const since = T0 - HEDGE_BAND_GRACE_SECONDS;
    const atGrace = run(outOfBand, { outOfBandSince: since, lastObservedAt: T0 - 2 });
    expect(atGrace.outOfBandSec).toBe(900);
    expect(atGrace.snapshot.state).toBe("warn");
    const after = evaluate(
      observation({ ...outOfBand, nowMs: (T0 + 1) * 1000 }),
      { outOfBandSince: since, lastObservedAt: T0 },
      OPTS,
    );
    expect(after.outOfBandSec).toBe(901);
    expect(after.snapshot.breaches).toEqual(["HEDGE_BAND"]);
    expect(after.snapshot.state).toBe("breach");
  });

  test("below 5% of maxInventory the band is not enforced", () => {
    const ev = run(exposure(usd(-2_000), 0n), { outOfBandSince: T0 - 5_000, lastObservedAt: T0 - 2 });
    expect(ev.snapshot.hedgeRatioBps).toBeNull();
    expect(ev.inBand).toBe(true);
    expect(ev.band.outOfBandSince).toBeNull();
    expect(ev.snapshot.state).toBe("ok");
  });
});

describe("off-hours", () => {
  test("held feed -> reduce_only", () => {
    const ev = run({ oracle: { priceWad: wad(190), publishedAt: T0, held: true, stale: false, source: "chain" } });
    expect(ev.snapshot.offHours).toBe(true);
    expect(ev.snapshot.state).toBe("reduce_only");
  });

  test("stale feed -> reduce_only", () => {
    const ev = run({ oracle: { priceWad: wad(190), publishedAt: T0 - 600, held: false, stale: true, source: "chain" } });
    expect(ev.snapshot.state).toBe("reduce_only");
  });

  test("off-hours without noNewRiskOffHours is just flagged", () => {
    const ev = run({
      mandate: { ...MANDATE, noNewRiskOffHours: false },
      oracle: { priceWad: wad(190), publishedAt: T0, held: true, stale: false, source: "chain" },
    });
    expect(ev.snapshot.offHours).toBe(true);
    expect(ev.snapshot.state).toBe("ok");
  });

  test("a breach outranks reduce_only", () => {
    const ev = run({
      ...exposure(usd(60_000)),
      oracle: { priceWad: wad(190), publishedAt: T0, held: true, stale: false, source: "chain" },
    });
    expect(ev.snapshot.state).toBe("breach");
  });
});
