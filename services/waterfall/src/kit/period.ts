// Mark-period math (unix seconds). Period label = periodEnd = floor(now / interval) * interval.

/** Latest CLOSED period label at `nowSec`. */
export function periodEndAt(nowSec: number, intervalSec: number): number {
  if (!Number.isInteger(intervalSec) || intervalSec <= 0) throw new Error(`invalid interval: ${intervalSec}`);
  return Math.floor(nowSec / intervalSec) * intervalSec;
}

/**
 * periodEnd of the next mark to be applied: the latest closed period if it has not been marked yet,
 * otherwise the one after it.
 */
export function nextMarkPeriodEnd(nowSec: number, intervalSec: number, lastMarkPeriodEnd: number): number {
  const p = periodEndAt(nowSec, intervalSec);
  return lastMarkPeriodEnd >= p ? p + intervalSec : p;
}

/** Highest redemption bucket a mark with this periodEnd settles (Waterfall.settlesUpTo). */
export function settlesUpToIndex(periodEnd: number, intervalSec: number): bigint {
  return BigInt(Math.floor(periodEnd / intervalSec));
}

/** True when `period` is a valid, closed label not yet handled (strictly newer than `last`). */
export function isNewPeriod(period: number, last: number | undefined): boolean {
  return period > 0 && (last === undefined || period > last);
}
