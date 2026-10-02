// BKRN staking at a glance (read-only): staked, locked as bonds, cooling down, free to unstake and
// distributions waiting to be claimed. Staking itself happens on /stake.
import type { Address } from "viem";
import { Link } from "react-router";
import { useNow } from "../../api/hooks";
import { BKRN_DECIMALS, formatAmountDisplay } from "../../lib/amount";
import { IconArrowRight } from "../icons";
import { Term } from "../Term";
import { Card, ErrorState, KV, SkeletonRows } from "../ui";
import { fmtUntil, fmtWhen } from "./display";
import { useStakingSummary } from "./hooks";
import { stakingView } from "./model";

const bkrn = (v: bigint) => `${formatAmountDisplay(v, BKRN_DECIMALS, 2)} BKRN`;

export function StakingSummary({ wallet }: { wallet: Address }) {
  const q = useStakingSummary(wallet);
  const now = useNow(30_000);
  const nowSec = Math.floor(now / 1000);
  const v = q.data ? stakingView(q.data, nowSec) : null;
  return (
    <Card
      as="section"
      aria-label="BKRN staking"
      eyebrow={<span className="text-backstop-ink">BKRN</span>}
      title={<Term id="staking">Staking</Term>}
      description="Staked BKRN backs the bonds of sponsors, committee members and agent operators: access and bonding, never a revenue claim."
    >
      {v ? (
        v.hasStake ? (
          <KV
            rows={[
              ["Staked", bkrn(v.staked)],
              v.locked > 0n && ["Locked as bonds", bkrn(v.locked)],
              v.pendingUnstake > 0n && [
                v.unstake === "ready" ? "Unstake ready to withdraw" : "Cooling down",
                <span key="cool">
                  {bkrn(v.pendingUnstake)}
                  <span className="block text-[11px] text-muted">{v.unstake === "ready" ? `since ${fmtWhen(v.unstakeAvailableAt)}` : `until ${fmtWhen(v.unstakeAvailableAt)} (${fmtUntil(v.unstakeAvailableAt, nowSec)})`}</span>
                </span>,
              ],
              ["Free to unstake", bkrn(v.available)],
              v.earned > 0n && ["Bought-back BKRN distributed to you", bkrn(v.earned)],
            ]}
          />
        ) : (
          <p className="text-[13px] text-ink-2">This wallet has no BKRN staked.</p>
        )
      ) : q.error ? (
        <ErrorState compact error={q.error} onRetry={() => void q.refetch()} />
      ) : q.stakingAddress === null && !q.contractsLoading ? (
        <p className="text-[13px] text-muted">The staking contract address is not known yet (no book is listed by the API).</p>
      ) : (
        <SkeletonRows rows={3} />
      )}
      <Link to="/stake" className="btn btn-sm mt-4">
        {v?.hasStake ? "Manage staking" : "Learn about staking"}
        <IconArrowRight size={14} />
      </Link>
    </Card>
  );
}
