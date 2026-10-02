import { useState } from "react";
import { Link, useParams } from "react-router";
import { useNow, useQueryError } from "../../api/hooks";
import { POLL, trpc } from "../../api/trpc";
import { CharterTerms } from "../../components/CharterTerms";
import { Chip, EmptyState, ErrorState, Hash, KV, PageHeader, Panel, SkeletonRows, Stat, StateChip } from "../../components/ui";
import type { BookDetail, MarkItem } from "../../lib/api-types";
import { AGENTS_LINE, LIVE_VS_MARKED, venueDetail, venueLabel } from "../../lib/copy";
import { describeError } from "../../lib/errors";
import { DASH, ageMs, fmtAge, fmtBps, fmtDuration, fmtSharePrice, fmtUsd, tickerOf, usdRaw } from "../../lib/format";
import { bookState, limitState } from "../../lib/limits";
import { cadenceTitle, markCadenceLine, nextMarkLabel } from "../../lib/lowgas";
import { parseMarkStatement } from "../../lib/markStatement";
import { ActivityPanel } from "./ActivityPanel";
import { AllocatePanel } from "./AllocatePanel";
import { DistributionPanel } from "./DistributionPanel";
import { InvestPanel } from "./InvestPanel";
import { LimitsPanel } from "./LimitsPanel";
import { LossOrderPanel } from "./LossOrderPanel";
import { MarkCadencePanel } from "./MarkCadencePanel";
import { MarksPanel, useBookMarks } from "./MarksPanel";
import { NavPanel } from "./NavPanel";
import { QuotePanel } from "./QuotePanel";
import { VerifyPanel } from "./VerifyPanel";

function Kpis({ b, now }: { b: BookDetail; now: number }) {
  const markAge = ageMs(b.lastMark?.committedAt ?? null, now);
  const live = b.liveNav?.navUsd ?? null;
  const marked = usdRaw(b.navUsd);
  const liveRaw = usdRaw(live);
  const delta = marked !== null && liveRaw !== null ? liveRaw - marked : null;
  const liveAge = ageMs(b.liveNav?.ts ?? null, now);
  return (
    <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-4 rounded-card border border-line bg-surface shadow-card p-3 sm:p-4 lg:grid-cols-5">
      <Stat
        label="NAV"
        kind="marked"
        value={fmtUsd(b.navUsd, { symbol: true })}
        sub={b.lastMark ? `mark #${b.lastMark.markId} · ${markAge === null ? DASH : `${fmtAge(markAge)} ago`}` : "before the first mark"}
      />
      <Stat
        label="NAV"
        kind="live"
        value={live ? fmtUsd(live, { symbol: true }) : DASH}
        sub={live ? `${delta !== null ? `${fmtUsd(delta, { signed: true })} vs mark · ` : ""}${liveAge === null ? "" : `${fmtAge(liveAge)} ago`}` : "no live estimate"}
        title="Intra-period estimate from the risk / mark services"
      />
      <Stat label="Senior / share" kind="marked" value={fmtSharePrice(b.seniorSharePrice)} sub={`Senior NAV ${fmtUsd(b.seniorNavUsd, { compact: true })}`} />
      <Stat label="Junior / share" kind="marked" value={fmtSharePrice(b.juniorSharePrice)} sub={`Junior NAV ${fmtUsd(b.juniorNavUsd, { compact: true })}`} />
      <Stat
        label="Drawdown"
        value={b.limits ? fmtBps(b.limits.drawdownBps) : DASH}
        sub={b.mandate ? `kill at ${fmtBps(b.mandate.killAtDrawdownBps)}` : "mandate unknown"}
        className="col-span-2 lg:col-span-1"
      />
    </div>
  );
}

function Header({ b, now }: { b: BookDetail; now: number }) {
  const hbAge = ageMs(b.agent.heartbeatAt, now);
  const endsIn = b.state === "Subscription" && b.subscriptionEnds ? Date.parse(b.subscriptionEnds) - now : null;
  return (
    <PageHeader
      eyebrow={
        <Link to="/books" className="hover:text-ink">
          Books / #{b.bookId}
        </Link>
      }
      title={
        <span className="flex flex-wrap items-baseline gap-x-3">
          <span>{tickerOf(b.symbol)}</span>
          <span className="num text-[13px] font-normal text-ink-2">{b.symbol}</span>
        </span>
      }
      sub={b.name && b.name.toUpperCase() !== tickerOf(b.symbol) ? b.name : undefined}
    >
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <StateChip meta={bookState(b.state)} />
        <StateChip meta={limitState(b.limits?.state)} solid={b.limits?.state === "killed"} />
        <Chip tone="neutral" title={venueDetail(b.venue)}>
          {venueLabel(b.venue)}
        </Chip>
        <Chip tone={b.agent.alive ? "good" : "neutral"} title={AGENTS_LINE}>
          {b.agent.alive ? `Agent quoting · ${hbAge === null ? "" : `${fmtAge(hbAge)} ago`}` : "Agent offline"}
        </Chip>
        {endsIn !== null && <Chip tone="accent">{endsIn > 0 ? `Window closes in ${fmtDuration(Math.ceil(endsIn / 1000))}` : "Window closed; awaiting settlement"}</Chip>}
        {(b.state === "Live" || b.state === "Retiring") && (
          <Chip tone="neutral" title={markCadenceLine(b.markSchedule.cadence, b.markSchedule.intervalSeconds)}>
            {`${cadenceTitle(b.markSchedule.cadence)} · next ${nextMarkLabel(b.markSchedule, now)}`}
          </Chip>
        )}
        {b.source === "db" && <Chip tone="neutral" title="Chain reads unavailable; showing indexed data">Indexed data</Chip>}
      </div>
    </PageHeader>
  );
}

export function BookDetailPage() {
  const { bookId: raw } = useParams();
  const bookId = Number(raw);
  const valid = Number.isInteger(bookId) && bookId > 0;
  const q = trpc.book.get.useQuery({ bookId: valid ? bookId : 1 }, { enabled: valid, refetchInterval: POLL.live });
  const marks = useBookMarks(valid ? bookId : 1);
  const now = useNow(1_000);
  const [mark, setMark] = useState<MarkItem | null>(null);
  const [receiptId, setReceiptId] = useState<number | null>(null);
  const error = useQueryError(q);

  const goVerify = () => document.getElementById("verify")?.scrollIntoView({ behavior: "smooth", block: "start" });

  if (!valid) return <EmptyState title="Unknown book" body="Book ids are positive integers." />;
  if (!q.data) {
    if (error) {
      const f = describeError(error);
      return (
        <>
          <PageHeader eyebrow={<Link to="/books">Books / #{bookId}</Link>} title={f.kind === "not_found" ? "Book not found" : `Book #${bookId}`} />
          {f.kind === "not_found" ? (
            <EmptyState
              title={`There is no book #${bookId}`}
              body="Books are created when the committee approves a charter; the book id equals the charter id."
              action={
                <Link className="btn" to={`/charters/${bookId}`}>
                  Look up charter #{bookId}
                </Link>
              }
            />
          ) : (
            <ErrorState error={error} onRetry={() => q.refetch()} />
          )}
        </>
      );
    }
    return <SkeletonRows rows={8} />;
  }

  const b = q.data;
  const lastMark = marks.data?.items[0];
  const lastStatement = lastMark ? parseMarkStatement(lastMark) : null;
  return (
    <>
      <Header b={b} now={now} />
      {b.killed && (
        <div className="mb-4 rounded-card border border-critical bg-critical/8 p-3 text-[12.5px]" role="alert">
          <span className="font-semibold">Mandate killed.</span> Quoting stopped, venue key and desk keys revoked, reduce-only flattening within mandate. The risk committee may re-mandate the
          book. Redemption requests and claims are never blocked by a kill.
        </div>
      )}
      {q.error && <div className="mb-2 text-[11px] text-muted">Showing the last data received; {describeError(q.error).title.toLowerCase()}.</div>}
      <InvestPanel book={b} now={now} />
      <Kpis b={b} now={now} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          <NavPanel bookId={b.bookId} />
          <div className="grid gap-4 lg:grid-cols-2">
            <QuotePanel quote={b.quote} mandate={b.mandate} now={now} agentAlive={b.agent.alive} killed={b.killed} />
            <LimitsPanel bookId={b.bookId} limits={b.limits} mandate={b.mandate} now={now} lastStatement={lastStatement} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <DistributionPanel bookId={b.bookId} />
            <LossOrderPanel seniorNavUsd={b.seniorNavUsd} juniorNavUsd={b.juniorNavUsd} killAtDrawdownBps={b.mandate?.killAtDrawdownBps ?? null} />
          </div>
          <ActivityPanel
            bookId={b.bookId}
            marks={marks.data?.items ?? []}
            onVerify={(id) => {
              setReceiptId(id);
              goVerify();
            }}
          />
          <MarksPanel
            bookId={b.bookId}
            selected={mark?.markId ?? null}
            onSelect={(m) => {
              setMark(m);
              goVerify();
            }}
          />
          <VerifyPanel bookId={b.bookId} mark={mark} marks={marks.data?.items ?? []} receiptId={receiptId} onReceipt={setReceiptId} />
        </div>
        <aside className="min-w-0 space-y-4">
          <AllocatePanel bookId={b.bookId} state={b.state} juniorNoticeSeconds={b.charter?.juniorNoticeSeconds ?? null} subscriptionEnds={b.subscriptionEnds} />
          <MarkCadencePanel b={b} now={now} />
          <Panel title="Charter terms" meta={b.charterStatus ? `charter #${b.charterId} · ${b.charterStatus}` : undefined}>
            {b.charter ? <CharterTerms c={b.charter} stacked /> : <EmptyState compact title="Charter not indexed yet" />}
            <Link className="link mt-3 inline-block text-[12px]" to={`/charters/${b.charterId}`}>
              Charter #{b.charterId}: jury verdict and committee votes
            </Link>
          </Panel>
          <Panel title="Contracts">
            <KV rows={Object.entries(b.components).map(([k, v]) => [k, <Hash key={k} value={v} kind="address" />])} />
            <p className="mt-2 text-[11px] text-muted">{LIVE_VS_MARKED}</p>
          </Panel>
        </aside>
      </div>
    </>
  );
}
