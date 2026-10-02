// Low-gas mode display helpers (docs/LOW_GAS.md): the next mark (one mark transaction per book per period,
// daily on mainnet), the age of the oracle's latest signed price (prices ride in the transactions that need
// them, so the price stored on-chain is old between trades by design) and of ops-venue's signed venue report.
import { DASH, fmtAge, fmtDuration } from "./format";

export interface MarkScheduleLike {
  intervalSeconds: number;
  cadence: string;
  nextPeriodEnd: number;
  status: "due" | "scheduled";
}

/** "in 5h 12m" / "due now" — recomputed against the page clock so it counts down between polls. */
export function nextMarkLabel(s: MarkScheduleLike | null | undefined, nowMs: number): string {
  if (!s) return DASH;
  if (s.status === "due") return "due now";
  const left = s.nextPeriodEnd - Math.floor(nowMs / 1000);
  return left <= 0 ? "due now" : `in ${fmtAge(left * 1000)}`;
}

/** Period end of the next mark as a short UTC time ("2026-10-03 00:00 UTC"). */
export function nextMarkAt(s: MarkScheduleLike | null | undefined): string {
  if (!s) return DASH;
  return `${new Date(s.nextPeriodEnd * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Period end of the mark that settles a redemption request eligible at `eligibleAtSec` (now for
 * Senior, now + notice for Junior), as Tranche.requestRedeem files it: bucket ceil(eligibleAt / I),
 * never an already-settled bucket (lastPeriodEnd / I or earlier). Not markSchedule.nextPeriodEnd,
 * which while a mark is due is the closed period's end: a request filed then lands one period later.
 */
export function redeemSettlesAt(eligibleAtSec: number, s: { intervalSeconds: number; lastPeriodEnd?: number | null }): number {
  const i = Math.max(1, Math.floor(s.intervalSeconds));
  const bucket = Math.ceil(eligibleAtSec / i);
  const lastSettled = s.lastPeriodEnd != null ? Math.floor(s.lastPeriodEnd / i) : -1;
  return (bucket <= lastSettled ? lastSettled + 1 : bucket) * i;
}

/** "Daily marks" / "Hourly marks" / "Marks every 5 min". */
export function cadenceTitle(cadence: string | null | undefined): string {
  if (!cadence) return "Marks";
  if (cadence === "daily" || cadence === "hourly") return `${cadence[0]!.toUpperCase()}${cadence.slice(1)} marks`;
  return `Marks ${cadence}`;
}

export const markCadenceLine = (cadence: string, intervalSeconds: number) =>
  `One signed mark per period (${cadence}, ${fmtDuration(intervalSeconds)}): a single on-chain transaction per book commits and applies it, carrying the signed prices and venue report it was valued with. Redemptions settle at that mark.`;

export const SIGNED_PRICE_LINE =
  "Prices are signed off-chain by the attested oracle and carried by the transactions that need them, so the price stored on-chain only moves when someone trades or marks. The age shown is the age of the latest signed price.";

export const VENUE_REPORT_LINE = "Venue balances are signed off-chain by the venue operator and relayed on-chain inside the next mark.";

export type Freshness = "fresh" | "aging" | "stale";

/** Age of a signed input against the protocol's maxPriceAge: fresh < 1/4, aging < 1, stale beyond. */
export function signedFreshness(ageSeconds: number | null | undefined, maxAgeSeconds: number): Freshness | null {
  if (ageSeconds == null || !Number.isFinite(ageSeconds)) return null;
  if (ageSeconds > maxAgeSeconds) return "stale";
  return ageSeconds > maxAgeSeconds / 4 ? "aging" : "fresh";
}

/** Age of an ISO timestamp, recomputed against the page clock. */
export function ageOf(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? DASH : `${fmtAge(Math.max(0, nowMs - t))} ago`;
}
