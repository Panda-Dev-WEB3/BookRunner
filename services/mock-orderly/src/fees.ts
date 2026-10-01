// Fee schedule + builder share (pure). Perp Anything (docs 2026-10, perp-anything/introduction):
// "Default 50% of Orderly base taker fees" settled daily; "Maker fees, liquidation fees, and funding
// are not part of this share." The simulator settles per configurable period (devnet: mark interval).
export type FeeKind = "taker" | "maker" | "liquidation" | "funding";

export interface FeeSchedule {
  takerFeeBps: number; // base taker fee (default 6 bps)
  makerFeeBps: number; // maker fee (negative = rebate)
  builderShareBps: number; // builder share of BASE taker fees (default 5000 = 50%)
  liquidationFeeBps: number; // of liquidated notional
  liquidationIfShareBps: number; // share of the liquidation fee credited to the symbol's insurance fund
}

export const DEFAULT_FEES: FeeSchedule = {
  takerFeeBps: 6,
  makerFeeBps: 0,
  builderShareBps: 5000,
  liquidationFeeBps: 100,
  liquidationIfShareBps: 5000,
};

/** µUSD (integer) */
export const toMicro = (usd: number): number => Math.round(usd * 1e6);
export const fromMicro = (micro: number): number => Math.round(micro) / 1e6;

/** Fee in µUSD for `notionalUsd` at `bps` (rounded half away from zero). */
export function feeMicro(notionalUsd: number, bps: number): number {
  return toMicro((notionalUsd * bps) / 1e4);
}

/** Builder share in µUSD of a fee. Only positive base TAKER fees qualify; floor so the builder is never overpaid. */
export function builderShareMicro(kind: FeeKind, feeMicroAmount: number, shareBps: number): number {
  if (kind !== "taker" || feeMicroAmount <= 0) return 0;
  return Math.floor((feeMicroAmount * shareBps) / 1e4);
}

/**
 * Period label (unix seconds) of the settlement bucket containing `tsSec`. Buckets are
 * [P - interval, P) and are labelled with their END boundary P (the mark periodEnd they belong to).
 */
export function settlementPeriodOf(tsSec: number, intervalSec: number): number {
  return Math.floor(tsSec / intervalSec) * intervalSec + intervalSec;
}

/** Last completed period boundary at `nowSec`. */
export function lastCompletedPeriod(nowSec: number, intervalSec: number): number {
  return Math.floor(nowSec / intervalSec) * intervalSec;
}
