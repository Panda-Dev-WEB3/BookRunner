// One tick of pure risk evaluation: observation -> live NAV, hedge-band step, normative
// classification (packages/shared/src/mandate.ts classifyLimits).
import { HEDGE_BAND_GRACE_SECONDS, type LimitsSnapshot, classifyLimits, hedgeBandOk } from "@bookrunner/shared";
import type { BookObservation, HedgeBandState, LiveNavResult } from "../types";
import { stepHedgeBand } from "./hedgeBand";
import { computeLiveNav } from "./nav";
import { isOffHours } from "./oracle";
import { DEFAULT_QUOTE_DRIFT_BPS, type QuoteSelection, attestedPrice, effectiveDriftBps, selectLiveQuote } from "./quote";

export interface EvaluateOptions {
  quoteMaxAgeMs: number;
  /**
   * Print drift allowed (bps) when the agent's quote is checked against the attested price (audit M-3; default
   * 5, at most 10, and never more than half the mandate's min quote width).
   */
  quoteDriftBps?: number;
  /** Max gap between observations for the out-of-band clock to keep running. */
  bandMaxGapSec: number;
  /** An offsetting perp hedge venue is enabled (spot-only books: false — long exposure is unhedgeable). */
  canHedgeLong?: boolean;
}

export interface Evaluation {
  snapshot: LimitsSnapshot;
  nav: LiveNavResult;
  band: HedgeBandState;
  inBand: boolean;
  outOfBandSec: number;
  offHours: boolean;
  quote: QuoteSelection["info"];
  /** A live quote could not be checked against a fresh attested price: the book is held reduce-only. */
  quoteUnverified: boolean;
}

export function evaluate(obs: BookObservation, prevBand: HedgeBandState, o: EvaluateOptions): Evaluation {
  const nowSec = Math.floor(obs.nowMs / 1000);
  const m = obs.mandate;
  const nav = computeLiveNav(obs.nav);
  const offHours = isOffHours(obs.oracle);
  const driftBps = effectiveDriftBps(o.quoteDriftBps ?? DEFAULT_QUOTE_DRIFT_BPS, m.minQuoteWidthBps);
  const quote = selectLiveQuote(obs.quote, attestedPrice(obs.oracle), obs.nowMs, o.quoteMaxAgeMs, driftBps);
  const canHedgeLong = o.canHedgeLong ?? false;
  // audit M-2 split window: a held token in it is valued at the multiplier of its price's basis (on-chain
  // basisMultiplier) and never flattened. Only when that multiplier is unknown (valued at 0) is the desk valuation
  // untrusted: then the desk-dependent breaches (HEDGE_BAND clock, DRAWDOWN) do not run until the oracle reprices.
  const deskUntrusted = obs.deskSplitUntrusted === true;
  const inBand = deskUntrusted || hedgeBandOk(m, obs.netExposureUsd, obs.deskHedgeUsd, canHedgeLong);
  // the grace clock does not run while the mandate is killed: the desk keys are revoked, so nobody can
  // hedge, and a re-mandated book must get the full grace to hedge back into band (instead of being
  // re-killed on its first tick with the clock still counting from before the kill)
  const band = obs.killed
    ? { state: { outOfBandSince: null, lastObservedAt: nowSec }, outOfBandSec: 0 }
    : stepHedgeBand(prevBand, inBand, nowSec, o.bandMaxGapSec);
  const snapshot = classifyLimits({
    mandate: m,
    netExposureUsd: obs.netExposureUsd,
    deskHedgeUsd: obs.deskHedgeUsd,
    lastQuote: quote.proposal,
    drawdownBps: deskUntrusted ? 0 : nav.drawdownBps,
    offHours,
    outOfBandSinceSec: band.outOfBandSec,
    killed: obs.killed,
    canHedgeLong,
    quoteDriftBps: quote.driftBps,
  });
  // fail safe (audit M-3): a live quote nobody can verify is never passed as checked; hold the book reduce-only
  // (the off-hours convention: the agent stops new risk) until a fresh attested price is back
  if (quote.unverified && (snapshot.state === "ok" || snapshot.state === "warn")) snapshot.state = "reduce_only";
  return {
    snapshot,
    nav,
    band: band.state,
    inBand,
    outOfBandSec: band.outOfBandSec,
    offHours,
    quote: quote.info,
    quoteUnverified: quote.unverified,
  };
}

export { HEDGE_BAND_GRACE_SECONDS };
