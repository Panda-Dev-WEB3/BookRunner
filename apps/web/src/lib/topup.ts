// Top-up rounds (Book.topUp(): open, endsAt, per-tranche capacity in USDC). Pure helpers, unit-tested
// in test/topup.test.ts; the hook that reads every book lives in src/wallet/topUp.ts.

export interface TopUpRound {
  bookId: number;
  /** The book reports an open round (it may still have ended by time: see isTopUpOpen). */
  open: boolean;
  /** Round end, unix seconds (0 when no round was ever opened). */
  endsAt: number;
  /** The round's Senior capacity, USDC base units (6 decimals). Fixed when the round opens: it is not
   *  reduced by deposits (subtract Tranche.totalCommitted for the room left; an oversubscribed round
   *  is filled pro-rata when it settles at the first mark on or after endsAt). */
  seniorCapacityUsd: bigint;
  /** The round's Junior capacity, USDC base units (6 decimals); fixed, like seniorCapacityUsd. */
  juniorCapacityUsd: bigint;
}

/**
 * Period end (unix seconds) of the first mark on or after `tSec`. A top-up round settles at the
 * first mark whose period ends at or after the round end (Tranche.settleAtMark checks
 * upToIndex * markInterval >= endsAt), never earlier: rounds cannot be closed early.
 */
export function firstMarkAtOrAfter(tSec: number, intervalSec: number): number {
  const i = Math.max(1, Math.floor(intervalSec));
  return Math.ceil(tSec / i) * i;
}

/** Deposits are accepted now: the round is open and has not ended. */
export function isTopUpOpen(r: TopUpRound | null | undefined, nowSec: number): boolean {
  return !!r && r.open && r.endsAt > nowSec;
}

/** The round's capacity for one tranche (0 when the round is closed). A total, not what is left. */
export function topUpCapacity(r: TopUpRound | null | undefined, tranche: "senior" | "junior", nowSec: number): bigint {
  if (!isTopUpOpen(r, nowSec) || !r) return 0n;
  return tranche === "senior" ? r.seniorCapacityUsd : r.juniorCapacityUsd;
}

/** Raw Book.topUp() tuple -> TopUpRound. */
export function parseTopUp(bookId: number, raw: readonly [boolean, bigint | number, bigint, bigint]): TopUpRound {
  const [open, endsAt, senior, junior] = raw;
  return { bookId, open, endsAt: Number(endsAt), seniorCapacityUsd: senior, juniorCapacityUsd: junior };
}
