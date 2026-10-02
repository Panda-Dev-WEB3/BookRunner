// Wallet-wide totals: the marked value of every share owned (with the Senior / Junior split), deposits
// waiting for a mark, shares in redemption and what is ready to claim.
import type { ReactNode } from "react";
import { DASH } from "../../lib/format";
import { Term } from "../Term";
import { Card, Skeleton, ValueKind } from "../ui";
import { markLabel, pctLabel, shares, usd } from "./display";
import { type MarkTimes, type PortfolioTotals, splitFractions } from "./model";

function SplitBar({ senior, junior }: { senior: bigint; junior: bigint }) {
  const f = splitFractions(senior, junior);
  if (f.senior === 0 && f.junior === 0) return null;
  return (
    <div className="mt-5">
      <div
        className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-surface-3"
        role="img"
        aria-label={`Split of your position value: Senior ${pctLabel(f.senior)}, Junior ${pctLabel(f.junior)}`}
      >
        {f.senior > 0 && <div className="h-full bg-senior first:rounded-l-full last:rounded-r-full" style={{ width: `${f.senior * 100}%` }} />}
        {f.junior > 0 && <div className="h-full bg-junior first:rounded-l-full last:rounded-r-full" style={{ width: `${f.junior * 100}%` }} />}
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-x-6 gap-y-1.5 text-[12.5px]">
        <li className="flex items-center gap-2">
          <span className="size-2.5 rounded-[3px] bg-senior" aria-hidden />
          <span className="text-ink-2">
            <Term id="senior">Senior</Term>
          </span>
          <span className="num font-medium text-ink">{usd(senior)}</span>
          <span className="num text-muted">{pctLabel(f.senior)}</span>
        </li>
        <li className="flex items-center gap-2">
          <span className="size-2.5 rounded-[3px] bg-junior" aria-hidden />
          <span className="text-ink-2">
            <Term id="junior">Junior</Term>
          </span>
          <span className="num font-medium text-ink">{usd(junior)}</span>
          <span className="num text-muted">{pctLabel(f.junior)}</span>
        </li>
      </ul>
    </div>
  );
}

function Mini(props: { label: ReactNode; value: ReactNode; sub?: ReactNode; highlight?: boolean }) {
  return (
    <div className={props.highlight ? "rounded-control bg-accent-soft px-3 py-2.5" : "px-3 py-2.5"}>
      <div className="text-[12px] font-medium text-ink-2">{props.label}</div>
      <div className="num mt-1 text-[17px] font-medium tracking-[-0.01em] text-ink">{props.value}</div>
      {props.sub && <div className="mt-0.5 text-[11.5px] leading-snug text-muted">{props.sub}</div>}
    </div>
  );
}

/** loading: nothing loaded yet · unknown: every position failed to load · ready: totals are shown. */
export type OverviewState = "loading" | "unknown" | "ready";

export function Overview(props: { totals: PortfolioTotals; marks: MarkTimes; state: OverviewState; failedBooks: number }) {
  const t = props.totals;
  const ready = props.state === "ready";
  const claimAny = t.claimableUsd > 0n || t.claimableShares > 0n;
  const books = t.booksClaimable === 1 ? "1 book" : `${t.booksClaimable} books`;
  const show = (v: string): ReactNode => (ready ? v : props.state === "loading" ? <Skeleton className="mt-1 h-5 w-24" /> : DASH);
  return (
    <Card padding="lg" as="section" aria-label="Portfolio overview">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-[13px] font-medium text-ink-2">
          Position value at <Term id="nav">NAV</Term>
        </h2>
        <ValueKind kind="marked" />
      </div>
      {props.state === "loading" ? (
        <Skeleton className="mt-2 h-10 w-52" />
      ) : (
        <div className="num mt-1 text-[32px] leading-10 font-medium tracking-[-0.02em] text-ink sm:text-[38px] sm:leading-[46px]">{ready ? usd(t.value) : DASH}</div>
      )}
      <p className="mt-1 text-[12.5px] text-ink-2">
        {markLabel(props.marks)}. Your shares times each tranche's marked <Term id="sharePrice">share price</Term>.
        {ready && t.claimableSharesValue > 0n && <> Includes {usd(t.claimableSharesValue)} of allocated shares waiting to be claimed.</>}
      </p>
      {(t.partial || props.failedBooks > 0) && (
        <p className="mt-2 text-[12px] text-warn-ink" role="status">
          {props.state === "unknown"
            ? "Positions could not be loaded from the Bookrunner API just now. This retries on its own."
            : props.failedBooks > 0
              ? `${props.failedBooks === 1 ? "One book" : `${props.failedBooks} books`} could not be loaded, so the total may be incomplete. This retries on its own.`
              : "A balance could not be read from the chain just now, so the total leaves it out until it can."}
        </p>
      )}
      {ready && <SplitBar senior={t.senior} junior={t.junior} />}
      <div className="mt-5 grid grid-cols-1 gap-1 border-t border-line pt-3 sm:grid-cols-3">
        <Mini label="Pending deposits" value={show(usd(t.pendingDeposit))} sub={!ready ? null : t.pendingDeposit > 0n ? "In escrow until a mark accepts them" : "Nothing waiting"} />
        <Mini
          label="In redemption"
          value={show(shares(t.queuedShares))}
          sub={!ready ? null : t.queuedShares > 0n ? `About ${usd(t.queuedSharesValue)} at the latest price; the settling mark sets the amount` : "No open requests"}
        />
        <Mini
          label="Ready to claim"
          highlight={ready && claimAny}
          value={show(t.claimableUsd === 0n && t.claimableShares > 0n ? shares(t.claimableShares) : usd(t.claimableUsd))}
          sub={!ready ? null : !claimAny ? "Nothing to claim" : t.claimableUsd > 0n && t.claimableShares > 0n ? `Plus ${shares(t.claimableShares)}, in ${books}` : `In ${books}`}
        />
      </div>
    </Card>
  );
}
