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
//  - no fresh attested price (missing, stale, or only the unsigned Redis fallback) while a live two-sided
//    quote exists → the quote is `unverified`: it is not passed as checked; evaluate() holds the book
//    reduce-only (the off-hours convention) until it can be verified.
import { type QuoteProposal, quoteSkewBps, quoteWidthBps } from "@bookrunner/shared";
import type { OracleReading, QuoteObservation } from "../types";
import { oraclePrice } from "./oracle";

const FUTURE_TOLERANCE_MS = 5_000;
/** Default print-drift allowance (bps) between the agent's price and the attested one (RISK_QUOTE_DRIFT_BPS). */
export const DEFAULT_QUOTE_DRIFT_BPS = 5;
/** Upper bound of the configurable allowance (bps). */
export const MAX_QUOTE_DRIFT_BPS = 10;

export interface QuoteSelection {
  proposal: QuoteProposal | undefined;
  /** Allowance applied when checking `proposal` (bps): min(configured, minQuoteWidthBps / 2). */
  driftBps: number;
  /** A live two-sided quote exists but no fresh attested price could check it (fail safe: hold). */
  unverified: boolean;
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

/** Fresh attested price: the chain's stored price or a verified signed print, not stale. Redis is unsigned. */
export function attestedPrice(o: OracleReading): number | null {
  if (o.stale || (o.source !== "chain" && o.source !== "signed")) return null;
  return oraclePrice(o);
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
  if (!q) return { proposal: undefined, driftBps, unverified: false, info: null };
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
    unverified: live && twoSided && !hasPx,
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
