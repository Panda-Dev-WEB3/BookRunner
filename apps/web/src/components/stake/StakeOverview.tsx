// Protocol-wide staking figures for the top of the Stake page, read live from the chain.
import type { ReactNode } from "react";
import { fmtDuration, fmtUsd } from "../../lib/format";
import { ErrorState, Skeleton, Stat, StatGrid } from "../ui";
import { fmtBkrn, fmtBkrnCompact, fmtShare, ratio } from "./stakeLogic";
import type { StakingProtocol } from "./useStaking";

/** Figure with a smaller unit after it ("2.2M BKRN"). */
export function WithUnit(props: { value: ReactNode; unit: string }) {
  return (
    <>
      {props.value}
      <span className="ml-1.5 text-[0.55em] font-medium tracking-normal text-ink-2">{props.unit}</span>
    </>
  );
}

export function StakeOverview(props: { data: StakingProtocol | undefined; isLoading: boolean; error: unknown; onRetry: () => void; noBooks: boolean }) {
  const d = props.data;
  if (!d) {
    if (props.noBooks) return null;
    if (props.error && !props.isLoading) return <ErrorState error={props.error} onRetry={props.onRetry} />;
    return (
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 rounded-card border border-line bg-surface p-4 shadow-card sm:p-5 lg:grid-cols-4" aria-busy="true" aria-label="Loading staking figures">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
    );
  }
  const supplyShare = d.totalStaked !== null && d.totalSupply ? ratio(d.totalStaked, d.totalSupply) : null;
  const distributed = d.distributedBkrn;
  return (
    <StatGrid cols={4}>
      <Stat
        size="lg"
        series="bkrn"
        label="Total staked"
        term="staking"
        title={fmtBkrn(d.totalStaked)}
        value={<WithUnit value={fmtBkrnCompact(d.totalStaked)} unit="BKRN" />}
        sub={supplyShare !== null ? `${fmtShare(supplyShare)} of the fixed supply` : "Every staker, bonds included"}
      />
      <Stat size="lg" label="Unstake cooldown" value={d.cooldownSec === null ? "—" : fmtDuration(d.cooldownSec)} sub="Wait between asking and withdrawing" />
      <Stat
        size="lg"
        series="bkrn"
        label="Shared with stakers"
        title={fmtBkrn(distributed)}
        value={<WithUnit value={fmtBkrnCompact(distributed)} unit="BKRN" />}
        sub={distributed === 0n ? "No buyback has run yet" : "Bought back with carry, all time"}
      />
      <Stat
        size="lg"
        series="backstop"
        label="Backstop pool"
        term="backstop"
        value={<WithUnit value={fmtUsd(d.backstopBalanceUsd)} unit="USDC" />}
        sub="Held in USDC, apart from stake"
      />
    </StatGrid>
  );
}
