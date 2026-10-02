// When may the mark for period P be computed (pure)?
//   after the waterfall distributed P (fee flow credited to S/J first) and, if queued redemptions due at
//   this mark exceed vault idle while a recall is still in flight, after the recall lands —
//   or once MARK_WAIT_SECONDS have passed since P (whatever has arrived is marked).
import { type BookState, VENUE } from "@bookrunner/shared";

export interface ReadinessInput {
  state: BookState;
  nowSec: number; // chain time
  periodEnd: number;
  lastMarkPeriodEnd: number;
  waitSeconds: number;
  maxMarkAge: number;
  /** Do not start a mark this close to the registry's maxMarkAge limit. */
  safetySeconds: number;
  distributed: boolean;
  liquidityShort: boolean;
}

export type Readiness =
  | { ready: true; reason: "distributed" | "timeout" }
  | { ready: false; reason: "state" | "marked" | "not_due" | "too_old" | "waiting_distribution" | "waiting_liquidity" };

export function markReadiness(i: ReadinessInput): Readiness {
  if (i.state !== "Live" && i.state !== "Retiring") return { ready: false, reason: "state" };
  if (i.lastMarkPeriodEnd >= i.periodEnd) return { ready: false, reason: "marked" };
  if (i.periodEnd <= 0 || i.nowSec < i.periodEnd) return { ready: false, reason: "not_due" };
  if (i.nowSec - i.periodEnd > i.maxMarkAge - i.safetySeconds) return { ready: false, reason: "too_old" };
  if (i.distributed && !i.liquidityShort) return { ready: true, reason: "distributed" };
  if (i.nowSec >= i.periodEnd + i.waitSeconds) return { ready: true, reason: "timeout" };
  return { ready: false, reason: i.distributed ? "waiting_liquidity" : "waiting_distribution" };
}

/** Liquidity is "short" only while waiting can help: due > idle and capital is in flight to the vault. */
export function liquidityShort(dueAssets: bigint, unfundedClaims: bigint, vaultIdle: bigint, inTransit: bigint): boolean {
  return inTransit > 0n && dueAssets + unfundedClaims > vaultIdle;
}

/**
 * Orderly books value the venue from the adapter's last ops-venue report (valuationAt = its asOf).
 * Age is measured at the snapshot block, which is never earlier than periodEnd, so a report older
 * than `maxAgeSec` relative to periodEnd is always refused too. Engine books are valued live
 * on-chain and never stale. `maxAgeSec <= 0` disables the check.
 */
export function venueReportAge(venue: number, valuationAt: number, blockTimestamp: number, maxAgeSec: number): { stale: boolean; ageSec: number } {
  if (venue !== VENUE.ORDERLY) return { stale: false, ageSec: 0 };
  const ageSec = Math.max(0, blockTimestamp - valuationAt);
  return { stale: maxAgeSec > 0 && ageSec > maxAgeSec, ageSec };
}
