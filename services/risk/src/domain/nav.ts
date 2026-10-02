// Live (intra-mark) NAV estimate and drawdown. Pure.
//
//   liveNav     = markedNav(vault idle, unfundedClaims, venue deployed + desk value)
//                 (same formula Book.applyMark uses: cash floored at 0 after unfunded claims)
//   accounted   = seniorNav + juniorNav (Book.trancheNav)
//   liveIndex   = perfIndex * liveNav / accounted
//   highWater'  = max(highWater, liveIndex)
//   drawdownBps = (liveIndex - highWater') * 1e4 / highWater'   (<= 0)
//
// The performance-index step is delegated to the NORMATIVE applyMarkPnl so the live estimate is
// exactly what Book.applyMark would compute if a mark with deployedValueUsd = live value landed now.
import { applyMarkPnl, markedNav } from "@bookrunner/shared";
import type { LiveNavResult, NavInputs } from "../types";

export function computeLiveNav(n: NavInputs): LiveNavResult {
  const deployed = n.venueDeployedUsd + n.deskValueUsd;
  const navUsd = markedNav(n.vaultIdleUsd, n.unfundedClaimsUsd, deployed > 0n ? deployed : 0n);
  const accountedNavUsd = n.seniorNavUsd + n.juniorNavUsd;
  const r = applyMarkPnl(
    {
      seniorNav: n.seniorNavUsd,
      juniorNav: n.juniorNavUsd,
      seniorImpairment: 0n,
      perfIndex: n.perfIndexWad,
      highWater: n.highWaterWad,
    },
    { nav: navUsd, juniorSupply: 1n, backstopAvailable: 0n },
  );
  return {
    navUsd,
    accountedNavUsd,
    liveIndexWad: r.perfIndex,
    highWaterWad: r.highWater,
    drawdownBps: Number(r.drawdownBps),
  };
}

/**
 * Venue deployed value for the live estimate. When the live venue API answered (Orderly), the MM
 * margin component of the adapter's last report is replaced by the live MM equity:
 *   insurance (last report) + max(live MM equity, 0) + in-transit.
 * Otherwise the adapter's own deployedValueUsd (engine: live on-chain; Orderly: last report).
 */
/**
 * The live venue API lags on-chain deposits (the venue credits them only after indexing / cross-chain
 * delivery). Within `settleSec` of the adapter's last capital flow the venue equity is not trusted and
 * the adapter's on-chain figures are used instead — a deposit in flight must never read as a drawdown.
 */
export function trustLiveVenueEquity(nowSec: number, lastFlowAt: number | undefined, settleSec: number): boolean {
  return !lastFlowAt || nowSec - lastFlowAt >= settleSec;
}

export function venueDeployedValue(
  adapter: { deployedValueUsd: bigint; insuranceEquityUsd: bigint; inTransitUsd: bigint },
  liveMmEquityUsd: bigint | null,
): bigint {
  if (liveMmEquityUsd === null) return adapter.deployedValueUsd;
  return adapter.insuranceEquityUsd + (liveMmEquityUsd > 0n ? liveMmEquityUsd : 0n) + adapter.inTransitUsd;
}
