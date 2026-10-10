// One book on the Invest page: state, latest marked NAV, Senior / Junior share prices, the deposit
// round (open until …, room left per tranche from Book.topUp() and each tranche's committed total),
// the charter terms that differ between books (fee-flow split, Senior cap, Junior notice, per-wallet
// cap) and the way into the book's invest panel.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { POLL, trpc } from "../../api/trpc";
import { USDC_DECIMALS, formatAmountDisplay } from "../../lib/amount";
import type { BookListItem } from "../../lib/api-types";
import { venueLabel } from "../../lib/copy";
import { DASH, ageMs, fmtAgo, fmtDuration, fmtSharePrice, fmtUsd, fmtWhen, isoToSec, tickerOf, usdRaw } from "../../lib/format";
import { bookState } from "../../lib/limits";
import type { TopUpRound } from "../../lib/topup";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { IconArrowRight } from "../icons";
import { Card, ProgressBar, Stat, StateChip, Term, cx } from "../ui";
import { TrancheSwatch, WindowBadge } from "./InvestBits";
import { perWalletCapText, roomFigure, roomNote } from "./investCopy";
import { TRANCHE_IDS, TRANCHE_NAME, type TrancheId, type TrancheRoom, bookRooms, depositWindow, distributionShares, pctOfBps } from "./logic";
import type { BookRounds } from "./useInvestChain";

export function BookInvestCard(props: {
  item: BookListItem;
  topUp: TopUpRound | null | undefined;
  rounds: BookRounds | undefined;
  guardianPaused: boolean | null;
  now: number;
}) {
  const b = props.item;
  const sym = useSettlementSymbol();
  const ticker = tickerOf(b.symbol);
  const nowSec = Math.floor(props.now / 1000);
  const detail = trpc.book.get.useQuery({ bookId: b.bookId }, { refetchInterval: POLL.slow, staleTime: 15_000 });
  const d = detail.data;
  const state = d?.state ?? b.state;
  const c = d?.charter ?? null;
  const topUp = state === "Live" ? props.topUp : null;
  const w = depositWindow({
    state,
    subscriptionEndsSec: isoToSec(d?.subscriptionEnds ?? b.subscriptionEnds),
    topUp,
    nowSec,
    markIntervalSec: b.markSchedule.intervalSeconds,
    guardianPaused: props.guardianPaused,
  });
  const rooms = bookRooms({
    topUp,
    committed: { senior: props.rounds?.senior.totalCommitted, junior: props.rounds?.junior.totalCommitted },
    seniorNav: usdRaw(d?.seniorNavUsd ?? b.seniorNavUsd),
    juniorNav: usdRaw(d?.juniorNavUsd ?? b.juniorNavUsd),
    capBps: c?.seniorCapBps,
  });
  const markAge = ageMs(b.lastMark?.committedAt ?? null, props.now);
  const split = c ? distributionShares(c.seniorHurdleBps) : null;
  const cap = usdRaw(c?.perWalletCapUsd ?? null);
  const kind = c?.underlyingKind === "index" ? "Index perp" : "Stock perp";
  const href = `/books/${b.bookId}`;

  return (
    <Card as="article" padding="none" className="overflow-hidden" aria-label={`${ticker} book`}>
      <div className="p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-card bg-accent-soft text-[14px] font-semibold tracking-[-0.02em] text-accent-text" aria-hidden>
              {ticker.slice(0, 2)}
            </span>
            <div className="min-w-0">
              <h3 className="text-[19px] font-semibold tracking-[-0.02em]">
                <Link to={`${href}#invest`} className="hover:underline">
                  {ticker}
                </Link>
              </h3>
              <div className="truncate text-[12.5px] text-ink-2">
                {kind} · {venueLabel(b.venue)} · <span className="num">{b.symbol}</span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StateChip meta={bookState(state)} />
            <WindowBadge w={w} nowSec={nowSec} />
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
          <Stat
            label="Book NAV"
            term="nav"
            kind="marked"
            value={fmtUsd(b.navUsd, { symbol: true, dp: 0 })}
            sub={b.lastMark ? `mark #${b.lastMark.markId} · ${markAge === null ? DASH : `${fmtAgo(markAge)}`}` : "before the first mark"}
            className="col-span-2 sm:col-span-1"
          />
          <Stat label="Senior share price" series="senior" value={fmtSharePrice(d?.seniorSharePrice ?? b.seniorSharePrice, 4)} sub={`${sym} per share`} />
          <Stat label="Junior share price" series="junior" value={fmtSharePrice(d?.juniorSharePrice ?? b.juniorSharePrice, 4)} sub={`${sym} per share`} />
        </div>

        <div className="mt-5 rounded-card border border-line bg-surface-2/50 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <div className="text-[13.5px] font-semibold">
              <Term id={w.status !== "loading" && w.status !== "closed" && w.kind === "subscription" ? "subscriptionWindow" : "topUpRound"}>
                {w.status !== "loading" && w.status !== "closed" && w.kind === "subscription" ? "Subscription window" : "Deposit round"}
              </Term>
            </div>
            <div className="text-[12.5px] text-ink-2">
              {w.status === "open"
                ? `Open until ${fmtWhen(w.endsAt)} · ${fmtDuration(w.endsAt - nowSec)} left`
                : w.status === "settling"
                  ? `Ended; settles at the mark of ${fmtWhen(w.settlesAt)}`
                  : w.status === "paused"
                    ? "Paused by the guardian"
                    : w.status === "loading"
                      ? "Checking…"
                      : "No round open right now"}
            </div>
          </div>
          {topUp && (w.status === "open" || w.status === "paused") && (
            <ul className="mt-3 space-y-3">
              {TRANCHE_IDS.map((t) => (
                <RoomRow
                  key={t}
                  t={t}
                  ticker={ticker}
                  capacity={t === "senior" ? topUp.seniorCapacityUsd : topUp.juniorCapacityUsd}
                  room={rooms[t]}
                  capBps={c?.seniorCapBps ?? null}
                  paused={props.rounds?.[t].paused ?? null}
                  href={`${href}?tranche=${t}#invest`}
                />
              ))}
            </ul>
          )}
          {w.status === "open" && w.kind === "subscription" && (
            <p className="mt-2 text-[12.5px] text-ink-2">Commitments are allocated pro-rata when the window closes; shares start at 1.00 {sym} each.</p>
          )}
        </div>

        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-2">
          <Term2 label={<Term id="hurdle">Fee-flow split</Term>} value={split ? `${pctOfBps(split.senior)} Senior · ${pctOfBps(split.junior)} Junior` : DASH} />
          <Term2 label="Senior cap" value={c ? `${pctOfBps(c.seniorCapBps)} of the book` : DASH} />
          <Term2 label={<Term id="redemptionNotice">Junior notice</Term>} value={c ? fmtDuration(c.juniorNoticeSeconds) : DASH} />
          <Term2 label="Per-wallet cap" value={perWalletCapText(cap, topUp && (w.status === "open" || w.status === "paused") ? (topUp.seniorCapacityUsd > topUp.juniorCapacityUsd ? topUp.seniorCapacityUsd : topUp.juniorCapacityUsd) : null)} />
        </dl>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-2/40 px-4 py-3 sm:px-6">
        <span className="text-[12.5px] text-muted">
          {b.markSchedule.cadence === "hourly" ? "Marked every hour" : b.markSchedule.cadence === "daily" ? "Marked every day" : `Marked ${b.markSchedule.cadence}`}
        </span>
        <Link to={`${href}#invest`} className={cx("btn btn-sm", w.status === "open" ? "btn-primary" : "btn-secondary")}>
          {w.status === "open" ? `Invest in ${ticker}` : `View ${ticker}`}
          <IconArrowRight size={14} />
        </Link>
      </div>
    </Card>
  );
}

function Term2(props: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line pb-1.5 sm:block sm:border-0 sm:pb-0">
      <dt className="text-ink-2">{props.label}</dt>
      <dd className="tnum text-right font-medium text-ink sm:mt-0.5 sm:text-left">{props.value}</dd>
    </div>
  );
}

function RoomRow(props: { t: TrancheId; ticker: string; capacity: bigint; room: TrancheRoom | null; capBps: number | null; paused: boolean | null; href: string }) {
  const { capacity, room } = props;
  const sym = useSettlementSymbol();
  const name = TRANCHE_NAME[props.t];
  const note = room && !props.paused ? roomNote(room, props.capBps) : null;
  return (
    // Phone: name + Choose on one line, then the bar, then the figures. sm+: one row.
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[6rem_minmax(0,1fr)_auto_auto]">
      <span className="inline-flex items-center gap-2 text-[13px] font-medium sm:order-1">
        <TrancheSwatch t={props.t} />
        {name}
      </span>
      <Link to={props.href} className="link justify-self-end text-[12.5px] sm:order-4" aria-label={`Choose ${props.ticker} ${name}`}>
        Choose
      </Link>
      <ProgressBar value={room?.filled ?? 0} tone={props.t} label={`${name} capacity committed`} className="col-span-2 sm:order-2 sm:col-span-1" />
      <span className="num col-span-2 text-[12.5px] text-ink-2 sm:order-3 sm:col-span-1 sm:text-right">
        {props.paused ? (
          <span className="text-warn-ink">Paused</span>
        ) : room ? (
          roomFigure(room)
        ) : (
          `${formatAmountDisplay(capacity, USDC_DECIMALS, 0)} ${sym} capacity`
        )}
      </span>
      {note && <span className={cx("col-span-2 text-[12px] sm:order-5 sm:col-span-4", room?.oversubscribed ? "text-warn-ink" : "text-ink-2")}>{note}</span>}
    </li>
  );
}
