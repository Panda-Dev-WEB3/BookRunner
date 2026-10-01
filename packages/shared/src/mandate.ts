// NORMATIVE mandate semantics shared by bookrunner-agent (pre-trade), risk (monitoring) and
// contracts/src/MMMandate.sol (on-chain legs). See docs/ARCHITECTURE.md §Mandate.

import type { Mandate } from "./types";
import { BPS, absBig } from "./units";

/** Hedge-ratio band is only enforced once |exposure| >= this share of maxInventoryUsd. */
export const HEDGE_RATIO_MIN_EXPOSURE_BPS = 500n; // 5%
/** Out-of-band hedge ratio is a WARN until it persists this long, then a BREACH. */
export const HEDGE_BAND_GRACE_SECONDS = 900;
/** Inventory utilisation at which the agent must quote reduce-only on the growing side. */
export const SOFT_INVENTORY_UTIL = 0.9;

export type LimitState = "ok" | "warn" | "reduce_only" | "breach" | "killed";

export interface QuoteProposal {
  bidPx: number; // USD per unit (float is fine for quoting; accounting stays bigint)
  askPx: number;
  oraclePx: number;
}

export function quoteWidthBps(q: QuoteProposal): number {
  const mid = (q.bidPx + q.askPx) / 2;
  return mid > 0 ? ((q.askPx - q.bidPx) / mid) * 10_000 : 0;
}

/** Signed quote skew: (mid - oracle) / oracle in bps. */
export function quoteSkewBps(q: QuoteProposal): number {
  const mid = (q.bidPx + q.askPx) / 2;
  return q.oraclePx > 0 ? ((mid - q.oraclePx) / q.oraclePx) * 10_000 : 0;
}

export interface QuoteCheck {
  ok: boolean;
  violations: Array<"WIDTH" | "SKEW" | "CROSSED">;
  widthBps: number;
  skewBps: number;
}

export function checkQuote(m: Mandate, q: QuoteProposal): QuoteCheck {
  const widthBps = quoteWidthBps(q);
  const skewBps = quoteSkewBps(q);
  const violations: QuoteCheck["violations"] = [];
  if (q.askPx <= q.bidPx) violations.push("CROSSED");
  // 1e-9 tolerance for float rounding at the boundary
  if (widthBps + 1e-9 < m.minQuoteWidthBps) violations.push("WIDTH");
  if (Math.abs(skewBps) > m.maxSkewBps + 1e-9) violations.push("SKEW");
  return { ok: violations.length === 0, violations, widthBps, skewBps };
}

/** |net venue exposure| / maxInventoryUsd. */
export function inventoryUtil(m: Mandate, netExposureUsd: bigint): number {
  if (m.maxInventoryUsd === 0n) return netExposureUsd === 0n ? 0 : Number.POSITIVE_INFINITY;
  return Number((absBig(netExposureUsd) * 1_000_000n) / m.maxInventoryUsd) / 1_000_000;
}

/**
 * Hedge ratio (bps): the part of the desk hedge that OFFSETS venue exposure, over |exposure|.
 * Spot Stock Tokens are long-only (not borrowable), so a long-spot hedge offsets a SHORT venue
 * exposure. Returns null when |exposure| is below the enforcement threshold.
 */
export function hedgeRatioBps(m: Mandate, netExposureUsd: bigint, deskHedgeUsd: bigint): bigint | null {
  const absExp = absBig(netExposureUsd);
  if (absExp * BPS < m.maxInventoryUsd * HEDGE_RATIO_MIN_EXPOSURE_BPS) return null;
  const offset = netExposureUsd > 0n ? -deskHedgeUsd : deskHedgeUsd;
  const effective = offset > 0n ? offset : 0n;
  return (effective * BPS) / absExp;
}

export function hedgeInBand(m: Mandate, ratioBps: bigint | null): boolean {
  if (ratioBps === null) return true;
  return ratioBps >= BigInt(m.hedgeRatioMinBps) && ratioBps <= BigInt(m.hedgeRatioMaxBps);
}

/**
 * A hedge leg is acceptable if the post-trade ratio is inside the band, or strictly closer to the
 * band than pre-trade (rebalancing steps). Off-hours with noNewRiskOffHours: must reduce
 * |exposure + hedge| (net book exposure). Same rule enforced in MMMandate.checkHedge.
 */
export function checkHedgeLeg(
  m: Mandate,
  netExposureUsd: bigint,
  deskHedgeBeforeUsd: bigint,
  deskHedgeAfterUsd: bigint,
  offHours: boolean,
  leverage: number,
): { ok: boolean; reason?: "OFF_HOURS_NEW_RISK" | "RATIO_OUT_OF_BAND" | "LEVERAGE" } {
  if (leverage > m.maxHedgeLeverage) return { ok: false, reason: "LEVERAGE" };
  if (offHours && m.noNewRiskOffHours) {
    const before = absBig(netExposureUsd + deskHedgeBeforeUsd);
    const after = absBig(netExposureUsd + deskHedgeAfterUsd);
    if (after > before) return { ok: false, reason: "OFF_HOURS_NEW_RISK" };
  }
  const rAfter = hedgeRatioBps(m, netExposureUsd, deskHedgeAfterUsd);
  if (hedgeInBand(m, rAfter)) return { ok: true };
  const rBefore = hedgeRatioBps(m, netExposureUsd, deskHedgeBeforeUsd);
  const dist = (r: bigint | null) => {
    if (r === null) return 0n;
    const lo = BigInt(m.hedgeRatioMinBps);
    const hi = BigInt(m.hedgeRatioMaxBps);
    return r < lo ? lo - r : r > hi ? r - hi : 0n;
  };
  return dist(rAfter) < dist(rBefore) ? { ok: true } : { ok: false, reason: "RATIO_OUT_OF_BAND" };
}

/** Off-hours reduce-only quoting: which sides may be quoted. */
export function allowedSides(
  m: Mandate,
  netExposureUsd: bigint,
  offHours: boolean,
  util: number,
): { bid: boolean; ask: boolean } {
  const reduceOnly = (offHours && m.noNewRiskOffHours) || util >= 1;
  const soft = util >= SOFT_INVENTORY_UTIL;
  if (!reduceOnly && !soft) return { bid: true, ask: true };
  // long exposure -> only sell (ask); short -> only buy (bid); flat + reduce-only -> nothing
  if (netExposureUsd > 0n) return { bid: false, ask: true };
  if (netExposureUsd < 0n) return { bid: true, ask: false };
  return reduceOnly ? { bid: false, ask: false } : { bid: true, ask: true };
}

export interface LimitsSnapshot {
  inventoryUtil: number;
  skewUtil: number; // |last quote skew| / maxSkewBps
  hedgeRatioBps: number | null;
  drawdownBps: number;
  offHours: boolean;
  state: LimitState;
  breaches: string[];
}

/**
 * Risk-service classification. BREACH (=> cancel-all, flatten, revoke keys) when:
 *  inventory util > 100%, quote skew > max or width < min on a live quote, drawdown <= kill,
 *  or the hedge ratio has been out of band longer than HEDGE_BAND_GRACE_SECONDS.
 */
export function classifyLimits(args: {
  mandate: Mandate;
  netExposureUsd: bigint;
  deskHedgeUsd: bigint;
  lastQuote?: QuoteProposal;
  drawdownBps: number;
  offHours: boolean;
  outOfBandSinceSec?: number | null; // seconds the ratio has been out of band
  killed: boolean;
}): LimitsSnapshot {
  const m = args.mandate;
  const util = inventoryUtil(m, args.netExposureUsd);
  const q = args.lastQuote ? checkQuote(m, args.lastQuote) : undefined;
  const skewUtil = q && m.maxSkewBps > 0 ? Math.abs(q.skewBps) / m.maxSkewBps : 0;
  const ratio = hedgeRatioBps(m, args.netExposureUsd, args.deskHedgeUsd);
  const breaches: string[] = [];
  if (util > 1) breaches.push("INVENTORY");
  if (q && q.violations.includes("SKEW")) breaches.push("SKEW");
  if (q && q.violations.includes("WIDTH")) breaches.push("WIDTH");
  if (m.killAtDrawdownBps < 0 && args.drawdownBps <= m.killAtDrawdownBps) breaches.push("DRAWDOWN");
  const inBand = hedgeInBand(m, ratio);
  if (!inBand && (args.outOfBandSinceSec ?? 0) > HEDGE_BAND_GRACE_SECONDS) breaches.push("HEDGE_BAND");

  let state: LimitState = "ok";
  if (args.killed) state = "killed";
  else if (breaches.length) state = "breach";
  else if (args.offHours && m.noNewRiskOffHours) state = "reduce_only";
  else if (!inBand || util >= SOFT_INVENTORY_UTIL) state = "warn";

  return {
    inventoryUtil: util,
    skewUtil,
    hedgeRatioBps: ratio === null ? null : Number(ratio),
    drawdownBps: args.drawdownBps,
    offHours: args.offHours,
    state,
    breaches,
  };
}
