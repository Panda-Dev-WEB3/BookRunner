// Pool-wide figures at the top of the Insurance Pool page: value, share price, first-loss slice against its
// required size, free liquidity, what books hold, utilisation, premiums and losses so far.
import type { PoolOverviewOut } from "../../lib/api-types";
import { bpsPct, fmtDateTime, fmtSharePrice, fmtUsd } from "../../lib/format";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { WithUnit } from "../stake/StakeOverview";
import { Callout, ErrorState, ProgressBar, Skeleton, Stat, StatGrid } from "../ui";
import { DEFAULT_FIRST_LOSS_LEVEL_BPS, firstLossView } from "./poolLogic";

export function PoolOverviewSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-5 rounded-card border border-line bg-surface p-4 shadow-card sm:p-5 lg:grid-cols-4" aria-busy="true" aria-label="Loading pool figures">
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-3 w-32" />
        </div>
      ))}
    </div>
  );
}

export function PoolOverview(props: { data: PoolOverviewOut | undefined; error: unknown; onRetry: () => void }) {
  const sym = useSettlementSymbol();
  const d = props.data;
  if (!d) return props.error ? <ErrorState error={props.error} onRetry={props.onRetry} /> : <PoolOverviewSkeleton />;
  const fl = firstLossView(d.firstLossBps, d.params?.firstLossTargetBps ?? DEFAULT_FIRST_LOSS_LEVEL_BPS);
  return (
    <div className="space-y-3">
      {!d.live && (
        <Callout tone="warn" compact title="Showing the last indexed figures">
          The chain could not be read just now, so these figures come from the indexer's newest pool snapshot ({fmtDateTime(d.asOf)}). The queue status shows again once the chain answers.
        </Callout>
      )}
      {d.paused?.deposits && (
        <Callout tone="warn" compact title="New deposits are paused">
          The guardian paused new deposits into the pool. Withdrawal requests, processing, claims and deposit cancellations are never paused.
        </Callout>
      )}
      <StatGrid cols={4}>
        <Stat size="lg" label="Pool value" term="insurancePool" value={<WithUnit value={fmtUsd(d.poolAssetsUsd, { compact: true })} unit={sym} />} title={fmtUsd(d.poolAssetsUsd, { dp: 6 })} sub="Free cash plus what books can repay at their last marks" />
        <Stat size="lg" label="Share price" term="sharePrice" value={fmtSharePrice(d.sharePriceUsd)} sub={`${sym} per pool share, set at each epoch's processing`} />
        <Stat
          size="lg"
          label="First-loss slice"
          term="firstLossSlice"
          series="backstop"
          value={<WithUnit value={fmtUsd(d.firstLossUsd, { compact: true })} unit={sym} />}
          sub={
            <span className="block space-y-1">
              <span className="block">
                {bpsPct(fl.bps, 1)} of the pool · level {bpsPct(fl.levelBps)}
              </span>
              <ProgressBar value={fl.fill} label="First-loss slice against its required size" tone={fl.below ? "warn" : "backstop"} />
            </span>
          }
        />
        <Stat size="lg" label="Utilisation" value={bpsPct(d.utilisationBps, 1)} sub="Share of the pool lent to books" />
        <Stat label="Free liquidity" value={<WithUnit value={fmtUsd(d.freeLiquidityUsd, { compact: true })} unit={sym} />} sub="Cash that can fill withdrawals" />
        <Stat
          label="Allocated to books"
          term="insuranceFund"
          value={<WithUnit value={fmtUsd(d.allocatedUsd, { compact: true })} unit={sym} />}
          sub={d.activeBooks == null ? "Insurance funds of pool-funded books" : `Insurance funds of ${d.activeBooks} active book${d.activeBooks === 1 ? "" : "s"}`}
        />
        <Stat label="Premiums received" series="fee" value={<WithUnit value={fmtUsd(d.premiumsTotalUsd, { compact: true })} unit={sym} />} sub="All time, from books' gross fee flow" />
        <Stat label="Losses" series="loss" value={<WithUnit value={fmtUsd(d.lossesTotalUsd, { compact: true })} unit={sym} />} sub="Net of recoveries; provisional while a book is live, final at its retirement; the first-loss slice takes them first" />
      </StatGrid>
    </div>
  );
}
