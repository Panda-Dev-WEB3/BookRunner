import { Link } from "react-router";
import { useNow } from "../api/hooks";
import { POLL, trpc } from "../api/trpc";
import { Chip, EmptyState, Hash, PageHeader, Panel, QueryView, Stat, StateChip, Table, Td, Th, cx } from "../components/ui";
import type { BookListItem, KillItem } from "../lib/api-types";
import { DASH, ageMs, fmtAge, fmtBps, fmtDateTime, fmtPct, fmtUsdFloat, tickerOf } from "../lib/format";
import { LIMIT_STATES, breachText, limitState, utilMeter } from "../lib/limits";

function MiniMeter({ util }: { util: number | null | undefined }) {
  const m = utilMeter(util);
  const fill = { neutral: "bg-muted", accent: "bg-accent", good: "bg-good", warn: "bg-warn", serious: "bg-serious", critical: "bg-critical" }[m.tone];
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="num w-12 text-right">{fmtPct(util ?? null, 0)}</span>
      <span className="relative h-1.5 w-16 rounded-[1px] bg-surface-3">
        <span className={cx("absolute inset-y-0 left-0", fill)} style={{ width: `${m.fill * 100}%` }} />
        <span className="absolute -inset-y-0.5 w-px bg-ink/60" style={{ left: `${(1 / 1.25) * 100}%` }} />
      </span>
    </div>
  );
}

function KillLog({ books }: { books: BookListItem[] }) {
  const qs = trpc.useQueries((t) => books.map((b) => t.risk.state({ bookId: b.bookId }, { refetchInterval: POLL.list })));
  const kills: Array<KillItem & { bookId: number; symbol: string }> = [];
  qs.forEach((q, i) => {
    const b = books[i];
    if (b && q.data) for (const k of q.data.kills) kills.push({ ...k, bookId: b.bookId, symbol: b.symbol });
  });
  kills.sort((a, b) => b.ts.localeCompare(a.ts));
  const loading = qs.some((q) => q.isLoading);
  return (
    <Panel title="Kill log" meta={`${kills.length} kill${kills.length === 1 ? "" : "s"}`}>
      {kills.length === 0 ? (
        loading ? (
          <div className="text-[12px] text-muted">Loading kill history…</div>
        ) : (
          <EmptyState compact title="No kills recorded" body="A breach triggers cancel-all, flattening within mandate, revocation of the venue and desk keys, and a mandate kill. Each step is journaled here." />
        )
      ) : (
        <Table minWidth={760}>
          <thead>
            <tr>
              <Th>Time</Th>
              <Th>Book</Th>
              <Th>Reason</Th>
              <Th>Breaches</Th>
              <Th>Actions</Th>
              <Th>Txs</Th>
            </tr>
          </thead>
          <tbody>
            {kills.map((k) => (
              <tr key={`${k.bookId}-${k.id}`}>
                <Td num className="text-ink-2">
                  {fmtDateTime(k.ts)}
                </Td>
                <Td>
                  <Link className="link" to={`/books/${k.bookId}`}>
                    {tickerOf(k.symbol)} #{k.bookId}
                  </Link>
                </Td>
                <Td className="font-medium">{k.reason}</Td>
                <Td className="text-ink-2">{Array.isArray(k.breaches) ? (k.breaches as unknown[]).map(String).join(", ") : DASH}</Td>
                <Td className="text-ink-2">{Array.isArray(k.actions) ? (k.actions as unknown[]).map((a) => String(a).replace(/_/g, " ")).join(" → ") : DASH}</Td>
                <Td>
                  <div className="flex flex-col gap-0.5">
                    {(Array.isArray(k.txHashes) ? (k.txHashes as unknown[]).map(String) : []).slice(0, 4).map((h) => (
                      <Hash key={h} value={h} kind="tx" />
                    ))}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function RecentEvents() {
  const breached = trpc.events.recent.useQuery({ type: "limit.breached", limit: 20 }, { refetchInterval: POLL.list });
  const killed = trpc.events.recent.useQuery({ type: "kill.executed", limit: 20 }, { refetchInterval: POLL.list });
  const items = [...(breached.data?.items ?? []), ...(killed.data?.items ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 25);
  return (
    <Panel title="Breach and kill events" meta="domain events, also delivered as webhooks">
      {items.length === 0 ? (
        <EmptyState compact title="No breach or kill events" body="limit.breached and kill.executed events appear here as the risk service emits them." />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((e) => {
            const d = (e.data ?? {}) as { breaches?: unknown; reason?: unknown };
            return (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[12px]">
                <div className="flex items-center gap-2">
                  <Chip tone={e.type === "kill.executed" ? "critical" : "warn"}>{e.type}</Chip>
                  {e.bookId !== null && (
                    <Link className="link" to={`/books/${e.bookId}`}>
                      book #{e.bookId}
                    </Link>
                  )}
                  <span className="text-ink-2">{Array.isArray(d.breaches) ? d.breaches.map(String).map(breachText).join("; ") : typeof d.reason === "string" ? d.reason : ""}</span>
                </div>
                <span className="num text-[11px] text-muted">{fmtDateTime(e.createdAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function RiskPage() {
  const q = trpc.book.list.useQuery(undefined, { refetchInterval: POLL.live });
  const now = useNow(1_000);
  const counts = (q.data ?? []).reduce<Record<string, number>>((acc, b) => {
    const s = b.limits?.state ?? "unknown";
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <>
      <PageHeader
        eyebrow="Risk monitor"
        title="Risk"
        sub="Limit states of every book, refreshed every few seconds by the risk service: inventory against the mandate, quote skew and width, hedge band and drawdown against the kill threshold."
      />
      <div className="mb-4 grid grid-cols-3 gap-3 rounded-[3px] border border-line bg-surface p-3 sm:grid-cols-6 sm:p-4">
        {(["ok", "warn", "reduce_only", "breach", "killed", "unknown"] as const).map((s) => (
          <Stat key={s} label={LIMIT_STATES[s]?.label ?? s} value={counts[s] ?? 0} />
        ))}
      </div>
      <div className="space-y-4">
        <Panel title="Limit states" meta="live">
          <QueryView q={q} empty={(d) => d.length === 0} emptyView={<EmptyState compact title="No books to monitor" body="Books appear once charters are approved." />}>
            {(books) => (
              <Table minWidth={960}>
                <thead>
                  <tr>
                    <Th>Book</Th>
                    <Th>State</Th>
                    <Th right>Inventory</Th>
                    <Th right>Skew</Th>
                    <Th right>Hedge ratio</Th>
                    <Th right>Drawdown</Th>
                    <Th right>Net exposure</Th>
                    <Th>Session</Th>
                    <Th>Breaches</Th>
                    <Th right>Updated</Th>
                  </tr>
                </thead>
                <tbody>
                  {books.map((b) => {
                    const l = b.limits;
                    const age = ageMs(l?.ts ?? null, now);
                    return (
                      <tr key={b.bookId} className={cx(l?.state === "breach" || l?.state === "killed" ? "bg-critical/5" : "")}>
                        <Td>
                          <Link className="font-medium" to={`/books/${b.bookId}`}>
                            {tickerOf(b.symbol)}
                          </Link>
                          <span className="num ml-2 text-[11px] text-muted">#{b.bookId}</span>
                        </Td>
                        <Td>
                          <StateChip meta={limitState(l?.state)} solid={l?.state === "killed"} />
                        </Td>
                        <Td right>{l ? <MiniMeter util={l.inventoryUtil} /> : DASH}</Td>
                        <Td right>{l ? <MiniMeter util={l.skewUtil} /> : DASH}</Td>
                        <Td right num>
                          {l?.hedgeRatioBps == null ? <span className="text-muted">n/a</span> : fmtPct(l.hedgeRatioBps / 10_000, 0)}
                        </Td>
                        <Td right num>
                          {l ? fmtBps(l.drawdownBps) : DASH}
                        </Td>
                        <Td right num>
                          {l ? fmtUsdFloat(l.netExposureUsd, { signed: true, compact: true }) : DASH}
                        </Td>
                        <Td>{l ? l.offHours ? <Chip tone="serious">Off-hours</Chip> : <span className="text-ink-2">In session</span> : DASH}</Td>
                        <Td className="max-w-[260px] truncate text-ink-2" title={l?.breaches.map(breachText).join("; ")}>
                          {l && l.breaches.length ? l.breaches.join(", ") : <span className="text-muted">none</span>}
                        </Td>
                        <Td right num className="text-ink-2">
                          {age === null ? DASH : `${fmtAge(age)} ago`}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </QueryView>
        </Panel>
        {q.data && q.data.length > 0 && <KillLog books={q.data} />}
        <RecentEvents />
      </div>
    </>
  );
}
