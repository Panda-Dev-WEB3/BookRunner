// Classification over scenario fixtures (evaluate() -> normative classifyLimits).
import { describe, expect, test } from "bun:test";
import { HEDGE_BAND_GRACE_SECONDS, usd, wad } from "@bookrunner/shared";
import { evaluate } from "../src/domain/evaluate";
import { effectiveDriftBps } from "../src/domain/quote";
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

  test("audit M-3: a quote entirely on one side of the oracle is a skew breach, even within maxSkewBps", () => {
    // MANDATE is the pre-fix 25 / 8 (a cached mandate): mid 190.2 (+10.5 bps), width 10.5 bps, bid 5.3 bps ABOVE 190
    // (past the 4 bps drift allowance = min(5, 8 / 2))
    const ev = run({ quote: quoteAt(now - 1000, 190.1, 190.3) });
    expect(ev.snapshot.skewUtil).toBeLessThan(1);
    expect(ev.snapshot.breaches).toEqual(["SKEW"]);
    expect(ev.snapshot.state).toBe("breach");
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

  const m84 = { ...MANDATE, maxSkewBps: 4, minQuoteWidthBps: 8 };
  /** A quote `widthBps` wide, `skewBps` off `refPx`, as the agent builds it around its own print. */
  const quoteAround = (refPx: number, skewBps: number, widthBps: number, reportedRef = refPx) => {
    const mid = refPx * (1 + skewBps / 1e4);
    const half = (mid * widthBps) / 20_000;
    return quoteAt(now - 1000, mid - half, mid + half, reportedRef);
  };

  test("audit M-3: the quote is checked against the attested price, never the agent's reported reference", () => {
    // the agent reports a reference 20 bps above the attested 190 and centres its quote on it: against its own
    // reference the quote straddles, against the attested price it sits entirely above the oracle
    for (const shiftBps of [20, 15, -15, -24]) {
      const fake = 190 * (1 + shiftBps / 1e4);
      for (const mandate of [m84, MANDATE]) {
        const ev = run({ mandate, quote: quoteAround(fake, 0, 8.5) });
        expect(ev.quote?.reference).toBe("attested");
        expect(ev.quote?.agentRefDevBps).toBeCloseTo(Math.abs(shiftBps), 6);
        expect(ev.snapshot.breaches).toEqual(["SKEW"]);
        expect(ev.snapshot.state).toBe("breach");
      }
    }
  });

  test("audit M-3: at the 8 / 4 terms, 4-5 bps of agent / attested print drift does not flag a straddling quote", () => {
    for (const driftBps of [4, 5, -4, -5]) {
      for (const skewBps of [0, 2, -2]) {
        const agentPx = 190 * (1 + driftBps / 1e4);
        const ev = run({ mandate: m84, quote: quoteAround(agentPx, skewBps, 8.5) });
        expect(ev.quote?.used).toBe(true);
        expect(ev.quote?.reference).toBe("attested");
        expect(ev.snapshot.breaches).toEqual([]);
        expect(ev.snapshot.state).toBe("ok");
      }
    }
  });

  test("audit M-3: the drift allowance is capped at 10 bps and at half the min quote width", () => {
    expect(effectiveDriftBps(5, 8)).toBe(4);
    expect(effectiveDriftBps(10, 8)).toBe(4);
    expect(effectiveDriftBps(25, 100)).toBe(10);
    expect(effectiveDriftBps(5, 30)).toBe(5);
    expect(effectiveDriftBps(-1, 30)).toBe(0);
    // configured 10 at 8 / 4: a bid 4.5 bps above the attested price is still one-sided
    const q = quoteAround(190 * (1 + 8.75 / 1e4), 0, 8.5); // bid +4.5 bps, mid +8.75 bps
    const ev = evaluate(observation({ mandate: m84, quote: q }), IN_BAND, { ...OPTS, quoteDriftBps: 10 });
    expect(ev.snapshot.breaches).toEqual(["SKEW"]);
  });

  test("audit M-3: no fresh attested price -> the live quote is unverified and the book is held reduce-only", () => {
    const relaxed = { ...MANDATE, noNewRiskOffHours: false }; // isolate the hold from the off-hours rule
    const centred = quoteAround(190, 0, 10);
    const stale = { priceWad: wad(190), publishedAt: T0 - 3600, held: false, stale: true, source: "chain" as const };
    const redis = { priceWad: wad(190), publishedAt: T0, held: false, stale: false, source: "redis" as const };
    for (const oracle of [stale, redis, { ...stale, priceWad: 0n, source: "none" as const }]) {
      const ev = run({ mandate: relaxed, oracle, quote: centred });
      expect(ev.quote?.used).toBe(false);
      expect(ev.quote?.reference).toBe("none");
      expect(ev.quoteUnverified).toBe(true);
      expect(ev.snapshot.breaches).toEqual([]);
      expect(ev.snapshot.state).toBe("reduce_only");
      // without a live quote there is nothing to verify: no hold from this rule
      const idle = run({ mandate: relaxed, oracle });
      expect(idle.quoteUnverified).toBe(false);
      expect(idle.snapshot.state).toBe("ok");
    }
    // a fresh verified signed print checks the quote
    const signed = { priceWad: wad(190), publishedAt: T0, held: false, stale: false, source: "signed" as const };
    const ok = run({ mandate: relaxed, oracle: signed, quote: centred });
    expect(ok.quote?.used).toBe(true);
    expect(ok.quoteUnverified).toBe(false);
    expect(ok.snapshot.state).toBe("ok");
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

  test("the clock is paused while killed: a re-mandated book gets the full grace (regression: testnet NVDA)", () => {
    const longAgo = { outOfBandSince: T0 - 4_500, lastObservedAt: T0 - 2 }; // out of band 75 min before + during the kill
    const whileKilled = run({ ...outOfBand, killed: true }, longAgo);
    expect(whileKilled.outOfBandSec).toBe(0);
    expect(whileKilled.band.outOfBandSince).toBeNull();
    // first tick after the re-mandate: the clock starts now -> warn, not an instant HEDGE_BAND breach
    const first = evaluate(observation({ ...outOfBand, nowMs: (T0 + 2) * 1000 }), whileKilled.band, OPTS);
    expect(first.band.outOfBandSince).toBe(T0 + 2);
    expect(first.snapshot.state).toBe("warn");
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

describe("audit M-2 split window (review I-4): no kill from a desk valuation the window distorts", () => {
  // a reverse split at the audited valuation: the 16k hedge valued at 1/10 -> NAV 85.6k vs 100k accounted (-1440 bps)
  const distorted = () =>
    chainObs({ desk: { hedgeNotionalUsd: usd(1_600), valueUsd: usd(1_600) } });
  test("outside the window the distorted valuation would breach DRAWDOWN (and leave the band)", () => {
    const ev = evaluate(observation({}, distorted()), IN_BAND, OPTS);
    expect(ev.snapshot.breaches).toContain("DRAWDOWN");
    expect(ev.inBand).toBe(false);
  });
  test("in the window with a trusted (basis-multiplier) valuation: breaches still run", () => {
    const ev = evaluate(observation({ deskSplitWindow: true }, distorted()), IN_BAND, OPTS);
    expect(ev.snapshot.breaches).toContain("DRAWDOWN");
  });
  test("in the window with an untrusted valuation (no basis multiplier): DRAWDOWN and the HEDGE_BAND clock are suppressed", () => {
    const ev = evaluate(observation({ deskSplitWindow: true, deskSplitUntrusted: true }, distorted()), { outOfBandSince: T0 - 3_600, lastObservedAt: T0 - 10 }, OPTS);
    expect(ev.snapshot.breaches).toEqual([]);
    expect(ev.inBand).toBe(true);
    expect(ev.outOfBandSec).toBe(0);
  });
});
