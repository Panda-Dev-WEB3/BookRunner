// One tick of pure risk evaluation: observation -> live NAV, hedge-band step, normative
// classification (packages/shared/src/mandate.ts classifyLimits).
import { HEDGE_BAND_GRACE_SECONDS, type LimitsSnapshot, classifyLimits, hedgeBandOk } from "@bookrunner/shared";
import type { BookObservation, HedgeBandState, LiveNavResult } from "../types";
import { stepHedgeBand } from "./hedgeBand";
import { computeLiveNav } from "./nav";
import { isOffHours } from "./oracle";
import {
  DEFAULT_QUOTE_DRIFT_BPS,
  DEFAULT_QUOTE_HOLD_RELEASE_TICKS,
  DEFAULT_QUOTE_PRICE_MAX_AGE_MS,
  NO_QUOTE_HOLD,
  type QuoteHoldState,
  type QuoteSelection,
  attestedPrice,
  effectiveDriftBps,
  selectLiveQuote,
  stepQuoteHold,
} from "./quote";

export interface EvaluateOptions {
  quoteMaxAgeMs: number;
  /**
   * Print drift allowed (bps) when the agent's quote is checked against the attested price (audit M-3; default
   * 5, at most 10, and never more than half the mandate's min quote width).
   */
  quoteDriftBps?: number;
  /** Max age (ms) of the attested price a quote is checked against (default 15 s; audit M-3). */
  quotePriceMaxAgeMs?: number;
  /** Consecutive ticks with a fresh attested price before the fail-safe hold lifts (default 2). */
  quoteHoldReleaseTicks?: number;
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
  /** No fresh attested price (or not yet for releaseTicks ticks): quotes unverifiable, book held reduce-only. */
  quoteUnverified: boolean;
  quoteHold: QuoteHoldState;
  /** Book.capitalShort() (pool audit 2026-10-23 fix round 2 Info 4): held reduce-only until the capital is restored. */
  capitalShort: boolean;
}

export function evaluate(
  obs: BookObservation,
  prevBand: HedgeBandState,
  o: EvaluateOptions,
  prevHold: QuoteHoldState = NO_QUOTE_HOLD,
): Evaluation {
  const nowSec = Math.floor(obs.nowMs / 1000);
  const m = obs.mandate;
  const nav = computeLiveNav(obs.nav);
  const offHours = isOffHours(obs.oracle);
  const driftBps = effectiveDriftBps(o.quoteDriftBps ?? DEFAULT_QUOTE_DRIFT_BPS, m.minQuoteWidthBps);
  const quotePx = attestedPrice(obs.oracle, obs.nowMs, o.quotePriceMaxAgeMs ?? DEFAULT_QUOTE_PRICE_MAX_AGE_MS);
  const hold = stepQuoteHold(prevHold, quotePx !== null, o.quoteHoldReleaseTicks ?? DEFAULT_QUOTE_HOLD_RELEASE_TICKS);
  // an authenticated quote carries the verified print it was priced on (refPx): it is judged against that print, so a
  // replayed genuine quote cannot fake a breach after a price move (audit 2026-10 lead "Redis trust")
  const quote = selectLiveQuote(obs.quote, obs.quote?.refPx ?? quotePx, obs.nowMs, o.quoteMaxAgeMs, driftBps);
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
  // fail safe (audit M-3): without a fresh attested price no quote can be verified; hold the book reduce-only (the
  // off-hours convention: the agent stops new risk) until one has been seen for releaseTicks consecutive ticks
  if (hold.held && (snapshot.state === "ok" || snapshot.state === "warn")) snapshot.state = "reduce_only";
  // pool audit 2026-10-23 fix round 2 (Info 4): redemptions took a pool-funded book's own capital below the pool's
  // minimum (exits are never blocked): no new risk until the capital is back above it
  const capitalShort = obs.capitalShort === true;
  if (capitalShort && (snapshot.state === "ok" || snapshot.state === "warn")) snapshot.state = "reduce_only";
  return {
    snapshot,
    nav,
    band: band.state,
    inBand,
    outOfBandSec: band.outOfBandSec,
    offHours,
    quote: quote.info,
    quoteUnverified: hold.held,
    quoteHold: hold.state,
    capitalShort,
  };
}

export { HEDGE_BAND_GRACE_SECONDS };
