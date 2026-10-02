import { Link, useNavigate } from "react-router";
import { useNow } from "../api/hooks";
import { POLL, trpc } from "../api/trpc";
import { EmptyState, PageHeader, Panel, QueryView, Stat, StateChip, Table, Td, Th, ValueKind } from "../components/ui";
import type { BookListItem } from "../lib/api-types";
import { config } from "../lib/config";
import { AGENTS_LINE, LIVE_VS_MARKED, STRAPLINE, venueDetail, venueLabel } from "../lib/copy";
import { DASH, ageMs, fmtAgo, fmtSharePrice, fmtUsd, tickerOf, usdRaw } from "../lib/format";
import { bookState, limitState } from "../lib/limits";
import { markCadenceLine, nextMarkAt, nextMarkLabel } from "../lib/lowgas";
import { isTestChain } from "../wallet/network";

const isMarkable = (b: BookListItem) => b.state === "Live" || b.state === "Retiring";

function markAge(b: BookListItem, now: number) {
  const age = ageMs(b.lastMark?.committedAt ?? null, now);
  return age === null ? "No mark yet" : `${fmtAgo(age)}`;
}

function totals(books: BookListItem[]) {
  let nav = 0n;
  for (const b of books) nav += usdRaw(b.navUsd) ?? 0n;
  return {
    nav,
    live: books.filter((b) => b.state === "Live").length,
    open: books.filter((b) => b.state === "Subscription").length,
    alerts: books.filter((b) => ["breach", "killed"].includes(b.limits?.state ?? "")).length,
  };
}

function BookCard({ b, now }: { b: BookListItem; now: number }) {
  return (
    <Link to={`/books/${b.bookId}`} className="block rounded-card border border-line bg-surface shadow-card p-3 hover:border-line-strong">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold">{tickerOf(b.symbol)}</div>
          <div className="truncate text-[11.5px] text-muted">
            #{b.bookId} · {b.symbol} · {venueLabel(b.venue)}
          </div>
        </div>
        <StateChip meta={bookState(b.state)} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Stat label="NAV" value={fmtUsd(b.navUsd, { compact: true })} title="Marked NAV (signed mark)" />
        <Stat label="Senior / sh" value={fmtSharePrice(b.seniorSharePrice, 4)} />
        <Stat label="Junior / sh" value={fmtSharePrice(b.juniorSharePrice, 4)} />
      </div>
      <div className="mt-2 flex items-center justify-between text-[11.5px] text-muted">
        <StateChip meta={limitState(b.limits?.state)} />
        <span className="num">
          {markAge(b, now)}
          {isMarkable(b) ? ` · next ${nextMarkLabel(b.markSchedule, now)}` : ""}
        </span>
      </div>
    </Link>
  );
}

export function BooksPage() {
  const q = trpc.book.list.useQuery(undefined, { refetchInterval: POLL.list });
  const now = useNow(1_000);
  const nav = useNavigate();
  const t = q.data ? totals(q.data) : null;

  return (
    <>
      <PageHeader
        eyebrow="Syndicate desk"
        title="Books"
        sub={`${STRAPLINE} Each book is a perp market underwritten by a Senior and a Junior tranche. ${AGENTS_LINE}`}
        actions={
          <Link to="/charters/new" className="btn btn-primary">
            File a charter
          </Link>
        }
      />
      {t && (
        <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-card border border-line bg-surface shadow-card p-3 sm:grid-cols-4 sm:p-4">
          <Stat label="Books" value={q.data?.length ?? 0} sub={`${t.live} live · ${t.open} in subscription`} />
          <Stat label="Marked NAV" value={fmtUsd(t.nav, { symbol: true, compact: true })} sub="sum of last marks" kind="marked" />
          <Stat label="Limit alerts" value={t.alerts} sub="books in breach or killed" />
          <Stat label="Updated" value={q.dataUpdatedAt ? `${fmtAgo(now - q.dataUpdatedAt)}` : DASH} sub={`polling every ${POLL.list / 1000}s`} />
        </div>
      )}
      <Panel title="All books" meta={q.data ? `${q.data.length} book${q.data.length === 1 ? "" : "s"}` : undefined} bodyClassName="p-0">
        <div className="p-2 sm:p-5">
          <QueryView
            q={q}
            empty={(d) => d.length === 0}
            emptyView={
              <EmptyState
                title="No books yet"
                body={
                  config.chain.kind === "devnet"
                    ? "A book exists once its charter is approved by the risk committee. On devnet, deploy the contracts and launch the three studio books (bun run deploy:local, then bun run launch); they appear here within seconds."
                    : `A book exists once its charter is approved by the risk committee. Books on ${config.chain.name} appear here as soon as the indexer sees them.`
                }
                action={
                  <Link to="/charters" className="btn">
                    View charters
                  </Link>
                }
              />
            }
          >
            {(books) => (
              <>
                <div className="space-y-2 md:hidden">
                  {books.map((b) => (
                    <BookCard key={b.bookId} b={b} now={now} />
                  ))}
                </div>
                <div className="hidden md:block">
                  <Table minWidth={980}>
                    <thead>
                      <tr>
                        <Th>Book</Th>
                        <Th>Venue</Th>
                        <Th>State</Th>
                        <Th right>NAV (USD)</Th>
                        <Th right title="Senior NAV per share at the last mark">
                          Senior NAV / sh
                        </Th>
                        <Th right title="Junior NAV per share at the last mark">
                          Junior NAV / sh
                        </Th>
                        <Th>Limits</Th>
                        <Th right>Last mark</Th>
                        <Th right title="One signed mark transaction per book per period">
                          Next mark
                        </Th>
                      </tr>
                    </thead>
                    <tbody>
                      {books.map((b) => (
                        <tr
                          key={b.bookId}
                          className="cursor-pointer hover:bg-surface-2"
                          onClick={() => nav(`/books/${b.bookId}`)}
                          onKeyDown={(e) => e.key === "Enter" && nav(`/books/${b.bookId}`)}
                          tabIndex={0}
                        >
                          <Td>
                            <Link to={`/books/${b.bookId}`} className="flex items-baseline gap-2" onClick={(e) => e.stopPropagation()}>
                              <span className="text-[13.5px] font-semibold">{tickerOf(b.symbol)}</span>
                              <span className="num text-[11px] text-muted">
                                #{b.bookId} {b.symbol}
                              </span>
                            </Link>
                            {b.name && b.name.toUpperCase() !== tickerOf(b.symbol) && <div className="max-w-[260px] truncate text-[11px] text-ink-2">{b.name}</div>}
                          </Td>
                          <Td title={venueDetail(b.venue, isTestChain)}>{venueLabel(b.venue)}</Td>
                          <Td>
                            <StateChip meta={bookState(b.state)} />
                          </Td>
                          <Td right num>
                            <div className="text-[13px]">{fmtUsd(b.navUsd)}</div>
                            {b.liveNav?.navUsd ? (
                              <div className="flex items-center justify-end gap-1 text-[11px] text-muted">
                                <ValueKind kind="live" compact /> {fmtUsd(b.liveNav.navUsd)}
                              </div>
                            ) : null}
                          </Td>
                          <Td right num>
                            {fmtSharePrice(b.seniorSharePrice)}
                          </Td>
                          <Td right num>
                            {fmtSharePrice(b.juniorSharePrice)}
                          </Td>
                          <Td>
                            <StateChip meta={limitState(b.limits?.state)} />
                          </Td>
                          <Td right num className="text-ink-2">
                            {markAge(b, now)}
                          </Td>
                          <Td right num className="text-ink-2" title={nextMarkAt(b.markSchedule)}>
                            <div>{isMarkable(b) ? nextMarkLabel(b.markSchedule, now) : DASH}</div>
                            <div className="text-[11px] text-muted">{b.markSchedule.cadence}</div>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </>
            )}
          </QueryView>
        </div>
      </Panel>
      <p className="mt-3 max-w-4xl text-[11.5px] text-muted">{LIVE_VS_MARKED}</p>
      {q.data?.[0] && <p className="mt-1 max-w-4xl text-[11.5px] text-muted">{markCadenceLine(q.data[0].markSchedule.cadence, q.data[0].markSchedule.intervalSeconds)}</p>}
    </>
  );
}
