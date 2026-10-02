// Launch books: one card per listed book (NVDA, TSLA, RHX5 on testnet) with what the market is, its
// venue and state, the marked NAV and share prices, the Senior / Junior split and whether it takes
// deposits right now (top-up round read on-chain, with the amount committed so far).
import { Link } from "react-router";
import { useNow, useQueryError } from "../../api/hooks";
import { POLL, trpc } from "../../api/trpc";
import { formatAmountDisplay } from "../../lib/amount";
import type { BookListItem } from "../../lib/api-types";
import { LIVE_VS_MARKED, venueDetail, venueLabel } from "../../lib/copy";
import { fmtSharePrice, fmtUsd, usdRaw } from "../../lib/format";
import { ageOf } from "../../lib/lowgas";
import { bookState, limitState } from "../../lib/limits";
import { SERIES_CLASS } from "../../lib/palette";
import { type TopUpRound, isTopUpOpen, useTopUpRounds } from "../../wallet/topUp";
import { cx } from "../cx";
import { IconArrowRight } from "../icons";
import { Badge, Card, EmptyState, ErrorState, ProgressBar, Section, Skeleton, Stat, StateChip } from "../ui";
import { type RoundCommitted, useRoundCommitments } from "./chainReads";
import { type DepositStatus, depositHeadline, depositOpen, depositStatus, fmtDayUtc, marketInfo, roundFill, sharePct, trancheSplit } from "./model";

const MAX_CARDS = 6;

export function LaunchBooks() {
  const q = trpc.book.list.useQuery(undefined, { refetchInterval: POLL.list });
  const error = useQueryError(q);
  const rounds = useTopUpRounds();
  const now = useNow(15_000);
  const nowSec = Math.floor(now / 1000);
  const books = [...(q.data ?? [])].sort((a, b) => a.bookId - b.bookId).slice(0, MAX_CARDS);
  const roundOf = (id: number): TopUpRound | null | undefined => (rounds.data ? (rounds.data[id] ?? null) : rounds.isError ? null : undefined);
  const openIds = books.filter((b) => isTopUpOpen(roundOf(b.bookId), nowSec)).map((b) => b.bookId);
  const committed = useRoundCommitments(openIds);

  return (
    <Section
      id="books"
      eyebrow="Launch books"
      title="The books you can fund"
      lead="Each book is one market with its own NAV, mandate and two tranches. Figures come from the latest signed mark, read live."
      actions={
        <>
          <Link to="/books" className="btn">
            All books
          </Link>
          <Link to="/invest" className="btn btn-primary">
            Compare and invest
            <IconArrowRight size={14} />
          </Link>
        </>
      }
    >
      {q.data === undefined ? (
        error ? (
          <ErrorState error={error} onRetry={() => void q.refetch()} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading books">
            {[0, 1, 2].map((i) => (
              <Card key={i} padding="lg">
                <Skeleton className="h-7 w-24" />
                <Skeleton className="mt-3 h-4 w-full" />
                <Skeleton className="mt-2 h-4 w-3/4" />
                <Skeleton className="mt-6 h-16 w-full" />
                <Skeleton className="mt-4 h-10 w-full" />
              </Card>
            ))}
          </div>
        )
      ) : books.length === 0 ? (
        <EmptyState
          title="No books are listed yet"
          body="A book exists once the Risk Committee approves its charter. Approved books appear here within seconds."
          action={
            <Link to="/charters" className="btn btn-sm">
              See the charters
            </Link>
          }
        />
      ) : (
        <>
          <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {books.map((b) => (
              <BookCard key={b.bookId} b={b} deposit={depositStatus(b, roundOf(b.bookId), nowSec)} committed={committed.data?.[b.bookId] ?? null} now={now} />
            ))}
          </ul>
          <p className="mt-5 max-w-3xl text-[12.5px] text-ink-2">{LIVE_VS_MARKED}</p>
        </>
      )}
    </Section>
  );
}

function BookCard({ b, deposit, committed, now }: { b: BookListItem; deposit: DepositStatus; committed: RoundCommitted | null; now: number }) {
  const m = marketInfo(b.symbol);
  const split = trancheSplit(usdRaw(b.seniorNavUsd) ?? 0n, usdRaw(b.juniorNavUsd) ?? 0n);
  const limits = limitState(b.limits?.state);
  return (
    <Card as="li" padding="none" className="flex flex-col overflow-hidden">
      <div className="flex-1 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[22px] leading-7 font-semibold tracking-[-0.02em] text-ink">{m.ticker}</h3>
            <div className="text-[13px] text-ink-2">{m.name}</div>
          </div>
          <StateChip meta={bookState(b.state)} />
        </div>
        <p className="mt-3 text-[13.5px] leading-relaxed text-ink-2">{m.blurb}</p>
        {m.components && (
          <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Index components">
            {m.components.map((c) => (
              <li key={c}>
                <Badge size="sm">{c} 20%</Badge>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-2">
          <Badge tone="neutral" size="sm">
            {venueLabel(b.venue)}
          </Badge>
          <span>{venueDetail(b.venue)}</span>
        </div>
      </div>

      <div className="border-t border-line px-5 py-4">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="NAV" sub="at the last mark" title="Marked NAV: the signed mark committed on-chain" value={fmtUsd(b.navUsd, { symbol: true, compact: true })} />
          <Stat label="Senior" sub="per share" series="senior" title="Senior NAV per share at the last mark" value={fmtSharePrice(b.seniorSharePrice, 4)} />
          <Stat label="Junior" sub="per share" series="junior" title="Junior NAV per share at the last mark" value={fmtSharePrice(b.juniorSharePrice, 4)} />
        </div>
        {split && (
          <div className="mt-4">
            <div className="flex h-2 overflow-hidden rounded-full bg-surface-3" role="img" aria-label={`Senior ${sharePct(split.senior)} and Junior ${sharePct(split.junior)} of the book's NAV`}>
              <span className={SERIES_CLASS.senior.bg} style={{ width: `${split.senior * 100}%` }} />
              <span className={cx(SERIES_CLASS.junior.bg, "border-l-2 border-surface")} style={{ width: `${split.junior * 100}%` }} />
            </div>
            <div className="mt-1.5 flex justify-between text-[12px] text-ink-2">
              <span>
                <span className={cx("font-medium", SERIES_CLASS.senior.text)}>Senior</span> {sharePct(split.senior)}
              </span>
              <span>
                <span className={cx("font-medium", SERIES_CLASS.junior.text)}>Junior</span> {sharePct(split.junior)}
              </span>
            </div>
          </div>
        )}
      </div>

      <DepositRow deposit={deposit} committed={committed} />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
        <div className="flex min-w-0 flex-col gap-1">
          <StateChip meta={limits} />
          <span className="num text-[11.5px] text-ink-2">Marked {ageOf(b.lastMark?.committedAt ?? null, now)}</span>
        </div>
        <Link to={`/books/${b.bookId}`} className="btn btn-sm" aria-label={`Open the ${m.ticker} book`}>
          Open book
          <IconArrowRight size={14} />
        </Link>
      </div>
    </Card>
  );
}

function DepositRow({ deposit, committed }: { deposit: DepositStatus; committed: RoundCommitted | null }) {
  const open = depositOpen(deposit);
  return (
    <div className="border-t border-line bg-surface-2/50 px-5 py-4">
      <div className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
        <span className={cx("size-2 shrink-0 rounded-full", open ? "bg-good" : deposit.kind === "checking" ? "bg-muted" : "bg-line-strong")} aria-hidden />
        {depositHeadline(deposit)}
      </div>
      {deposit.kind === "topup" && (
        <>
          <div className="mt-3 space-y-2.5">
            <TrancheRound tranche="senior" capacity={deposit.seniorCapacity} committed={committed?.senior ?? null} />
            <TrancheRound tranche="junior" capacity={deposit.juniorCapacity} committed={committed?.junior ?? null} />
          </div>
          <p className="mt-3 text-[12px] text-ink-2">Deposits wait in escrow. Shares are issued at the first mark after {fmtDayUtc(deposit.endsAt)}, at that mark's share price.</p>
        </>
      )}
      {deposit.kind === "window" && <p className="mt-1.5 text-[12px] text-ink-2">Commitments are allocated pro-rata when the window closes; any excess is refunded.</p>}
      {deposit.kind === "closed" && deposit.reason === "no-round" && <p className="mt-1.5 text-[12px] text-ink-2">The sponsor opens top-up rounds from time to time. Redemption requests are accepted at any time.</p>}
    </div>
  );
}

function TrancheRound({ tranche, capacity, committed }: { tranche: "senior" | "junior"; capacity: bigint; committed: bigint | null }) {
  const name = tranche === "senior" ? "Senior" : "Junior";
  if (capacity === 0n) {
    return (
      <div className="text-[12.5px] text-ink-2">
        <span className={cx("font-medium", SERIES_CLASS[tranche].text)}>{name}</span>: not open in this round
      </div>
    );
  }
  const fill = committed === null ? null : roundFill(committed, capacity);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
        <span className={cx("font-medium", SERIES_CLASS[tranche].text)}>{name}</span>
        <span className="num text-ink-2">
          {committed === null ? `${formatAmountDisplay(capacity, 6, 0)} USDC capacity` : `${formatAmountDisplay(committed, 6, 0)} of ${formatAmountDisplay(capacity, 6, 0)} USDC`}
        </span>
      </div>
      <ProgressBar className="mt-1.5" tone={tranche} value={fill?.frac ?? 0} label={`${name} capacity committed`} />
      {fill?.over && <div className="mt-1 text-[11.5px] text-ink-2">Oversubscribed: deposits are filled pro-rata and the rest is refunded.</div>}
    </div>
  );
}
