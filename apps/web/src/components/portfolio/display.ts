// Display helpers for the Portfolio page: amounts, times and plain-language labels. Pure (the
// time-zone-free parts are unit-tested in test/portfolio.test.ts).
import { DASH, fmtUsd, fmtWhen } from "../../lib/format";
import type { ActivityKind, DepositSettlement, RedemptionStage, TrancheName } from "./model";

export const PORTFOLIO_LEAD =
  "Your shares in every book, valued at each book's latest signed mark, with deposits waiting to settle, redemption requests and anything ready to claim.";

export const TRANCHE_NAME: Record<TrancheName, string> = { senior: "Senior", junior: "Junior" };

/** "$1,234.56" from 6-decimal base units. */
export const usd = (raw: bigint | null | undefined): string => (raw == null ? DASH : fmtUsd(raw, { symbol: true }));

/** "1,234.56 shares" from 6-decimal base units. */
export const shares = (raw: bigint | null | undefined): string => (raw == null ? DASH : `${fmtUsd(raw)} ${raw === 1_000_000n ? "share" : "shares"}`);

/** Coarse time until a moment: "in 3 days", "in 4 h", "in 12 min", "now" (past: "now"). */
export function fmtUntil(unixSec: number | null | undefined, nowSec: number): string {
  if (unixSec == null || !Number.isFinite(unixSec)) return DASH;
  const s = unixSec - nowSec;
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h} h`;
  return `in ${Math.floor(h / 24)} days`;
}

/** Plain sentence for when a pending deposit settles. */
export function settlementText(s: DepositSettlement, timeZone?: string): string {
  switch (s.kind) {
    case "window":
      return s.at ? `Allocated when the subscription window closes, ${fmtWhen(s.at, timeZone)}.` : "Allocated when the subscription window closes.";
    case "round":
      return `Accepted at the first mark after the top-up round ends, ${fmtWhen(s.endsAt, timeZone)}, at that mark's share price.`;
    case "nextMark":
      return s.at ? `The round has ended: accepted at the next mark, ${fmtWhen(s.at, timeZone)}.` : "The round has ended: accepted at the next mark.";
  }
}

export const STAGE_LABEL: Record<RedemptionStage, string> = {
  notice: "Notice period",
  queued: "Waiting for its mark",
  claimable: "Ready to claim",
  settled: "Settled",
  claimed: "Claimed",
};

export const STAGE_TONE: Record<RedemptionStage, "neutral" | "accent" | "good" | "warn"> = {
  notice: "warn",
  queued: "neutral",
  claimable: "accent",
  settled: "good",
  claimed: "good",
};

export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  deposit: "Deposit",
  allocation: "Shares claimed",
  redeemRequest: "Redemption requested",
  redemptionClaim: "Redemption claimed",
  refund: "Refund claimed",
};

/** "At the latest mark (2 Oct 2026, 17:00)", or the span when the books' latest marks differ. */
export function markLabel(m: { newest: number | null; oldest: number | null; same: boolean }, timeZone?: string): string {
  if (m.newest === null) return "No mark yet";
  if (m.same || m.oldest === null) return `At the latest mark (${fmtWhen(m.newest, timeZone)})`;
  return `At each book's latest mark (${fmtWhen(m.oldest, timeZone)} to ${fmtWhen(m.newest, timeZone)})`;
}

/** Whole percent of a 0..1 fraction ("70%"); "<1%" / ">99%" for slivers. */
export function pctLabel(frac: number): string {
  if (!Number.isFinite(frac) || frac <= 0) return "0%";
  if (frac < 0.01) return "<1%";
  if (frac > 0.99 && frac < 1) return ">99%";
  return `${Math.round(frac * 100)}%`;
}
