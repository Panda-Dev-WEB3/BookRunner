// Which agent quote (KEYS.agentQuote) is "live" and checked for skew/width, and against which price. Pure.
//
// Rules:
//  - a quote older than maxAgeMs (or implausibly far in the future) is not live → no quote check;
//  - only two-sided quotes have a mid; a one-sided (reduce-only) or empty quote is not checked;
//  - audit M-3: the quote is judged against the ATTESTED oracle price only (the on-chain stored price or a
//    verified signed print, fresh), never against the price the agent says it quoted against
//    (QuoteMsg.oracle). A reported reference is self-serving: an agent shifting it by a few bps can make a
//    quote that sits entirely on one side of the oracle look centred. Ordinary drift between the agent's
//    print and the attested one is covered by a small allowance (`driftAllowanceBps`, see below), never by
//    trusting the reported reference;
//  - "fresh" for this check is its own tight bound (RISK_QUOTE_PRICE_MAX_AGE_MS, default 15 s), not the 300 s
//    maxPriceAge used for valuation: in pull mode the stored on-chain price is minutes old by design, and a few
//    bps of allowance against it would turn a signed-feed outage into a false SKEW kill. A held (market-closed)
//    print is accepted: it is signed and current, and off-hours the book is reduce-only anyway
//    (noNewRiskOffHours);
//  - no such price (missing, older than the bound, or only the unsigned Redis fallback) → no quote check, and the
//    book is held reduce-only (the off-hours convention) whatever the agent quotes, until a fresh attested
//    price has been seen on `releaseTicks` consecutive ticks (stepQuoteHold). Basing the hold on the price, not
//    on the quote, keeps it from flapping when an obedient agent drops to one side.
import { QUOTE_PRICE_MAX_AGE_MS, type QuoteProposal, quoteSkewBps, quoteWidthBps } from "@bookrunner/shared";
import type { OracleReading, QuoteObservation } from "../types";
import { oraclePrice } from "./oracle";

const FUTURE_TOLERANCE_MS = 5_000;
/** Default print-drift allowance (bps) between the agent's price and the attested one (RISK_QUOTE_DRIFT_BPS). */
export const DEFAULT_QUOTE_DRIFT_BPS = 5;
/** Upper bound of the configurable allowance (bps). */
export const MAX_QUOTE_DRIFT_BPS = 10;
/** Default max age (ms) of the attested price a quote is checked against (RISK_QUOTE_PRICE_MAX_AGE_MS). */
export const DEFAULT_QUOTE_PRICE_MAX_AGE_MS = QUOTE_PRICE_MAX_AGE_MS;
/** Bounds of RISK_QUOTE_PRICE_MAX_AGE_MS (validated at startup). */
export const MIN_QUOTE_PRICE_MAX_AGE_MS = 2_000;
export const MAX_QUOTE_PRICE_MAX_AGE_MS = 60_000;
/** Default consecutive ticks with a fresh attested price before the hold lifts (RISK_QUOTE_HOLD_RELEASE_TICKS). */
export const DEFAULT_QUOTE_HOLD_RELEASE_TICKS = 2;

export interface QuoteSelection {
  proposal: QuoteProposal | undefined;
  /** Allowance applied when checking `proposal` (bps): min(configured, minQuoteWidthBps / 2). */
  driftBps: number;
  info: {
    ts: number;
    ageMs: number;
    used: boolean;
    reference: "attested" | "none";
    /** |agent-reported reference - attested| in bps (diagnostics only; null when either is missing). */
    agentRefDevBps: number | null;
    widthBps: number;
    skewBps: number;
  } | null;
}

/**
 * Attested price fresh enough to check a quote against: the chain's stored price or a verified signed print (Redis
 * is unsigned), not stale, and published at most `maxAgeMs` ago. Held prints count (see the header).
 */
export function attestedPrice(o: OracleReading, nowMs: number, maxAgeMs: number): number | null {
  if (o.stale || (o.source !== "chain" && o.source !== "signed")) return null;
  if (o.publishedAt <= 0 || nowMs - o.publishedAt * 1000 > maxAgeMs) return null;
  return oraclePrice(o);
}

/** Fail-safe hold state: null = not held; n = consecutive ticks with a fresh attested price since the hold. */
export interface QuoteHoldState {
  freshTicks: number | null;
}

export const NO_QUOTE_HOLD: QuoteHoldState = { freshTicks: null };

/**
 * No fresh attested price: held (reduce-only), whatever the agent quotes. The hold lifts after `releaseTicks`
 * consecutive ticks with one (a single good print between outages does not reopen the book).
 */
export function stepQuoteHold(
  prev: QuoteHoldState,
  priceOk: boolean,
  releaseTicks: number,
): { state: QuoteHoldState; held: boolean } {
  if (!priceOk) return { state: { freshTicks: 0 }, held: true };
  if (prev.freshTicks === null) return { state: NO_QUOTE_HOLD, held: false };
  const n = prev.freshTicks + 1;
  if (n >= Math.max(1, releaseTicks)) return { state: NO_QUOTE_HOLD, held: false };
  return { state: { freshTicks: n }, held: true };
}

/**
 * The allowance is bounded by half the mandate's min quote width: it can never let through more than the width
 * budget the mandate already gives a quote around the oracle (at the 8 / 4 terms: min(5, 4) = 4 bps).
 */
export function effectiveDriftBps(configuredBps: number, minQuoteWidthBps: number): number {
  const c = Math.min(Math.max(0, configuredBps), MAX_QUOTE_DRIFT_BPS);
  return Math.min(c, Math.max(0, minQuoteWidthBps) / 2);
}

export function selectLiveQuote(
  q: QuoteObservation | null,
  attestedPx: number | null,
  nowMs: number,
  maxAgeMs: number,
  driftBps: number,
): QuoteSelection {
  if (!q) return { proposal: undefined, driftBps, info: null };
  const ageMs = nowMs - q.ts;
  const live = ageMs <= maxAgeMs && ageMs >= -FUTURE_TOLERANCE_MS;
  const twoSided = q.sides.bid && q.sides.ask && q.bid > 0 && q.ask > 0;
  const hasPx = attestedPx !== null && attestedPx > 0;
  const px = hasPx ? attestedPx : 0;
  const agentRefDevBps = hasPx && q.oracle > 0 ? (Math.abs(q.oracle - px) / px) * 10_000 : null;
  const proposal: QuoteProposal = { bidPx: q.bid, askPx: q.ask, oraclePx: px };
  const used = live && twoSided && hasPx;
  return {
    proposal: used ? proposal : undefined,
    driftBps,
    info: {
      ts: q.ts,
      ageMs,
      used,
      reference: hasPx ? "attested" : "none",
      agentRefDevBps,
      widthBps: twoSided ? quoteWidthBps(proposal) : 0,
      skewBps: twoSided && hasPx ? quoteSkewBps(proposal) : 0,
    },
  };
}
