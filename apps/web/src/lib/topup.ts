// Top-up rounds (Book.topUp(): open, endsAt, per-tranche capacity in USDC). Pure helpers, unit-tested
// in test/topup.test.ts; the hook that reads every book lives in src/wallet/topUp.ts.

export interface TopUpRound {
  bookId: number;
  /** The book reports an open round (it may still have ended by time: see isTopUpOpen). */
  open: boolean;
  /** Round end, unix seconds (0 when no round was ever opened). */
  endsAt: number;
  /** Remaining Senior capacity, USDC base units (6 decimals). */
  seniorCapacityUsd: bigint;
  /** Remaining Junior capacity, USDC base units (6 decimals). */
  juniorCapacityUsd: bigint;
}

/** Deposits are accepted now: the round is open and has not ended. */
export function isTopUpOpen(r: TopUpRound | null | undefined, nowSec: number): boolean {
  return !!r && r.open && r.endsAt > nowSec;
}

/** Capacity left for one tranche (0 when the round is closed). */
export function topUpCapacity(r: TopUpRound | null | undefined, tranche: "senior" | "junior", nowSec: number): bigint {
  if (!isTopUpOpen(r, nowSec) || !r) return 0n;
  return tranche === "senior" ? r.seniorCapacityUsd : r.juniorCapacityUsd;
}

/** Raw Book.topUp() tuple -> TopUpRound. */
export function parseTopUp(bookId: number, raw: readonly [boolean, bigint | number, bigint, bigint]): TopUpRound {
  const [open, endsAt, senior, junior] = raw;
  return { bookId, open, endsAt: Number(endsAt), seniorCapacityUsd: senior, juniorCapacityUsd: junior };
}
