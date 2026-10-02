// Orderly venue valuation from ops-venue's signed reports (pure). docs/LOW_GAS.md §2: reports no longer land
// on-chain every 30 s; the mark relays the latest signed one inside its commitAndApply tx and values the
// venue from it.
//
// A signed report replaces the adapter's (older) on-chain venue view only when it is CONSISTENT with the
// snapshot block (services/ops-venue/src/report712.ts reportConsistent): same adapter + chain, not after the
// snapshot block, not before the adapter's last on-chain flow (deposit / confirm / cancel / fail), and newer
// than the adapter's own report. Otherwise the adapter's figures (always flow-adjusted) are used.
import { VENUE } from "@bookrunner/shared";
import { type SignedVenueReport, newestReport, reportConsistent, reportDeployedValueUsd } from "../../../ops-venue/src/report712";
import type { MarkSnapshot } from "./types";

export interface VenueOverlay {
  snapshot: MarkSnapshot;
  /** the signed report the venue is valued from (null: the adapter's on-chain report) */
  report: SignedVenueReport | null;
  /** why candidates were not used (diagnostics) */
  rejected: string[];
}

export function applySignedVenueReport(s: MarkSnapshot, reports: readonly SignedVenueReport[], o: { venue: number; adapter: `0x${string}`; chainId: number }): VenueOverlay {
  if (o.venue !== VENUE.ORDERLY || reports.length === 0) return { snapshot: s, report: null, rejected: [] };
  const rejected: string[] = [];
  const state = { lastFlowAt: BigInt(s.venue.lastFlowAt ?? 0) };
  const snapshotTs = BigInt(s.blockTimestamp);
  const best = newestReport(reports, (r) => {
    const why = reportConsistent(r, { adapter: o.adapter, chainId: o.chainId, snapshotTs, state });
    if (why) rejected.push(`asOf ${r.asOf}: ${why}`);
    return why === null;
  });
  if (!best) return { snapshot: s, report: null, rejected };
  if (best.asOf <= BigInt(s.venue.valuationAt)) {
    rejected.push(`asOf ${best.asOf}: not newer than the adapter's report (${s.venue.valuationAt})`);
    return { snapshot: s, report: null, rejected };
  }
  const venue: MarkSnapshot["venue"] = {
    ...s.venue,
    insuranceUsd: best.insuranceUsd,
    marginUsd: best.marginUsd,
    netExposureUsd: best.netExposureUsd,
    deployedValueUsd: reportDeployedValueUsd(best, s.venue.inTransitUsd),
    valuationAt: Number(best.asOf),
    source: "signed_report",
  };
  return { snapshot: { ...s, venue }, report: best, rejected };
}
