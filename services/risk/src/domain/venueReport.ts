// Which signed venue report (ops-venue, docs/LOW_GAS.md §2) values an Orderly book's venue right now. Pure.
//
// The adapter's on-chain figures are flow-adjusted (deposits / confirmations / cancels / failures move them
// at once) but, without a 30 s report loop, can be a whole mark period old. A signed report replaces them
// only when it is for this adapter (and chain), newer than the adapter's own report, and not older than the
// adapter's last on-chain flow (it would undo that flow). Same rules the mark uses for its valuation.
import { type SignedVenueReport, newestReport, reportConsistent } from "../../../ops-venue/src/report712";

/** Reports a few seconds ahead of the local clock (clock skew) still count. */
const CLOCK_SKEW_SEC = 5n;

export function pickVenueReport(
  reports: readonly SignedVenueReport[],
  o: { adapter: `0x${string}`; chainId: number | null; valuationAt: number; lastFlowAt: number; nowSec: number },
): SignedVenueReport | null {
  const valuationAt = BigInt(o.valuationAt);
  return newestReport(reports, (r) => {
    if (r.asOf <= valuationAt) return false;
    const why = reportConsistent(r, {
      adapter: o.adapter,
      chainId: o.chainId ?? r.chainId,
      snapshotTs: BigInt(o.nowSec) + CLOCK_SKEW_SEC,
      state: { lastFlowAt: BigInt(o.lastFlowAt) },
    });
    return why === null;
  });
}
