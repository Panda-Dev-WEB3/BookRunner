// Redemption timing (ERC-7540 style). Senior: eligible at request; Junior: request + notice.
// A request settles at the first mark whose periodEnd >= eligibleAt. Notice is not a gate: requests
// are always accepted, in every book state, and are never permission-gated.
import { bucketIndex, redeemEligibleAt } from "@bookrunner/shared/waterfall";

export const NOTICE_TEXT =
  "Notice is not a gate: the request is always accepted and settles at the first mark on or after the eligible time, at that mark's share price.";

export interface RedeemSchedule {
  requestedAt: number; // unix seconds
  eligibleAt: number;
  noticeSeconds: number;
  requestId: string; // bucket index
  settlesAtPeriodEnd: number; // periodEnd of the mark that settles the request
}

export function redeemSchedule(kind: 0 | 1, requestedAt: number, juniorNoticeSeconds: bigint, markInterval: number): RedeemSchedule {
  const eligible = redeemEligibleAt(kind, BigInt(requestedAt), juniorNoticeSeconds);
  const interval = BigInt(Math.max(1, markInterval));
  const bucket = bucketIndex(eligible, interval);
  return {
    requestedAt,
    eligibleAt: Number(eligible),
    noticeSeconds: kind === 0 ? 0 : Number(juniorNoticeSeconds),
    requestId: bucket.toString(),
    settlesAtPeriodEnd: Number(bucket * interval),
  };
}

/** The bucket a stored redemption row maps to, preferring the on-chain request id. */
export function bucketOf(requestId: string | null, eligibleAt: Date, markInterval: number): bigint {
  if (requestId && /^\d+$/.test(requestId)) return BigInt(requestId);
  return bucketIndex(BigInt(Math.floor(eligibleAt.getTime() / 1000)), BigInt(Math.max(1, markInterval)));
}
