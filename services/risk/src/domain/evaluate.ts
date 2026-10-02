// One tick of pure risk evaluation: observation -> live NAV, hedge-band step, normative
// classification (packages/shared/src/mandate.ts classifyLimits).
import { HEDGE_BAND_GRACE_SECONDS, type LimitsSnapshot, classifyLimits, hedgeBandOk } from "@bookrunner/shared";
import type { BookObservation, HedgeBandState, LiveNavResult } from "../types";
import { stepHedgeBand } from "./hedgeBand";
import { computeLiveNav } from "./nav";
import { isOffHours, oraclePrice } from "./oracle";
import { type QuoteSelection, selectLiveQuote } from "./quote";

export interface EvaluateOptions {
  quoteMaxAgeMs: number;
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
}

export function evaluate(obs: BookObservation, prevBand: HedgeBandState, o: EvaluateOptions): Evaluation {
  const nowSec = Math.floor(obs.nowMs / 1000);
  const m = obs.mandate;
  const nav = computeLiveNav(obs.nav);
  const offHours = isOffHours(obs.oracle);
  const quote = selectLiveQuote(obs.quote, oraclePrice(obs.oracle), obs.nowMs, o.quoteMaxAgeMs, m.maxSkewBps);
  const canHedgeLong = o.canHedgeLong ?? false;
  const inBand = hedgeBandOk(m, obs.netExposureUsd, obs.deskHedgeUsd, canHedgeLong);
  const band = stepHedgeBand(prevBand, inBand, nowSec, o.bandMaxGapSec);
  const snapshot = classifyLimits({
    mandate: m,
    netExposureUsd: obs.netExposureUsd,
    deskHedgeUsd: obs.deskHedgeUsd,
    lastQuote: quote.proposal,
    drawdownBps: nav.drawdownBps,
    offHours,
    outOfBandSinceSec: band.outOfBandSec,
    killed: obs.killed,
    canHedgeLong,
  });
  return { snapshot, nav, band: band.state, inBand, outOfBandSec: band.outOfBandSec, offHours, quote: quote.info };
}

export { HEDGE_BAND_GRACE_SECONDS };
