import { Link } from "react-router";
import { useQueryError } from "../api/hooks";
import { POLL, trpc } from "../api/trpc";
import { Chip, EmptyState, ErrorState, Hash, PageHeader, Panel, QueryView, SkeletonRows, StateChip, Table, Td, Th } from "../components/ui";
import { charterState } from "../lib/limits";
import { TallyBar, VoteBox } from "../components/VoteBox";
import type { CharterListItem } from "../lib/api-types";
import { venueLabel } from "../lib/copy";
import { bpsPct, fmtDateTime, fmtUsd } from "../lib/format";
import { useWallet } from "../wallet/WalletContext";
import { seatLabel } from "../lib/jury";
import { JuryChip } from "./Charters";

function PendingCharter({ item }: { item: CharterListItem }) {
  const q = trpc.charter.get.useQuery({ charterId: item.charterId }, { refetchInterval: POLL.list });
  const error = useQueryError(q);
  const w = useWallet();
  const c = q.data;
  const seat = c?.committee.find((m) => w.active && m.member.toLowerCase() === w.active.address.toLowerCase());
  return (
    <Panel
      title={
        <Link to={`/charters/${item.charterId}`} className="hover:underline">
          #{item.charterId} {item.name ?? item.symbol}
        </Link>
      }
      meta={`${venueLabel(item.venue)} · filed ${fmtDateTime(item.filedAt)}`}
      actions={<JuryChip recommendApprove={c?.jury ? c.jury.recommendApprove : item.juryRecommendApprove} />}
    >
      {!c ? (
        error ? <ErrorState compact error={error} onRetry={() => q.refetch()} /> : <SkeletonRows rows={3} />
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-2 text-[12.5px]">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="eyebrow">IF size</div>
                <div className="num">{fmtUsd(c.charter.ifTargetUsd, { compact: true, symbol: true })}</div>
              </div>
              <div>
                <div className="eyebrow">MM inventory</div>
                <div className="num">{fmtUsd(c.charter.mmInventoryUsd, { compact: true, symbol: true })}</div>
              </div>
              <div>
                <div className="eyebrow">Max inventory</div>
                <div className="num">{fmtUsd(c.charter.mandate.maxInventoryUsd, { compact: true, symbol: true })}</div>
              </div>
              <div>
                <div className="eyebrow">Senior cap / share</div>
                <div className="num">
                  {bpsPct(c.charter.seniorCapBps)} / {bpsPct(c.charter.seniorHurdleBps)}
                </div>
              </div>
            </div>
            <div className="text-[11.5px] text-ink-2">
              Sponsor <Hash value={c.sponsor} kind="address" />
            </div>
            {c.jury && (() => {
              const s = (c.jury.verdict as { summary?: unknown } | null)?.summary;
              return typeof s === "string" ? <p className="text-[11.5px] text-ink-2">{s}</p> : null;
            })()}
            <Link className="link text-[12px]" to={`/charters/${item.charterId}`}>
              Full terms and jury rationale
            </Link>
          </div>
          <div className="space-y-3">
            <TallyBar {...c.tally} />
            {w.active && !seat && <div className="text-[11.5px] text-warn-ink">The active wallet is not a seated committee member; the vote would be refused.</div>}
            {seat && (
              <div className="flex items-center gap-2 text-[11.5px]">
                <Chip tone={seat.bonded ? "good" : "warn"}>{`${seatLabel(seat.seat)} · ${seat.bonded ? "bonded" : "not bonded"}`}</Chip>
                {seat.voted && <Chip tone="accent">Already voted</Chip>}
              </div>
            )}
            <VoteBox charterId={item.charterId} />
          </div>
        </div>
      )}
    </Panel>
  );
}

export function CommitteePage() {
  const q = trpc.charter.list.useQuery({ status: "Filed", limit: 100 }, { refetchInterval: POLL.list });
  return (
    <>
      <PageHeader
        eyebrow="Risk committee"
        title="Committee"
        sub="Pending charters await two approvals from bonded members (three if the jury recommended rejection); two rejections refund the fee and unlock the sponsor bond. Votes are prepared here and signed by the member's wallet."
      />
      <QueryView
        q={q}
        empty={(d) => d.items.length === 0}
        emptyView={
          <EmptyState
            title="No charters awaiting a decision"
            body="Filed charters appear here once indexed, with the jury verdict and the running tally."
            action={
              <Link className="btn" to="/charters">
                All charters
              </Link>
            }
          />
        }
      >
        {(d) => (
          <div className="space-y-4">
            {d.items.map((c) => (
              <PendingCharter key={c.charterId} item={c} />
            ))}
          </div>
        )}
      </QueryView>
      <RecentDecisions />
    </>
  );
}

function RecentDecisions() {
  const q = trpc.charter.list.useQuery({ limit: 25 }, { refetchInterval: POLL.slow });
  const decided = (q.data?.items ?? []).filter((c) => c.status !== "Filed");
  if (decided.length === 0) return null;
  return (
    <Panel title="Recent decisions" meta={`${decided.length} charter${decided.length === 1 ? "" : "s"}`} className="mt-4">
      <Table minWidth={720}>
        <thead>
          <tr>
            <Th>#</Th>
            <Th>Market</Th>
            <Th>Venue</Th>
            <Th>Outcome</Th>
            <Th>Jury</Th>
            <Th>Decided</Th>
            <Th>Book</Th>
          </tr>
        </thead>
        <tbody>
          {decided.map((c) => (
            <tr key={c.charterId}>
              <Td num>{c.charterId}</Td>
              <Td>
                <Link className="font-medium" to={`/charters/${c.charterId}`}>
                  {c.name ?? c.symbol}
                </Link>
              </Td>
              <Td>{venueLabel(c.venue)}</Td>
              <Td>
                <StateChip meta={charterState(c.status)} />
              </Td>
              <Td>
                <JuryChip recommendApprove={c.juryRecommendApprove} />
              </Td>
              <Td num className="text-ink-2">
                {c.decidedAt ? fmtDateTime(c.decidedAt) : "—"}
              </Td>
              <Td>
                {c.bookAddr ? (
                  <Link className="link" to={`/books/${c.charterId}`}>
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
    </Panel>
  );
}
