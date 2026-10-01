import { describe, expect, test } from "bun:test";
import { inventoryUtil, usd } from "@bookrunner/shared";
import { resolveMode } from "../src/domain/mode";
import { DEFAULT_QUOTING_CONFIG, buildQuote, decideSides, isReduceOnly } from "../src/domain/quoting";
import { RuleBasedSizing } from "../src/domain/sizing";
import { annualToPerSecond } from "../src/domain/volatility";
import { nvdaMandate } from "./helpers";

const m = nvdaMandate(); // maxInventory 50k, noNewRiskOffHours
const both = { bid: true, ask: true };
const askOnly = { bid: false, ask: true };
const bidOnly = { bid: true, ask: false };
const none = { bid: false, ask: false };

describe("side gating", () => {
  const util = (e: bigint) => inventoryUtil(m, e);

  test("in session below 90% utilisation: both sides", () => {
    for (const e of [0n, usd(10_000), usd(-44_000)]) expect(decideSides(m, e, false, util(e), false)).toEqual(both);
  });

  test("off-hours with noNewRiskOffHours: reduce-only (long -> asks, short -> bids, flat -> nothing)", () => {
    expect(decideSides(m, usd(5_000), true, util(usd(5_000)), false)).toEqual(askOnly);
    expect(decideSides(m, usd(-5_000), true, util(usd(-5_000)), false)).toEqual(bidOnly);
    expect(decideSides(m, 0n, true, 0, false)).toEqual(none);
  });

  test("off-hours without the flag keeps both sides", () => {
    const loose = nvdaMandate({ noNewRiskOffHours: false });
    expect(decideSides(loose, usd(5_000), true, inventoryUtil(loose, usd(5_000)), false)).toEqual(both);
  });

  test("utilisation >= 0.9 quotes only the reducing side; >= 1 is reduce-only", () => {
    expect(decideSides(m, usd(45_000), false, util(usd(45_000)), false)).toEqual(askOnly);
    expect(decideSides(m, usd(-46_000), false, util(usd(-46_000)), false)).toEqual(bidOnly);
    expect(decideSides(m, usd(55_000), false, util(usd(55_000)), false)).toEqual(askOnly);
    expect(isReduceOnly(m, false, util(usd(55_000)), false)).toBe(true);
    expect(isReduceOnly(m, false, util(usd(45_000)), false)).toBe(false);
  });

  test("forced reduce-only (risk breach / Retiring) intersects with the mandate", () => {
    expect(decideSides(m, usd(1_000), false, util(usd(1_000)), true)).toEqual(askOnly);
    expect(decideSides(m, usd(-1_000), false, util(usd(-1_000)), true)).toEqual(bidOnly);
    expect(decideSides(m, 0n, false, 0, true)).toEqual(none);
  });

  test("buildQuote publishes only gated sides", () => {
    const sizing = new RuleBasedSizing();
    const sigma = annualToPerSecond(0.5);
    const long = buildQuote({ mandate: m, oraclePx: 190, sigma, netExposureUsd: usd(46_000), offHours: false, reduceOnly: false }, DEFAULT_QUOTING_CONFIG, sizing);
    expect(long.quote?.bid).toBeUndefined();
    expect(long.quote?.ask).toBeDefined();
    const offShort = buildQuote({ mandate: m, oraclePx: 190, sigma, netExposureUsd: usd(-3_000), offHours: true, reduceOnly: false }, DEFAULT_QUOTING_CONFIG, sizing);
    expect(offShort.quote?.ask).toBeUndefined();
    expect(offShort.quote?.bid).toBeDefined();
    expect(offShort.quote?.reduceOnly).toBe(true);
  });
});

describe("agent mode", () => {
  const live = { killMessage: null, mandateKilled: false, riskState: "ok" as const, bookState: "Live" as const };

  test("normal operation", () => {
    expect(resolveMode(live)).toEqual({ mode: "quote", hedgeMode: "normal", reason: "OK" });
    expect(resolveMode({ ...live, riskState: null }).mode).toBe("quote");
    expect(resolveMode({ ...live, riskState: "warn" }).mode).toBe("quote");
  });

  test("kill sources halt (message, mandate, risk) and take precedence", () => {
    expect(resolveMode({ ...live, killMessage: { reason: "DRAWDOWN" } })).toMatchObject({ mode: "halt", hedgeMode: "off" });
    expect(resolveMode({ ...live, mandateKilled: true }).mode).toBe("halt");
    expect(resolveMode({ ...live, riskState: "killed" }).mode).toBe("halt");
    expect(resolveMode({ ...live, bookState: "Retiring", mandateKilled: true }).mode).toBe("halt");
  });

  test("breach and reduce_only stop new risk; Retiring flattens hedges", () => {
    expect(resolveMode({ ...live, riskState: "breach" })).toMatchObject({ mode: "reduce_only", hedgeMode: "reduce_only" });
    expect(resolveMode({ ...live, riskState: "reduce_only" })).toMatchObject({ mode: "reduce_only", hedgeMode: "reduce_only" });
    expect(resolveMode({ ...live, bookState: "Retiring" })).toMatchObject({ mode: "reduce_only", hedgeMode: "flatten" });
  });

  test("book lifecycle: not live -> idle; Retired / Cancelled -> halt", () => {
    expect(resolveMode({ ...live, bookState: "Subscription" }).mode).toBe("idle");
    expect(resolveMode({ ...live, bookState: null }).mode).toBe("idle");
    expect(resolveMode({ ...live, bookState: "Retired" }).mode).toBe("halt");
    expect(resolveMode({ ...live, bookState: "Cancelled" }).mode).toBe("halt");
  });
});
