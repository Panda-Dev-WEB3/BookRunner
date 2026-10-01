import { describe, expect, test } from "bun:test";
import { type Mandate, allowedSides, checkQuote, inventoryUtil, usd, usdToNumber } from "@bookrunner/shared";
import { DEFAULT_QUOTING_CONFIG, type QuotingConfig, buildQuote, clampToMandate, finalCheck, quoteChanged } from "../src/domain/quoting";
import { type Rng, logUniform, mulberry32, uniform } from "../src/domain/rng";
import { RuleBasedSizing, type SizingModel, clampSizes, headroomUsd } from "../src/domain/sizing";
import { annualToPerSecond } from "../src/domain/volatility";
import { nvdaMandate } from "./helpers";

const sizing = new RuleBasedSizing();

function randomMandate(rng: Rng): Mandate {
  return nvdaMandate({
    maxInventoryUsd: usd(Math.round(logUniform(rng, 1_000, 5_000_000))),
    maxSkewBps: Math.round(uniform(rng, 0, 300)),
    minQuoteWidthBps: Math.max(1, Math.round(logUniform(rng, 1, 400))),
    noNewRiskOffHours: rng.next() < 0.7,
  });
}

function randomConfig(rng: Rng): QuotingConfig {
  return {
    as: { gamma: logUniform(rng, 0.01, 5_000), k: logUniform(rng, 10, 1e6), horizonSec: logUniform(rng, 1, 86_400 * 7) },
    widthSafetyBps: uniform(rng, 0.1, 2),
    skewSafetyBps: uniform(rng, 0.1, 2),
    maxWidthBps: logUniform(rng, 1, 2_000),
    tickSize: rng.next() < 0.5 ? 0 : [0.0001, 0.001, 0.01][Math.floor(rng.next() * 3)] ?? 0,
    sizeLimits: { minSizeUsd: logUniform(rng, 0.01, 1_000) },
  };
}

/** A "model" that proposes arbitrary (even absurd) sizes, to test the hard limits. */
const wildSizing = (rng: Rng): SizingModel => ({
  name: "wild",
  propose: () => ({ bidQty: rng.next() < 0.1 ? Number.NaN : logUniform(rng, 1e-6, 1e9), askQty: rng.next() < 0.1 ? -5 : logUniform(rng, 1e-6, 1e9) }),
});

describe("clampToMandate", () => {
  test("width is raised to the minimum (+safety) and skew capped at the maximum (-safety)", () => {
    const m = nvdaMandate();
    const c = clampToMandate({ reservation: 190 * 0.99, spread: 0.0001 }, 190, m, DEFAULT_QUOTING_CONFIG);
    expect(c).not.toBeNull();
    expect(c!.widthBps).toBeCloseTo(8.5, 9);
    expect(c!.skewBps).toBeCloseTo(-24.5, 9);
    expect(checkQuote(m, { bidPx: c!.bidPx, askPx: c!.askPx, oraclePx: 190 }).ok).toBe(true);
  });

  test("passes through an in-mandate proposal unchanged", () => {
    const m = nvdaMandate();
    const r = 190 * (1 + 10 / 1e4);
    const spread = r * (20 / 1e4);
    const c = clampToMandate({ reservation: r, spread }, 190, m, DEFAULT_QUOTING_CONFIG)!;
    expect(c.widthBps).toBeCloseTo(20, 9);
    expect(c.skewBps).toBeCloseTo(10, 9);
  });

  test("rejects non-finite and non-positive inputs", () => {
    const m = nvdaMandate();
    expect(clampToMandate({ reservation: Number.NaN, spread: 1 }, 190, m, DEFAULT_QUOTING_CONFIG)).toBeNull();
    expect(clampToMandate({ reservation: 190, spread: 1 }, 0, m, DEFAULT_QUOTING_CONFIG)).toBeNull();
    expect(clampToMandate({ reservation: -1, spread: 1 }, 190, m, DEFAULT_QUOTING_CONFIG)).toBeNull();
  });

  test("property: clamped quotes never violate checkQuote (random proposals, seeded)", () => {
    const rng = mulberry32(1234);
    for (let i = 0; i < 20_000; i++) {
      const m = randomMandate(rng);
      const cfg = randomConfig(rng);
      const oracle = logUniform(rng, 0.5, 5_000);
      const reservation = oracle * Math.exp(uniform(rng, -0.5, 0.5));
      const spread = reservation * logUniform(rng, 1e-8, 2);
      const c = clampToMandate({ reservation, spread }, oracle, m, cfg);
      if (!c) continue;
      const chk = checkQuote(m, { bidPx: c.bidPx, askPx: c.askPx, oraclePx: oracle });
      // tick rounding may push skew past the safety margin for coarse ticks; buildQuote's gate drops those
      if (cfg.tickSize === 0) expect(chk.ok).toBe(true);
      expect(chk.violations.includes("WIDTH")).toBe(false);
      expect(chk.violations.includes("CROSSED")).toBe(false);
    }
  });
});

describe("buildQuote", () => {
  const sigma = annualToPerSecond(0.6);

  test("flat book in session quotes both sides inside the mandate", () => {
    const m = nvdaMandate();
    const d = buildQuote({ mandate: m, oraclePx: 190, sigma, netExposureUsd: 0n, offHours: false, reduceOnly: false }, DEFAULT_QUOTING_CONFIG, sizing);
    expect(d.reason).toBe("OK");
    expect(d.quote?.bid).toBeDefined();
    expect(d.quote?.ask).toBeDefined();
    expect(finalCheck(m, d.quote!).ok).toBe(true);
    expect(d.quote!.widthBps).toBeGreaterThanOrEqual(8);
    expect(Math.abs(d.quote!.skewBps)).toBeLessThan(1e-6);
  });

  test("long inventory skews quotes down and sizes asks larger than bids", () => {
    const m = nvdaMandate();
    const d = buildQuote({ mandate: m, oraclePx: 190, sigma, netExposureUsd: usd(20_000), offHours: false, reduceOnly: false }, DEFAULT_QUOTING_CONFIG, sizing);
    expect(d.quote).not.toBeNull();
    expect(d.quote!.skewBps).toBeLessThan(0);
    expect(d.quote!.ask!.qty).toBeGreaterThan(d.quote!.bid!.qty);
  });

  test("property: random inputs never yield a quote that violates the mandate or inventory headroom", () => {
    const rng = mulberry32(42);
    let quoted = 0;
    let gated = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) {
      const m = randomMandate(rng);
      const cfg = randomConfig(rng);
      const oracle = logUniform(rng, 0.5, 5_000);
      const maxInv = usdToNumber(m.maxInventoryUsd);
      const exposure = usd(Math.round(uniform(rng, -1.3, 1.3) * maxInv));
      const offHours = rng.next() < 0.2;
      const reduceOnly = rng.next() < 0.15;
      const s = annualToPerSecond(logUniform(rng, 0.01, 10));
      const model = rng.next() < 0.5 ? sizing : wildSizing(rng);
      const d = buildQuote({ mandate: m, oraclePx: oracle, sigma: s, netExposureUsd: exposure, offHours, reduceOnly }, cfg, model);
      const util = inventoryUtil(m, exposure);
      const base = allowedSides(m, exposure, offHours, util);
      if (!d.quote) continue;
      quoted++;
      const q = d.quote;
      if (!q.bid !== !q.ask) gated++; // one-sided: gating was exercised
      // 1) the two-sided envelope satisfies checkQuote
      expect(checkQuote(m, { bidPx: q.theoretical.bidPx, askPx: q.theoretical.askPx, oraclePx: oracle }).ok).toBe(true);
      // 2) published sides are a subset of the mandate's allowed sides (and of reduce-only)
      if (q.bid) expect(base.bid).toBe(true);
      if (q.ask) expect(base.ask).toBe(true);
      if (reduceOnly) {
        if (q.bid) expect(exposure < 0n).toBe(true);
        if (q.ask) expect(exposure > 0n).toBe(true);
      }
      // 3) published prices are the clamped envelope
      if (q.bid) expect(q.bid.px).toBe(q.theoretical.bidPx);
      if (q.ask) expect(q.ask.px).toBe(q.theoretical.askPx);
      // 4) a full fill on either side keeps |exposure| <= maxInventory
      const e = usdToNumber(exposure);
      if (q.bid) {
        expect(Number.isFinite(q.bid.qty) && q.bid.qty > 0).toBe(true);
        expect(e + q.bid.qty * oracle).toBeLessThanOrEqual(maxInv * (1 + 1e-9) + 1e-6);
      }
      if (q.ask) {
        expect(Number.isFinite(q.ask.qty) && q.ask.qty > 0).toBe(true);
        expect(e - q.ask.qty * oracle).toBeGreaterThanOrEqual(-maxInv * (1 + 1e-9) - 1e-6);
      }
    }
    expect(quoted).toBeGreaterThan(N * 0.3); // the property is not vacuous
    expect(gated).toBeGreaterThan(0);
  });

  test("no price / no sides / no size produce no quote", () => {
    const m = nvdaMandate();
    const base = { mandate: m, sigma, netExposureUsd: 0n, offHours: false, reduceOnly: false };
    expect(buildQuote({ ...base, oraclePx: 0 }, DEFAULT_QUOTING_CONFIG, sizing).reason).toBe("NO_PRICE");
    expect(buildQuote({ ...base, oraclePx: 190, offHours: true }, DEFAULT_QUOTING_CONFIG, sizing).reason).toBe("NO_SIDES");
    const zero: SizingModel = { name: "zero", propose: () => ({ bidQty: 0, askQty: 0 }) };
    expect(buildQuote({ ...base, oraclePx: 190 }, DEFAULT_QUOTING_CONFIG, zero).reason).toBe("NO_SIZE");
  });

  test("coarse ticks that break the skew margin are dropped by the final gate", () => {
    const m = nvdaMandate({ maxSkewBps: 1, minQuoteWidthBps: 1 });
    const cfg = { ...DEFAULT_QUOTING_CONFIG, tickSize: 1, maxWidthBps: 2 }; // 1 USD ticks on a 3 USD price
    const d = buildQuote({ mandate: m, oraclePx: 3.3, sigma, netExposureUsd: 0n, offHours: false, reduceOnly: false }, cfg, sizing);
    expect(d.quote).toBeNull();
    expect(d.reason.startsWith("MANDATE_") || d.reason === "CLAMP_FAILED").toBe(true);
  });
});

describe("sizing limits", () => {
  test("headroom per side under |exposure| <= cap", () => {
    expect(headroomUsd(10_000, 50_000)).toEqual({ buy: 40_000, sell: 60_000 });
    expect(headroomUsd(-55_000, 50_000)).toEqual({ buy: 105_000, sell: 0 });
  });

  test("clampSizes drops gated, non-finite and dust sizes and caps by headroom", () => {
    const input = { oraclePx: 100, netExposureUsd: 49_000, maxInventoryUsd: 50_000, sides: { bid: true, ask: false }, sigma: 1e-4, util: 0.98, widthBps: 10, skewBps: 0 };
    const out = clampSizes({ bidQty: 1_000, askQty: 1_000 }, input, { minSizeUsd: 10 });
    expect(out.askQty).toBe(0);
    expect(out.bidQty).toBeCloseTo(10, 9); // 1000 USD headroom / 100
    expect(clampSizes({ bidQty: Number.NaN, askQty: 1 }, { ...input, sides: { bid: true, ask: true } }, { minSizeUsd: 1_000 })).toEqual({ bidQty: 0, askQty: 0 });
    expect(clampSizes({ bidQty: 3.37, askQty: 0 }, { ...input, netExposureUsd: 0 }, { minSizeUsd: 1, lotSize: 0.5 }).bidQty).toBeCloseTo(3, 9);
  });
});

describe("quoteChanged (cancel/replace venues)", () => {
  const q = { oraclePx: 100, theoretical: { bidPx: 99.95, askPx: 100.05 }, widthBps: 10, skewBps: 0, bid: { px: 99.95, qty: 10 }, ask: { px: 100.05, qty: 10 } };
  test("detects side, price and size changes beyond thresholds", () => {
    expect(quoteChanged(null, q, 1, 0.2)).toBe(true);
    expect(quoteChanged(q, { ...q }, 1, 0.2)).toBe(false);
    expect(quoteChanged(q, { ...q, bid: undefined }, 1, 0.2)).toBe(true);
    expect(quoteChanged(q, { ...q, bid: { px: 99.955, qty: 10 } }, 1, 0.2)).toBe(false); // 0.5 bps
    expect(quoteChanged(q, { ...q, bid: { px: 99.97, qty: 10 } }, 1, 0.2)).toBe(true); // 2 bps
    expect(quoteChanged(q, { ...q, ask: { px: 100.05, qty: 13 } }, 1, 0.2)).toBe(true);
  });
});
