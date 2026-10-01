// Quote construction: Avellaneda-Stoikov proposal -> clamp to the mandate -> side gating -> sizing
// -> final checkQuote(). The final check is the gate: if it fails, no quote is produced (the agent
// cancels instead), so a quote violating the mandate is never sent.

import { type Mandate, type QuoteCheck, allowedSides, checkQuote, inventoryUtil, usdToNumber } from "@bookrunner/shared";
import { type AsOutput, type AsParams, avellanedaStoikov } from "./avellaneda";
import { type SizeLimits, type SizingModel, type Sides, clampSizes } from "./sizing";

export interface QuotingConfig {
  as: AsParams;
  /** Added to minQuoteWidthBps so float/tick rounding can never land below the minimum. */
  widthSafetyBps: number;
  /** Subtracted from maxSkewBps for the same reason. */
  skewSafetyBps: number;
  /** Upper bound on quoted width (vol spikes); never below the mandate minimum. */
  maxWidthBps: number;
  /** Price tick (USD); bids round down, asks round up. 0 = no rounding. */
  tickSize: number;
  sizeLimits: SizeLimits;
}

export const DEFAULT_QUOTING_CONFIG: QuotingConfig = {
  as: { gamma: 50, k: 2000, horizonSec: 3600 },
  widthSafetyBps: 0.5,
  skewSafetyBps: 0.5,
  maxWidthBps: 300,
  tickSize: 0,
  sizeLimits: { minSizeUsd: 10 },
};

export interface QuoteInputs {
  mandate: Mandate;
  oraclePx: number;
  sigma: number;
  netExposureUsd: bigint;
  offHours: boolean;
  /** Forced reduce-only (risk breach / reduce_only state, book Retiring). */
  reduceOnly: boolean;
}

/** What the agent hands the venue: a TwoSidedQuote plus the theoretical two-sided envelope. */
export interface AgentQuote {
  bid?: { px: number; qty: number };
  ask?: { px: number; qty: number };
  reduceOnly?: boolean;
  oraclePx: number;
  /** Full two-sided quote the mandate check ran on (published sides are a subset). */
  theoretical: { bidPx: number; askPx: number };
  widthBps: number;
  skewBps: number;
}

export interface QuoteDecision {
  quote: AgentQuote | null;
  reason: string;
  sides: Sides;
  check: QuoteCheck | null;
  diagnostics: {
    q: number;
    util: number;
    sigma: number;
    asSpreadBps: number;
    asSkewBps: number;
    widthBps: number;
    skewBps: number;
  };
  as: AsOutput | null;
}

export interface ClampedQuote {
  bidPx: number;
  askPx: number;
  widthBps: number;
  skewBps: number;
}

/**
 * Clamp a reservation/spread proposal to the mandate:
 *   width in [minQuoteWidthBps + safety, max(maxWidthBps, min + safety)]
 *   |skew| <= maxSkewBps - safety (skew = (mid - oracle) / oracle)
 * The result is rebuilt around the clamped mid so width and skew are exact (before tick rounding).
 */
export function clampToMandate(
  proposal: { reservation: number; spread: number },
  oraclePx: number,
  m: Mandate,
  cfg: Pick<QuotingConfig, "widthSafetyBps" | "skewSafetyBps" | "maxWidthBps" | "tickSize">,
): ClampedQuote | null {
  if (!(oraclePx > 0) || !Number.isFinite(oraclePx)) return null;
  const { reservation, spread } = proposal;
  if (!Number.isFinite(reservation) || !Number.isFinite(spread) || !(reservation > 0) || spread < 0) return null;

  const rawWidthBps = (spread / reservation) * 10_000;
  const rawSkewBps = ((reservation - oraclePx) / oraclePx) * 10_000;

  const minW = m.minQuoteWidthBps + Math.max(0, cfg.widthSafetyBps);
  const maxW = Math.max(minW, cfg.maxWidthBps);
  const widthBps = Math.min(maxW, Math.max(minW, rawWidthBps));

  const maxSkew = Math.max(0, m.maxSkewBps - Math.max(0, cfg.skewSafetyBps));
  const skewBps = Math.min(maxSkew, Math.max(-maxSkew, rawSkewBps));

  const mid = oraclePx * (1 + skewBps / 10_000);
  const half = widthBps / 20_000;
  let bidPx = mid * (1 - half);
  let askPx = mid * (1 + half);
  if (cfg.tickSize > 0) {
    bidPx = Math.floor(bidPx / cfg.tickSize + 1e-9) * cfg.tickSize;
    askPx = Math.ceil(askPx / cfg.tickSize - 1e-9) * cfg.tickSize;
  }
  if (!(bidPx > 0) || !(askPx > bidPx)) return null;
  const m2 = (bidPx + askPx) / 2;
  return {
    bidPx,
    askPx,
    widthBps: ((askPx - bidPx) / m2) * 10_000,
    skewBps: ((m2 - oraclePx) / oraclePx) * 10_000,
  };
}

/** Sides per the mandate (allowedSides) intersected with a forced reduce-only mode. */
export function decideSides(m: Mandate, netExposureUsd: bigint, offHours: boolean, util: number, forceReduceOnly: boolean): Sides {
  const base = allowedSides(m, netExposureUsd, offHours, util);
  if (!forceReduceOnly) return base;
  const reducing: Sides =
    netExposureUsd > 0n ? { bid: false, ask: true } : netExposureUsd < 0n ? { bid: true, ask: false } : { bid: false, ask: false };
  return { bid: base.bid && reducing.bid, ask: base.ask && reducing.ask };
}

/** True when the agent is restricted to reducing exposure (used for venue reduce_only flags). */
export function isReduceOnly(m: Mandate, offHours: boolean, util: number, forceReduceOnly: boolean): boolean {
  return forceReduceOnly || (offHours && m.noNewRiskOffHours) || util >= 1;
}

export function buildQuote(inp: QuoteInputs, cfg: QuotingConfig, sizing: SizingModel): QuoteDecision {
  const m = inp.mandate;
  const maxInv = usdToNumber(m.maxInventoryUsd);
  const exposure = usdToNumber(inp.netExposureUsd);
  const util = inventoryUtil(m, inp.netExposureUsd);
  const qRaw = maxInv > 0 ? exposure / maxInv : 0;
  const q = Math.max(-2, Math.min(2, qRaw));
  const sides = decideSides(m, inp.netExposureUsd, inp.offHours, util, inp.reduceOnly);
  const diag = { q, util, sigma: inp.sigma, asSpreadBps: 0, asSkewBps: 0, widthBps: 0, skewBps: 0 };
  const none = (reason: string, as: AsOutput | null = null, check: QuoteCheck | null = null): QuoteDecision => ({
    quote: null,
    reason,
    sides,
    check,
    diagnostics: diag,
    as,
  });

  if (m.maxInventoryUsd <= 0n) return none("NO_INVENTORY_LIMIT");
  if (!(inp.oraclePx > 0) || !Number.isFinite(inp.oraclePx)) return none("NO_PRICE");
  if (!(inp.sigma >= 0) || !Number.isFinite(inp.sigma)) return none("BAD_VOL");
  if (!sides.bid && !sides.ask) return none("NO_SIDES");

  const as = avellanedaStoikov({ mid: inp.oraclePx, sigma: inp.sigma, q }, cfg.as);
  diag.asSpreadBps = as.spreadBps;
  diag.asSkewBps = as.reservationOffsetBps;

  const clamped = clampToMandate(as, inp.oraclePx, m, cfg);
  if (!clamped) return none("CLAMP_FAILED", as);
  diag.widthBps = clamped.widthBps;
  diag.skewBps = clamped.skewBps;

  const check = checkQuote(m, { bidPx: clamped.bidPx, askPx: clamped.askPx, oraclePx: inp.oraclePx });
  if (!check.ok) return none(`MANDATE_${check.violations.join("_")}`, as, check);

  const sized = clampSizes(
    sizing.propose({
      oraclePx: inp.oraclePx,
      netExposureUsd: exposure,
      maxInventoryUsd: maxInv,
      sides,
      sigma: inp.sigma,
      util,
      widthBps: clamped.widthBps,
      skewBps: clamped.skewBps,
    }),
    { oraclePx: inp.oraclePx, netExposureUsd: exposure, maxInventoryUsd: maxInv, sides, sigma: inp.sigma, util, widthBps: clamped.widthBps, skewBps: clamped.skewBps },
    cfg.sizeLimits,
  );
  if (sized.bidQty <= 0 && sized.askQty <= 0) return none("NO_SIZE", as, check);

  const quote: AgentQuote = {
    oraclePx: inp.oraclePx,
    theoretical: { bidPx: clamped.bidPx, askPx: clamped.askPx },
    widthBps: check.widthBps,
    skewBps: check.skewBps,
    reduceOnly: isReduceOnly(m, inp.offHours, util, inp.reduceOnly),
  };
  if (sized.bidQty > 0) quote.bid = { px: clamped.bidPx, qty: sized.bidQty };
  if (sized.askQty > 0) quote.ask = { px: clamped.askPx, qty: sized.askQty };
  return { quote, reason: "OK", sides, check, diagnostics: diag, as };
}

/** Re-validate an outgoing quote against a (possibly refreshed) mandate right before sending. */
export function finalCheck(m: Mandate, q: AgentQuote): QuoteCheck {
  return checkQuote(m, { bidPx: q.theoretical.bidPx, askPx: q.theoretical.askPx, oraclePx: q.oraclePx });
}

/** Material change test for venues that cancel/replace (Orderly): price or size or side changes. */
export function quoteChanged(prev: AgentQuote | null, next: AgentQuote, priceThresholdBps: number, sizeThresholdFrac: number): boolean {
  if (!prev) return true;
  const sideChanged = !!prev.bid !== !!next.bid || !!prev.ask !== !!next.ask || !!prev.reduceOnly !== !!next.reduceOnly;
  if (sideChanged) return true;
  const pxMoved = (a?: { px: number }, b?: { px: number }) =>
    !!a && !!b && Math.abs(b.px - a.px) / a.px * 10_000 >= priceThresholdBps;
  const qtyMoved = (a?: { qty: number }, b?: { qty: number }) =>
    !!a && !!b && Math.abs(b.qty - a.qty) / Math.max(a.qty, 1e-12) >= sizeThresholdFrac;
  return pxMoved(prev.bid, next.bid) || pxMoved(prev.ask, next.ask) || qtyMoved(prev.bid, next.bid) || qtyMoved(prev.ask, next.ask);
}
