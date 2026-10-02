import { Link, useParams } from "react-router";
import { useQueryError } from "../api/hooks";
import { POLL, trpc } from "../api/trpc";
import { CharterTerms } from "../components/CharterTerms";
import { Chip, EmptyState, ErrorState, Hash, KV, PageHeader, Panel, SkeletonRows, StateChip, cx } from "../components/ui";
import { TallyBar, VoteBox } from "../components/VoteBox";
import type { CharterDetail } from "../lib/api-types";
import { describeError } from "../lib/errors";
import { fmtDateTime, fmtUsd } from "../lib/format";
import { type VerdictView, jurorLabel, parseVerdict, seatLabel } from "../lib/jury";
import { charterState } from "../lib/limits";
import { JuryChip } from "./Charters";

const CHECK_TONE = { pass: "good", info: "neutral", warn: "warn", block: "critical" } as const;

function Verdict({ v }: { v: VerdictView }) {
  if (v.placeholder) {
    return (
      <EmptyState
        compact
        title="Verdict body not held by this deployment"
        body={`Only the content address is on-chain: the CID above identifies the verdict JSON (models, votes, rationale and rule checks) and its digest was posted to the committee.${v.note ? ` Indexer note: ${v.note}.` : ""}`}
      />
    );
  }
  return (
    <div className="space-y-4">
      {v.summary && <p className="text-[13px]">{v.summary}</p>}
      {v.tally && (
        <div className="num text-[11.5px] text-ink-2">
          {v.tally.approve} approve · {v.tally.reject} reject · {v.tally.abstain} abstain of {v.tally.seats} juror{v.tally.seats === 1 ? "" : "s"}
          {v.approvalsRequired !== null ? ` · committee needs ${v.approvalsRequired} of 3` : ""}
        </div>
      )}
      <div>
        <div className="eyebrow mb-1.5">Jurors</div>
        <ul className="divide-y divide-line rounded-[2px] border border-line">
          {v.models.map((m, i) => (
            <li key={`${m.model}-${i}`} className="p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="num text-[12.5px] font-medium">{jurorLabel(m.model)}</span>
                <Chip tone={m.vote === "approve" ? "good" : m.vote === "reject" ? "critical" : "neutral"}>{m.vote}</Chip>
              </div>
              {m.rationale && <p className="mt-1 text-[12px] text-ink-2">{m.rationale}</p>}
              {m.risks.length > 0 && (
                <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11.5px] text-ink-2">
                  {m.risks.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              {m.error && <p className="mt-1 text-[11px] text-muted">Juror note: {m.error}</p>}
            </li>
          ))}
        </ul>
      </div>
      {v.ruleChecks.length > 0 && (
        <div>
          <div className="eyebrow mb-1.5">Rule checks</div>
          <ul className="space-y-1">
            {v.ruleChecks.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-[12px]">
                <Chip tone={CHECK_TONE[c.status]} className="mt-px">
                  {c.status}
                </Chip>
                <div className="min-w-0">
                  <span className="num text-[11.5px] text-ink-2">{c.id}</span>
                  <div>{c.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Committee({ c }: { c: CharterDetail }) {
  return (
    <div className="space-y-3">
      <TallyBar {...c.tally} />
      <ul className="divide-y divide-line rounded-[2px] border border-line">
        {c.committee.length === 0 && <li className="p-2.5 text-[12px] text-muted">No seated members indexed.</li>}
        {c.committee.map((m) => {
          const vote = c.votes.find((v) => v.member.toLowerCase() === m.member.toLowerCase());
          return (
            <li key={m.member} className="flex flex-wrap items-center justify-between gap-2 p-2.5">
              <div className="min-w-0">
                <div className="text-[12px] font-medium">{seatLabel(m.seat)}</div>
                <Hash value={m.member} kind="address" />
              </div>
              <div className="flex items-center gap-2">
                {!m.bonded && <Chip tone="warn">Not bonded</Chip>}
                {vote ? (
                  <Chip tone={vote.approve ? "good" : "critical"}>{vote.approve ? "Approved" : "Rejected"}</Chip>
                ) : m.voted ? (
                  <Chip tone="accent">Voted</Chip>
                ) : (
                  <Chip tone="neutral">No vote</Chip>
                )}
                {vote?.tx && <Hash value={vote.tx} kind="tx" />}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="text-[11px] text-muted">Tally source: {c.tally.source === "chain" ? "RiskCommittee on-chain" : "indexed votes"}</div>
    </div>
  );
}

export function CharterDetailPage() {
  const { charterId: raw } = useParams();
  const charterId = Number(raw);
  const valid = Number.isInteger(charterId) && charterId > 0;
  const q = trpc.charter.get.useQuery({ charterId: valid ? charterId : 1 }, { enabled: valid, refetchInterval: POLL.list });
  const error = useQueryError(q);

  if (!valid) return <EmptyState title="Unknown charter" body="Charter ids are positive integers." />;
  if (!q.data) {
    if (error) {
      const nf = describeError(error).kind === "not_found";
      return (
        <>
          <PageHeader eyebrow={<Link to="/charters">Charters / #{charterId}</Link>} title={nf ? "Charter not found" : `Charter #${charterId}`} />
          {nf ? <EmptyState title={`There is no charter #${charterId}`} body="It may not be indexed yet if it was filed moments ago." /> : <ErrorState error={error} onRetry={() => q.refetch()} />}
        </>
      );
    }
    return <SkeletonRows rows={8} />;
  }
  const c = q.data;
  const meta = (c.meta ?? {}) as { name?: unknown; description?: unknown };
  const verdict = c.jury ? parseVerdict(c.jury.verdict) : null;
  return (
    <>
      <PageHeader
        eyebrow={
          <Link to="/charters" className="hover:text-ink">
            Charters / #{c.charterId}
          </Link>
        }
        title={typeof meta.name === "string" && meta.name ? meta.name : c.charter.symbol || `Charter #${c.charterId}`}
        sub={typeof meta.description === "string" ? meta.description : undefined}
        actions={
          c.book ? (
            <Link className="btn btn-primary" to={`/books/${c.book.bookId}`}>
              Open book #{c.book.bookId}
            </Link>
          ) : undefined
        }
      >
        <div className="mt-2 flex flex-wrap gap-2">
          <StateChip meta={charterState(c.status)} />
          <JuryChip recommendApprove={c.jury ? c.jury.recommendApprove : null} />
        </div>
      </PageHeader>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          <Panel title="Terms">
            <CharterTerms c={c.charter} explain />
          </Panel>
          <Panel title="Jury verdict" meta={c.jury ? `posted ${c.jury.postedTx ? "on-chain" : "off-chain only"}` : undefined}>
            {!c.jury ? (
              <EmptyState compact title="Verdict pending" body="The model jury reviews the charter with deterministic rule checks; the verdict JSON is content-addressed (CIDv1) and its digest is posted to the committee." />
            ) : (
              <div className="space-y-4">
                <KV
                  rows={[
                    ["Recommendation", c.jury.recommendApprove ? "Approve" : "Reject"],
                    ["CID", <span key="cid" className="num break-all text-[11.5px]">{c.jury.cid}</span>],
                    ["Digest", <Hash key="d" value={c.jury.digest} head={10} tail={6} />],
                    c.jury.postedTx ? ["Posted in", <Hash key="tx" value={c.jury.postedTx} kind="tx" />] : null,
                    c.jury.onChain && ["On-chain", c.jury.onChain.posted ? (c.jury.onChain.recommendApprove ? "posted · approve" : "posted · reject") : "not posted"],
                  ]}
                />
                {verdict ? <Verdict v={verdict} /> : <p className="text-[12px] text-muted">Verdict body not available from the API (only the digest is on-chain).</p>}
              </div>
            )}
          </Panel>
        </div>
        <aside className="min-w-0 space-y-4">
          <Panel title="Committee" meta="2 of 3 bonded members">
            <Committee c={c} />
            {c.status === "Filed" && (
              <div className={cx("mt-4 border-t border-line pt-3")}>
                <div className="eyebrow mb-2">Cast a vote</div>
                <VoteBox charterId={c.charterId} />
              </div>
            )}
          </Panel>
          <Panel title="Filing">
            <KV
              rows={[
                ["Sponsor", <Hash key="s" value={c.sponsor} kind="address" />],
                ["Filed", fmtDateTime(c.filedAt)],
                ["Decided", c.decidedAt ? fmtDateTime(c.decidedAt) : "—"],
                ["Charter fee", c.feeUsd ? fmtUsd(c.feeUsd, { symbol: true }) : "—"],
                ["Filing tx", <Hash key="b" value={c.bondTx} kind="tx" />],
              ]}
            />
          </Panel>
        </aside>
      </div>
    </>
  );
}
