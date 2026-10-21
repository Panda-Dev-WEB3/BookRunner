// The connected wallet's place in the insurance pool: shares, their value at the current share price, the
// cooldown, and what is queued or ready to collect.
import { useNow } from "../../api/hooks";
import type { PoolPositionOut } from "../../lib/api-types";
import { fmtUsd, usdRaw } from "../../lib/format";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { WithUnit } from "../stake/StakeOverview";
import { Card, ErrorState, Skeleton, Stat } from "../ui";
import { actionableCount, cooldownLine, fmtShares, openRequests } from "./poolLogic";

export function PoolPosition(props: { position: PoolPositionOut | undefined; isLoading: boolean; error: unknown; onRetry: () => void }) {
  const sym = useSettlementSymbol();
  const now = useNow(30_000);
  const p = props.position;
  if (!p) {
    if (props.error && !props.isLoading) return <ErrorState compact error={props.error} onRetry={props.onRetry} />;
    return (
      <Card title="Your pool position" padding="md">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-6 w-24" />
            </div>
          ))}
        </div>
      </Card>
    );
  }
  const open = openRequests(p);
  const queuedUsd = open.deposits.filter((d) => d.status === "queued").reduce((a, d) => a + (usdRaw(d.assetsUsd) ?? 0n), 0n);
  const todo = actionableCount(p);
  const cd = cooldownLine(p, now);
  return (
    <Card title="Your pool position" padding="md" description={p.live ? undefined : "The chain could not be read just now: shares and value show again once it answers."}>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Stat label="Shares" value={fmtShares(p.shares)} title={p.shares ?? undefined} />
        <Stat label="Value now" value={p.valueUsd === null ? "—" : <WithUnit value={fmtUsd(p.valueUsd)} unit={sym} />} sub="At the current share price" />
        <Stat label="Deposits queued" value={<WithUnit value={fmtUsd(queuedUsd)} unit={sym} />} sub={`${open.deposits.length} open deposit request${open.deposits.length === 1 ? "" : "s"}`} />
        <Stat label="Ready to collect" value={String(todo)} sub={todo > 0 ? "See the Requests tab" : "Nothing to collect"} />
      </div>
      {cd && <p className="mt-4 border-t border-line pt-3 text-[12.5px] text-ink-2">{cd}</p>}
    </Card>
  );
}
