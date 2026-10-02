// One book in the portfolio: value at the latest mark, Senior and Junior holdings, deposits waiting for
// a mark, claimables and open redemption requests, with the Claim and Request redemption actions.
import { type ReactNode, useId } from "react";
import { Link } from "react-router";
import type { BookListItem } from "../../lib/api-types";
import { venueLabel } from "../../lib/copy";
import { fmtSharePrice, fmtUsd, fmtWhen, isoToSec, tickerOf } from "../../lib/format";
import { bookState } from "../../lib/limits";
import type { TopUpRound } from "../../lib/topup";
import { cx } from "../cx";
import { IconArrowRight } from "../icons";
import { Badge, Card, Hash, StateChip, TrancheBadge } from "../ui";
import { STAGE_LABEL, STAGE_TONE, TRANCHE_NAME, fmtUntil, settlementText, shares, usd } from "./display";
import { type BookHolding, type DepositSettlement, type TrancheHolding, type TrancheName, depositSettlement, redemptionStage } from "./model";

function Line(props: { label: ReactNode; value: ReactNode; note?: ReactNode; accent?: boolean }) {
  return (
    <li className={cx("rounded-[6px] px-2.5 py-2", props.accent ? "bg-accent-soft" : "bg-surface-2")}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className={cx("text-[12.5px] font-medium", props.accent ? "text-accent-text" : "text-ink-2")}>{props.label}</span>
        <span className="num text-[13px] font-medium text-ink">{props.value}</span>
      </div>
      {props.note && <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{props.note}</p>}
    </li>
  );
}

function TrancheTile(props: { t: TrancheHolding; settle: DepositSettlement; onRedeem: () => void }) {
  const t = props.t;
  const name = TRANCHE_NAME[t.tranche];
  const held = t.shares ?? 0n;
  const allocation = t.claimableShares > 0n || t.claimableRefund > 0n;
  const empty = held === 0n && t.pendingDeposit === 0n && !allocation && t.claimableRedemption === 0n && t.queuedShares === 0n;
  return (
    <section aria-label={`${name} tranche`} className={cx("min-w-0 rounded-control border border-line border-l-[3px] bg-surface p-3.5", t.tranche === "senior" ? "border-l-senior" : "border-l-junior")}>
      <TrancheBadge tranche={t.tranche} term size="sm" />
      {t.shares === null ? (
        <p className="mt-2 text-[12.5px] text-muted">Balance unavailable right now (the chain read failed). It refreshes on its own.</p>
      ) : empty ? (
        <p className="mt-2 text-[12.5px] text-muted">No {name} position.</p>
      ) : (
        <>
          <div className="num mt-2 text-[19px] leading-7 font-medium tracking-[-0.01em] text-ink">{usd(t.value)}</div>
          <div className="num text-[12px] text-ink-2">
            {held > 0n && t.claimableShares > 0n ? `${shares(held)} held + ${fmtUsd(t.claimableShares)} to claim` : t.claimableShares > 0n ? `${shares(t.claimableShares)} to claim` : shares(held)} at{" "}
            {fmtSharePrice(t.sharePrice, 6)}
          </div>
          <ul className="mt-3 space-y-1.5">
            {t.pendingDeposit > 0n && <Line label="Pending deposit" value={usd(t.pendingDeposit)} note={settlementText(props.settle)} />}
            {allocation && (
              <Line
                accent
                label="Allocation ready to claim"
                value={t.claimableShares > 0n ? shares(t.claimableShares) : usd(t.claimableRefund)}
                note={
                  t.claimableShares > 0n && t.claimableRefund > 0n
                    ? `Shares from a settled round, waiting in escrow and already counted in the value above, plus a ${usd(t.claimableRefund)} refund of the part the round did not accept.`
                    : t.claimableShares > 0n
                      ? "Shares from a settled round, waiting in escrow. They already count in the value above."
                      : "The round did not accept this deposit: the USDC is refundable."
                }
              />
            )}
            {t.claimableRedemption > 0n && <Line accent label="Redeemed, ready to claim" value={usd(t.claimableRedemption)} note="USDC from redemptions a mark has settled." />}
            {t.queuedShares > 0n && <Line label="In redemption" value={shares(t.queuedShares)} note="Settles at its mark, at that mark's share price." />}
          </ul>
        </>
      )}
      {held > 0n && (
        <button type="button" className="btn btn-sm mt-3" onClick={props.onRedeem}>
          Request redemption
          <span className="sr-only"> from {name}</span>
        </button>
      )}
    </section>
  );
}

function Redemptions(props: { holding: BookHolding; nowMs: number }) {
  const rows = props.holding.tranches
    .flatMap((t) => t.redemptions)
    .filter((r) => r.status !== "claimed")
    .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt));
  if (rows.length === 0) return null;
  const nowSec = Math.floor(props.nowMs / 1000);
  return (
    <div className="border-t border-line px-4 py-4 sm:px-5">
      <h4 className="text-[13px] font-semibold text-ink">Redemption requests</h4>
      <ul className="mt-2 divide-y divide-line">
        {rows.map((r) => {
          const stage = redemptionStage(r, props.nowMs);
          const settles = isoToSec(r.settlesAtPeriodEnd);
          return (
            <li key={`${r.tranche}-${r.requestId}-${r.requestTx ?? r.requestedAt}`} className="py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <TrancheBadge tranche={r.tranche} size="sm" />
                  <span className="num text-[13px] font-medium">{shares(r.shares)}</span>
                  {r.assets !== null && <span className="num text-[12px] text-ink-2">settled for {usd(r.assets)}</span>}
                </div>
                <Badge tone={STAGE_TONE[stage]} dot size="sm">
                  {STAGE_LABEL[stage]}
                </Badge>
              </div>
              <dl className="mt-1.5 grid gap-x-5 gap-y-0.5 text-[12px] text-ink-2 sm:grid-cols-3">
                <div>
                  <dt className="inline text-muted">Requested </dt>
                  <dd className="num inline">{fmtWhen(isoToSec(r.requestedAt))}</dd>
                </div>
                <div>
                  <dt className="inline text-muted">{r.tranche === "junior" ? "Notice ends " : "Eligible "}</dt>
                  <dd className="num inline">{fmtWhen(isoToSec(r.eligibleAt))}</dd>
                </div>
                <div>
                  <dt className="inline text-muted">Settles at the mark ending </dt>
                  <dd className="num inline">
                    {fmtWhen(settles)}
                    {(stage === "notice" || stage === "queued") && settles !== null && <span className="text-muted"> ({fmtUntil(settles, nowSec)})</span>}
                  </dd>
                </div>
              </dl>
              {r.requestTx && (
                <div className="mt-1 flex items-center gap-1 text-[11.5px] text-muted">
                  Request transaction <Hash value={r.requestTx} kind="tx" />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-[11.5px] text-muted">Notice is not a gate: every request is accepted and settles at the first mark on or after its eligible time.</p>
    </div>
  );
}

export function BookPositionCard(props: {
  book: BookListItem;
  holding: BookHolding;
  round: TopUpRound | undefined;
  nowMs: number;
  onClaim: () => void;
  onRedeem: (tranche: TrancheName) => void;
}) {
  const { book, holding } = props;
  const headingId = useId();
  const ticker = tickerOf(book.symbol);
  const settle = depositSettlement(book, props.round, Math.floor(props.nowMs / 1000));
  return (
    <Card as="article" padding="none" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 p-4 sm:p-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex h-10 min-w-10 shrink-0 items-center justify-center rounded-control border border-line bg-surface-2 px-2 text-[12px] font-semibold tracking-[0.02em] text-ink" aria-hidden>
            {ticker}
          </span>
          <div className="min-w-0">
            <h3 id={headingId} className="truncate text-[16px] font-semibold tracking-[-0.01em] text-ink">
              <Link to={`/books/${book.bookId}`} className="hover:underline">
                {book.name ?? `${ticker} book`}
              </Link>
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-ink-2">
              <span>{venueLabel(book.venue)}</span>
              <StateChip meta={bookState(book.state)} />
            </div>
          </div>
        </div>
        <div className="text-left sm:text-right">
          <div className="num text-[20px] leading-7 font-medium tracking-[-0.01em] text-ink">{usd(holding.value)}</div>
          <div className="text-[11.5px] text-muted">{book.lastMark ? `at the mark ending ${fmtWhen(book.lastMark.periodEnd)}` : "no mark yet"}</div>
        </div>
      </div>
      <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2 sm:px-5 sm:pb-5">
        {holding.tranches.map((t) => (
          <TrancheTile key={t.tranche} t={t} settle={settle} onRedeem={() => props.onRedeem(t.tranche)} />
        ))}
      </div>
      <Redemptions holding={holding} nowMs={props.nowMs} />
      <div className="flex flex-wrap items-center gap-2 rounded-b-card border-t border-line bg-surface-2/50 px-4 py-3 sm:px-5">
        {holding.canClaim && (
          <button type="button" className="btn btn-primary btn-sm" onClick={props.onClaim}>
            Claim
            <span className="sr-only"> from the {ticker} book</span>
          </button>
        )}
        <Link className="btn btn-sm" to={`/books/${book.bookId}`}>
          Book details
          <IconArrowRight size={14} />
        </Link>
        {holding.source === "db" && <span className="text-[11.5px] text-muted">Chain state unavailable: showing indexed data only.</span>}
      </div>
    </Card>
  );
}
