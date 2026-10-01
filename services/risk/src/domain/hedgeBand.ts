// Hedge-ratio out-of-band duration tracker (state machine) for the HEDGE_BAND grace rule. Pure.
//
//   IN_BAND  --ratio leaves band-->  OUT(since = now)
//   OUT      --still out-->          OUT(since unchanged), duration = now - since
//   OUT      --back in band / below enforcement threshold-->  IN_BAND
//
// Continuity: a duration is only accumulated across consecutive observations. If the previous
// observation is older than `maxGapSec` (service down, RPC outage) the clock restarts at `now`,
// because the ratio may have been back in band during the unobserved gap.
import type { HedgeBandState } from "../types";

export interface HedgeBandStep {
  state: HedgeBandState;
  outOfBandSec: number;
}

export function stepHedgeBand(prev: HedgeBandState, inBand: boolean, nowSec: number, maxGapSec: number): HedgeBandStep {
  if (inBand) return { state: { outOfBandSince: null, lastObservedAt: nowSec }, outOfBandSec: 0 };
  const continuous = prev.lastObservedAt != null && nowSec - prev.lastObservedAt <= maxGapSec;
  const since =
    prev.outOfBandSince != null && continuous && prev.outOfBandSince <= nowSec ? prev.outOfBandSince : nowSec;
  return { state: { outOfBandSince: since, lastObservedAt: nowSec }, outOfBandSec: nowSec - since };
}
