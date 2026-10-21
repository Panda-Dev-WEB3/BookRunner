// The epoch queue: where the oldest unprocessed epoch stands (open, waiting for the books' marks, ready to be
// processed), what it holds, and the processed epochs with the stale flag (processed after the grace).
import { useNow } from "../../api/hooks";
import type { PoolEpochsOut, PoolOverviewOut } from "../../lib/api-types";
import { fmtDateTime, fmtDuration, fmtUsd, isoToSec } from "../../lib/format";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { Card, Chip, EmptyState, ErrorState, Hash, KV, SkeletonRows, Table, Td, Th, Term } from "../ui";
import { DEFAULT_EPOCH_SEC, DEFAULT_GRACE_SEC, fmtShares, phaseMeta, phaseSentence } from "./poolLogic";

/** Side card: the current epoch in plain words. */
export function EpochStatus(props: { overview: PoolOverviewOut | undefined }) {
  const sym = useSettlementSymbol();
  const now = useNow(30_000);
  const o = props.overview;
  const q = o?.queue ?? null;
  const p = o?.params ?? null;
  if (!o) return null;
  if (!q) {
    return (
      <Card title="Epoch queue" padding="md">
        <p className="text-[13px] text-ink-2">The queue status needs a live chain read, which failed just now. It retries on its own.</p>
      </Card>
    );
  }
  const meta = phaseMeta(q.phase);
  const endsIn = (isoToSec(q.endsAt) ?? 0) * 1000 - now;
  return (
    <Card
      title={
        <>
          <Term id="poolEpoch">Epoch</Term> {q.epoch}
        </>
      }
      actions={<Chip tone={meta.tone}>{meta.label}</Chip>}
      padding="md"
    >
      <p className="text-[13px] text-ink-2">{phaseSentence(q)}</p>
      <KV
        className="mt-3"
        rows={[
          ["Ends", endsIn > 0 ? `${fmtDateTime(q.endsAt)} (in ${fmtDuration(endsIn / 1000)})` : fmtDateTime(q.endsAt)],
          [`Deposits queued`, `${fmtUsd(q.depositsUsd)} ${sym}`],
          ["Withdrawals queued", `${fmtShares(q.withdrawShares)} shares`],
          q.phase === "awaiting_marks" ? ["Books still to mark", String(q.staleBooks)] : null,
          q.ended ? ["Grace ends", fmtDateTime(q.graceEndsAt)] : ["Next epoch ends", fmtDateTime(q.nextEpochEndsAt)],
          ["Epoch length · grace", `${fmtDuration(p?.epochLengthSeconds ?? DEFAULT_EPOCH_SEC)} · ${fmtDuration(p?.processGraceSeconds ?? DEFAULT_GRACE_SEC)}`],
          p?.pendingEpochLengthSeconds ? ["Next epoch length", `${fmtDuration(p.pendingEpochLengthSeconds)}, once the queue is idle`] : null,
        ]}
      />
    </Card>
  );
}

/** Processed epochs, newest first. */
export function EpochHistory(props: { data: PoolEpochsOut | undefined; error: unknown; onRetry: () => void }) {
  const sym = useSettlementSymbol();
  const d = props.data;
  if (!d) return props.error ? <ErrorState compact error={props.error} onRetry={props.onRetry} /> : <SkeletonRows rows={4} />;
  if (d.items.length === 0) return <EmptyState compact title="No epoch processed yet" body="The first processing prices every queued deposit and withdrawal of that epoch." />;
  return (
    <Table minWidth={720}>
      <thead>
        <tr>
          <Th>Epoch</Th>
          <Th>Ended</Th>
          <Th>Processed</Th>
          <Th right>Deposits in</Th>
          <Th right>Shares minted</Th>
          <Th right>Shares filled</Th>
          <Th right>Paid out</Th>
          <Th>Status</Th>
        </tr>
      </thead>
      <tbody>
        {d.items.map((e) => (
          <tr key={e.epoch}>
            <Td num>{e.epoch}</Td>
            <Td num className="text-ink-2">
              {fmtDateTime(e.endsAt)}
            </Td>
            <Td num className="text-ink-2">
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {fmtDateTime(e.processedAt)}
                {e.processTx && <Hash value={e.processTx} kind="tx" />}
              </span>
            </Td>
            <Td right num>
              {fmtUsd(e.depositsUsd)} {sym}
            </Td>
            <Td right num>
              {fmtShares(e.depositShares, 2)}
            </Td>
            <Td right num>
              {fmtShares(e.withdrawShares, 2)}
            </Td>
            <Td right num>
              {fmtUsd(e.withdrawUsd)} {sym}
            </Td>
            <Td>
              <span className="inline-flex flex-wrap gap-1">
                {e.stale ? (
                  <Chip tone="warn" title={`Processed after the grace with ${e.staleBooks} book(s) not marked since the epoch end`}>
                    Stale · {e.staleBooks} unmarked
                  </Chip>
                ) : (
                  <Chip tone="good">All books marked</Chip>
                )}
                {!e.complete && <Chip tone="accent">Partly filled</Chip>}
              </span>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
