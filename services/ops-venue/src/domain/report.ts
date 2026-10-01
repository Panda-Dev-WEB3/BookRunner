// IOrderlyAdapter.report inputs from venue account reads (pure).
import type { VenueAccount } from "@bookrunner/shared";

export interface ReportInput {
  insuranceUsd: bigint; // uint256: IF equity floored at 0
  marginUsd: bigint; // int256: MM equity (may be negative)
  netExposureUsd: bigint; // int256: signed MM position notional at the builder price (+ = book long)
  asOf: bigint; // uint64 unix seconds, strictly increasing
}

export function computeReport(ifAcct: VenueAccount, mmAcct: VenueAccount, symbol: string, nowMs: number, lastAsOf: bigint | null): ReportInput | null {
  const asOf = BigInt(Math.floor(nowMs / 1000));
  if (lastAsOf !== null && asOf <= lastAsOf) return null;
  const insuranceUsd = ifAcct.equityUsd > 0n ? ifAcct.equityUsd : 0n;
  const pos = mmAcct.position && mmAcct.position.symbol === symbol ? mmAcct.position : null;
  return { insuranceUsd, marginUsd: mmAcct.equityUsd, netExposureUsd: pos?.netExposureUsd ?? 0n, asOf };
}

/** Reporting applies while capital is (or may still be) on the venue. */
export const reportableState = (s: string) => s === "Live" || s === "Retiring";

/** Venue value used by the drop guard: insurance + max(margin, 0). */
export const reportedValue = (r: ReportInput): bigint => r.insuranceUsd + (r.marginUsd > 0n ? r.marginUsd : 0n);

/**
 * Guard against reporting a transient bad read (venue restart, empty simulator state) as a loss:
 * a fall of more than `maxDropBps` vs the last report, not explained by withdrawals requested since,
 * is held back until it has been observed `confirmations` times in a row.
 */
export function dropSuspicious(p: { lastValue: bigint | null; newValue: bigint; withdrawnSince: bigint; maxDropBps: number }): boolean {
  if (p.lastValue === null || p.lastValue <= 0n || p.maxDropBps >= 10_000) return false;
  const floor = (p.lastValue * BigInt(10_000 - p.maxDropBps)) / 10_000n;
  return p.newValue + p.withdrawnSince < floor;
}
