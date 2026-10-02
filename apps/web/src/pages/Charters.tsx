import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { POLL, trpc } from "../api/trpc";
import { Chip, EmptyState, Hash, PageHeader, Panel, QueryView, Segmented, StateChip, Table, Td, Th } from "../components/ui";
import { venueLabel } from "../lib/copy";
import { fmtDateTime } from "../lib/format";
import { charterState } from "../lib/limits";

const FILTERS = ["all", "Filed", "Approved", "Rejected", "Expired", "Retired"] as const;
type Filter = (typeof FILTERS)[number];

export function JuryChip({ recommendApprove }: { recommendApprove: boolean | null }) {
  if (recommendApprove === null) return <Chip tone="neutral">Awaiting jury</Chip>;
  return <Chip tone={recommendApprove ? "good" : "critical"}>{recommendApprove ? "Jury: approve" : "Jury: reject"}</Chip>;
}

export function ChartersPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const q = trpc.charter.list.useQuery(filter === "all" ? { limit: 100 } : { status: filter, limit: 100 }, { refetchInterval: POLL.list });
  const nav = useNavigate();
  return (
    <>
      <PageHeader
        eyebrow="Underwriting"
        title="Charters"
        sub="A charter proposes a market: underlying, venue, oracle plan, capital, mandate and tranche terms. A model jury reviews it, then two of three bonded committee members decide."
        actions={
          <Link to="/charters/new" className="btn btn-primary">
            File a charter
          </Link>
        }
      />
      <div className="mb-3">
        <Segmented value={filter} onChange={setFilter} ariaLabel="Status filter" options={FILTERS.map((f) => ({ value: f, label: f === "all" ? "All" : f }))} />
      </div>
      <Panel title="Charters" meta={q.data ? `${q.data.items.length} shown` : undefined}>
        <QueryView
          q={q}
          empty={(d) => d.items.length === 0}
          emptyView={
            <EmptyState
              title={filter === "all" ? "No charters filed yet" : `No ${filter.toLowerCase()} charters`}
              body="Sponsors file charters on-chain with a flat fee and a BKRN bond; the indexer lists them here."
              action={
                <Link className="btn" to="/charters/new">
                  File a charter
                </Link>
              }
            />
          }
        >
          {(d) => (
            <Table minWidth={900}>
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Market</Th>
                  <Th>Venue</Th>
                  <Th>Sponsor</Th>
                  <Th>Status</Th>
                  <Th>Jury</Th>
                  <Th>Filed</Th>
                  <Th>Decided</Th>
                  <Th>Book</Th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((c) => (
                  <tr key={c.charterId} className="cursor-pointer hover:bg-surface-2" onClick={() => nav(`/charters/${c.charterId}`)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && nav(`/charters/${c.charterId}`)}>
                    <Td num>{c.charterId}</Td>
                    <Td>
                      <Link to={`/charters/${c.charterId}`} className="font-medium" onClick={(e) => e.stopPropagation()}>
                        {c.name ?? c.symbol}
                      </Link>
                      {c.name && <div className="num text-[11px] text-muted">{c.symbol}</div>}
                    </Td>
                    <Td>{venueLabel(c.venue)}</Td>
                    <Td>
                      <Hash value={c.sponsor} kind="address" />
                    </Td>
                    <Td>
                      <StateChip meta={charterState(c.status)} />
                    </Td>
                    <Td>
                      <JuryChip recommendApprove={c.juryRecommendApprove} />
                    </Td>
                    <Td num className="text-ink-2">
                      {fmtDateTime(c.filedAt)}
                    </Td>
                    <Td num className="text-ink-2">
                      {c.decidedAt ? fmtDateTime(c.decidedAt) : "—"}
                    </Td>
                    <Td>
                      {c.bookAddr ? (
                        <Link className="link" to={`/books/${c.charterId}`} onClick={(e) => e.stopPropagation()}>
                          Book #{c.charterId}
                        </Link>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryView>
      </Panel>
    </>
  );
}
