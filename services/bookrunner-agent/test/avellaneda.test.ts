import { describe, expect, test } from "bun:test";
import { avellanedaStoikov, validateAsParams } from "../src/domain/avellaneda";
import { mulberry32, normal } from "../src/domain/rng";
import { EwmaVolatility, annualToPerSecond, ewmaStep, perSecondToAnnual } from "../src/domain/volatility";

const P = { gamma: 50, k: 2000, horizonSec: 3600 };

describe("Avellaneda-Stoikov", () => {
  test("flat inventory: reservation = mid, spread = gamma sigma^2 tau + (2/gamma) ln(1 + gamma/k)", () => {
    const sigma = 1e-4;
    const r = avellanedaStoikov({ mid: 100, sigma, q: 0 }, P);
    const risk = 50 * sigma * sigma * 3600; // 0.0018
    const liq = (2 / 50) * Math.log(1 + 50 / 2000); // 0.000987706
    expect(r.reservation).toBeCloseTo(100, 12);
    expect(r.riskTerm).toBeCloseTo(risk, 15);
    expect(r.liquidityTerm).toBeCloseTo(liq, 15);
    expect(r.spread).toBeCloseTo(100 * (risk + liq), 12);
    expect(r.ask - r.bid).toBeCloseTo(r.spread, 12);
    expect((r.ask + r.bid) / 2).toBeCloseTo(r.reservation, 12);
    expect(r.spreadBps).toBeCloseTo((risk + liq) * 1e4, 9);
  });

  test("reservation shifts against inventory: r = s - q gamma sigma^2 tau (scaled by s)", () => {
    const sigma = 2e-4;
    const long = avellanedaStoikov({ mid: 190, sigma, q: 0.5 }, P);
    const short = avellanedaStoikov({ mid: 190, sigma, q: -0.5 }, P);
    const shift = 190 * 0.5 * 50 * sigma * sigma * 3600;
    expect(long.reservation).toBeCloseTo(190 - shift, 10);
    expect(short.reservation).toBeCloseTo(190 + shift, 10);
    expect(long.reservationOffsetBps).toBeLessThan(0);
    expect(short.reservationOffsetBps).toBeGreaterThan(0);
    expect(long.reservationOffsetBps).toBeCloseTo(-short.reservationOffsetBps, 9);
  });

  test("spread does not depend on inventory; reservation is linear in q", () => {
    const a = avellanedaStoikov({ mid: 440, sigma: 1.5e-4, q: 0 }, P);
    const b = avellanedaStoikov({ mid: 440, sigma: 1.5e-4, q: 0.9 }, P);
    const c = avellanedaStoikov({ mid: 440, sigma: 1.5e-4, q: 0.45 }, P);
    expect(b.spread).toBeCloseTo(a.spread, 12);
    expect(c.reservation).toBeCloseTo((a.reservation + b.reservation) / 2, 10);
  });

  test("scale invariance: relative quote is independent of the price level", () => {
    const lo = avellanedaStoikov({ mid: 20, sigma: 1e-4, q: 0.3 }, P);
    const hi = avellanedaStoikov({ mid: 2000, sigma: 1e-4, q: 0.3 }, P);
    expect(lo.spreadBps).toBeCloseTo(hi.spreadBps, 9);
    expect(lo.reservationOffsetBps).toBeCloseTo(hi.reservationOffsetBps, 9);
  });

  test("small gamma: liquidity term tends to 2/k; higher vol widens", () => {
    const tiny = avellanedaStoikov({ mid: 100, sigma: 0, q: 0 }, { gamma: 1e-9, k: 2000, horizonSec: 3600 });
    expect(tiny.liquidityTerm).toBeCloseTo(2 / 2000, 9);
    const calm = avellanedaStoikov({ mid: 100, sigma: 5e-5, q: 0 }, P);
    const wild = avellanedaStoikov({ mid: 100, sigma: 5e-4, q: 0 }, P);
    expect(wild.spread).toBeGreaterThan(calm.spread);
  });

  test("invalid parameters are rejected", () => {
    expect(() => validateAsParams({ gamma: 0, k: 1, horizonSec: 1 })).toThrow();
    expect(() => validateAsParams({ gamma: 1, k: -1, horizonSec: 1 })).toThrow();
    expect(() => validateAsParams({ gamma: 1, k: 1, horizonSec: 0 })).toThrow();
    expect(() => avellanedaStoikov({ mid: 1, sigma: 1, q: 0 }, { gamma: Number.NaN, k: 1, horizonSec: 1 })).toThrow();
  });
});

describe("EWMA volatility", () => {
  const cfg = { halfLifeSec: 300, priorAnnualVol: 0.6, minAnnualVol: 0.01, maxAnnualVol: 10, maxGapSec: 600, minSamples: 10 };

  test("ewmaStep: alpha = 1 - 2^(-dt/halfLife); invalid samples leave the variance unchanged", () => {
    const v = ewmaStep(0, 0.01, 300, 300); // alpha = 0.5, sample = 1e-4/300
    expect(v).toBeCloseTo(0.5 * (1e-4 / 300), 15);
    expect(ewmaStep(1e-8, Number.NaN, 1, 300)).toBe(1e-8);
    expect(ewmaStep(1e-8, 0.01, 0, 300)).toBe(1e-8);
  });

  test("uses the prior until samples accumulate", () => {
    const v = new EwmaVolatility(cfg);
    expect(v.annualized()).toBeCloseTo(0.6, 9);
    v.update(100, 0);
    expect(v.samples).toBe(0);
    expect(v.annualized()).toBeCloseTo(0.6, 9);
  });

  test("recovers the volatility of a simulated GBM path", () => {
    const rng = mulberry32(7);
    const annual = 0.8;
    const sPerSec = annualToPerSecond(annual);
    const v = new EwmaVolatility({ ...cfg, halfLifeSec: 3_000 });
    let px = 190;
    let t = 0;
    for (let i = 0; i < 20_000; i++) {
      const dt = 1 + (i % 3); // irregular 1-3 s prints
      t += dt;
      px *= Math.exp(sPerSec * Math.sqrt(dt) * normal(rng) - 0.5 * sPerSec * sPerSec * dt);
      v.update(px, t);
    }
    expect(Math.abs(v.annualized() - annual) / annual).toBeLessThan(0.15);
  });

  test("held prints and long gaps produce no samples; constant prices decay to the floor", () => {
    const v = new EwmaVolatility(cfg);
    v.update(100, 0);
    v.update(101, 10, true); // held
    v.update(150, 2_000); // gap > maxGapSec -> reset only
    expect(v.samples).toBe(0);
    for (let i = 1; i <= 20_000; i++) v.update(150, 2_000 + i);
    expect(v.samples).toBe(20_000);
    expect(perSecondToAnnual(v.sigmaPerSqrtSec())).toBeCloseTo(cfg.minAnnualVol, 6);
  });

  test("clamps to the configured maximum", () => {
    const v = new EwmaVolatility({ ...cfg, maxAnnualVol: 2 });
    let px = 100;
    for (let i = 1; i <= 200; i++) {
      px = i % 2 ? px * 1.2 : px / 1.2;
      v.update(px, i);
    }
    expect(v.annualized()).toBeCloseTo(2, 9);
  });
});
