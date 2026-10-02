// Live quote ladder model: bid / ask / mid / oracle with width and skew measured against the
// mandate bounds, using the NORMATIVE shared quote checks.
import { checkQuote } from "@bookrunner/shared/mandate";
import type { Mandate } from "@bookrunner/shared/types";

export interface QuoteIn {
  bid: number;
  ask: number;
  mid?: number;
  oracle: number;
  size?: number;
  inventoryUsd?: number;
  sides?: { bid: boolean; ask: boolean };
  ts: number; // unix ms
}

export interface QuoteBounds {
  minQuoteWidthBps: number;
  maxSkewBps: number;
}

export interface LadderModel {
  bid: number;
  ask: number;
  mid: number;
  oracle: number;
  widthBps: number;
  skewBps: number;
  widthOk: boolean;
  skewOk: boolean;
  crossed: boolean;
  /** allowed mid range: oracle x (1 +/- maxSkew) */
  bandLow: number;
  bandHigh: number;
  /** narrowest legal ask - bid at the current mid */
  minWidthAbs: number;
  /** price axis */
  lo: number;
  hi: number;
  /** min width / actual width (<= 1 is legal) */
  widthHeadroom: number;
  /** |skew| / max skew (<= 1 is legal) */
  skewUtil: number;
  sides: { bid: boolean; ask: boolean };
}

function asMandate(b: QuoteBounds): Mandate {
  return {
    maxInventoryUsd: 1n,
    maxSkewBps: b.maxSkewBps,
    minQuoteWidthBps: b.minQuoteWidthBps,
    maxHedgeLeverage: 100,
    hedgeRatioMinBps: 0,
    hedgeRatioMaxBps: 0,
    noNewRiskOffHours: true,
    killAtDrawdownBps: -1,
    hedgeAllowRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
  };
}

export function ladderModel(q: QuoteIn, b: QuoteBounds): LadderModel {
  const check = checkQuote(asMandate(b), { bidPx: q.bid, askPx: q.ask, oraclePx: q.oracle });
  const mid = (q.bid + q.ask) / 2;
  const bandLow = q.oracle * (1 - b.maxSkewBps / 10_000);
  const bandHigh = q.oracle * (1 + b.maxSkewBps / 10_000);
  const minWidthAbs = (mid * b.minQuoteWidthBps) / 10_000;
  const reach = Math.max(Math.abs(q.ask - q.oracle), Math.abs(q.bid - q.oracle), bandHigh - q.oracle, minWidthAbs, q.oracle * 0.0005);
  const pad = reach * 1.35;
  return {
    bid: q.bid,
    ask: q.ask,
    mid,
    oracle: q.oracle,
    widthBps: check.widthBps,
    skewBps: check.skewBps,
    widthOk: !check.violations.includes("WIDTH"),
    skewOk: !check.violations.includes("SKEW"),
    crossed: check.violations.includes("CROSSED"),
    bandLow,
    bandHigh,
    minWidthAbs,
    lo: q.oracle - pad,
    hi: q.oracle + pad,
    widthHeadroom: check.widthBps > 0 ? b.minQuoteWidthBps / check.widthBps : Number.POSITIVE_INFINITY,
    skewUtil: b.maxSkewBps > 0 ? Math.abs(check.skewBps) / b.maxSkewBps : 0,
    sides: q.sides ?? { bid: true, ask: true },
  };
}

/** Price -> 0..1 position on the ladder axis (0 = top / highest price). */
export function ladderPos(m: Pick<LadderModel, "lo" | "hi">, px: number): number {
  if (!(m.hi > m.lo)) return 0.5;
  return Math.min(1, Math.max(0, (m.hi - px) / (m.hi - m.lo)));
}

/** Quote age classification for the live panel. */
export function quoteFreshness(tsMs: number, nowMs: number): "fresh" | "aging" | "stale" {
  const age = nowMs - tsMs;
  if (age < 15_000) return "fresh";
  if (age < 60_000) return "aging";
  return "stale";
}
