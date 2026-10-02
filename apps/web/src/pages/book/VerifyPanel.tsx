// "Verify proof": recomputes a mark's receipts root from its hourly roots and checks a receipt's
// inclusion proofs entirely in the browser (StandardMerkleTree, as verified on-chain).
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { Hex } from "viem";
import { useOptional, useQueryError } from "../../api/hooks";
import { trpc } from "../../api/trpc";
import { Chip, EmptyState, ErrorState, Hash, Panel, SkeletonRows, cx } from "../../components/ui";
import type { MarkItem } from "../../lib/api-types";
import { parseReceipts } from "../../lib/feeds";
import { fmtDateTime, isZeroHash } from "../../lib/format";
import { config } from "../../lib/config";
import { type ProofCheck, allPass, markCommittedFromLogs, recomputeReceiptsRoot, verifyReceiptProof } from "../../lib/proof";
import { appChain, publicClient } from "../../wallet/chains";

function CheckList({ checks }: { checks: ProofCheck[] }) {
  return (
    <ul className="divide-y divide-line rounded-[2px] border border-line">
      {checks.map((c) => (
        <li key={c.id} className="flex items-start gap-2 px-2.5 py-2">
          <span
            className={cx(
              "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-[2px] text-[10px] font-bold text-white",
              c.state === "pass" ? "bg-good" : c.state === "fail" ? "bg-critical" : "bg-muted",
            )}
            aria-label={c.state}
          >
            {c.state === "pass" ? "✓" : c.state === "fail" ? "✕" : "–"}
          </span>
          <div className="min-w-0">
            <div className="text-[12.5px] font-medium">{c.label}</div>
            <div className="num text-[11px] break-all text-muted">{c.detail}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The mark as committed on-chain: MarkCommitted decoded from its commit transaction's receipt. */
function useOnChainMark(mark: MarkItem) {
  return useQuery({
    queryKey: ["mark-commit-log", appChain.id, mark.txHash, mark.markId],
    enabled: /^0x[0-9a-fA-F]{64}$/.test(mark.txHash),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
    queryFn: async () => {
      const r = await publicClient.getTransactionReceipt({ hash: mark.txHash as Hex });
      return { event: markCommittedFromLogs(r.logs, mark.markId), blockNumber: r.blockNumber };
    },
  });
}

function onChainCheck(chain: ReturnType<typeof useOnChainMark>, mark: MarkItem, local: string): ProofCheck {
  if (chain.isLoading) return { id: "chain", label: "Reading the MarkCommitted event from the chain", state: "skip", detail: `tx ${mark.txHash}` };
  if (chain.error || !chain.data) return { id: "chain", label: "Committed root on-chain", state: "skip", detail: `RPC ${config.rpcUrl} unreachable; chain check skipped` };
  const ev = chain.data.event;
  if (!ev) return { id: "chain", label: "Committed root on-chain", state: "fail", detail: `No MarkCommitted(markId ${mark.markId}) log in tx ${mark.txHash}` };
  const ok = ev.receiptsRoot.toLowerCase() === local.toLowerCase() && ev.signer.toLowerCase() === mark.signer.toLowerCase();
  return {
    id: "chain",
    label: `Matches MarkCommitted on-chain (block ${chain.data.blockNumber.toString()})`,
    state: ok ? "pass" : "fail",
    detail: `registry ${ev.registry} · receiptsRoot ${ev.receiptsRoot} · signer ${ev.signer}`,
  };
}

function MarkRootCheck({ mark }: { mark: MarkItem }) {
  const q = trpc.receipts.root.useQuery({ markId: mark.markId });
  const chain = useOnChainMark(mark);
  const error = useQueryError(q);
  const local = useMemo(() => {
    if (!q.data || q.data.kind !== "mark") return null;
    return recomputeReceiptsRoot(q.data.bookId, q.data.hours);
  }, [q.data]);
  if (error) return <ErrorState compact error={error} onRetry={() => q.refetch()} />;
  if (!q.data || q.data.kind !== "mark" || !local) return <SkeletonRows rows={2} />;
  const d = q.data;
  const leaves = d.hours.reduce((a, h) => a + h.leafCount, 0);
  const checks: ProofCheck[] = [
    {
      id: "recompute",
      label: `Receipts root rebuilt in the browser from ${d.hours.length} hourly root${d.hours.length === 1 ? "" : "s"} (${leaves} receipts)`,
      state: local.toLowerCase() === mark.receiptsRoot.toLowerCase() ? "pass" : "fail",
      detail: `local ${local}`,
    },
    {
      id: "committed",
      label: `Matches the root signed into mark #${mark.markId}`,
      state: d.receiptsRoot.toLowerCase() === mark.receiptsRoot.toLowerCase() ? "pass" : "fail",
      detail: `committed ${mark.receiptsRoot} in tx ${mark.txHash}`,
    },
    onChainCheck(chain, mark, local),
  ];
  return (
    <div className="space-y-2">
      <CheckList checks={checks} />
      {isZeroHash(mark.receiptsRoot) && d.hours.length === 0 && <p className="text-[11px] text-muted">An empty period commits the zero root.</p>}
      {d.hours.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[12px] text-ink-2">Hourly roots in the period</summary>
          <ul className="mt-1 space-y-0.5 text-[11px]">
            {d.hours.map((h) => (
              <li key={h.hourStart} className="num flex flex-wrap items-center gap-x-3 text-ink-2">
                <span>{fmtDateTime(h.hourStart)}</span>
                <Hash value={h.root} />
                <span>{h.leafCount} leaves</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ReceiptCheck({ receiptId, committedRootFor }: { receiptId: number; committedRootFor: (markId: number) => string | null }) {
  const q = trpc.receipts.proof.useQuery({ receiptId });
  const error = useQueryError(q);
  if (error) return <ErrorState compact error={error} onRetry={() => q.refetch()} />;
  if (!q.data) return <SkeletonRows rows={3} />;
  const p = q.data;
  const checks = verifyReceiptProof(p, p.period ? committedRootFor(p.period.markId) : undefined);
  const ok = allPass(checks);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <Chip tone={ok ? "good" : "critical"}>{ok ? "Verified in the browser" : "Verification failed"}</Chip>
        <span className="text-ink-2">
          {p.kindName} receipt #{p.receiptId} · book #{p.bookId} · {fmtDateTime(p.ts)}
        </span>
      </div>
      <CheckList checks={checks} />
      <details>
        <summary className="cursor-pointer text-[12px] text-ink-2">Leaf, proofs and payload</summary>
        <pre className="num mt-1 max-h-64 overflow-auto rounded-[2px] bg-surface-2 p-2 text-[10.5px] leading-4 whitespace-pre-wrap break-all">
          {JSON.stringify({ leaf: p.leaf, hourlyProof: p.hourly.proof, period: p.period ? { leaf: p.period.leaf, proof: p.period.proof } : null, payload: p.payload }, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function VerifyPanel(props: { bookId: number; mark: MarkItem | null; marks: MarkItem[]; receiptId: number | null; onReceipt: (id: number | null) => void }) {
  const [input, setInput] = useState(props.receiptId ? String(props.receiptId) : "");
  useEffect(() => {
    if (props.receiptId) setInput(String(props.receiptId));
  }, [props.receiptId]);
  const receipts = useOptional("receipts.list", { bookId: props.bookId, limit: 25 }, parseReceipts, {});
  const committedRootFor = (markId: number) => props.marks.find((m) => m.markId === markId)?.receiptsRoot ?? null;
  const submit = () => {
    const n = Number(input.trim());
    props.onReceipt(Number.isInteger(n) && n > 0 ? n : null);
  };

  return (
    <Panel id="verify" title="Verify proof" meta="computed locally, OpenZeppelin StandardMerkleTree">
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="min-w-0">
          <div className="eyebrow mb-2">Mark receipts root</div>
          {props.mark ? (
            <MarkRootCheck mark={props.mark} />
          ) : (
            <EmptyState compact title="Pick a mark" body="Use Verify proof on a row of the marks table to rebuild its receipts root from the hourly roots." />
          )}
        </div>
        <div className="min-w-0">
          <div className="eyebrow mb-2">Receipt inclusion</div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input
              className="field num"
              inputMode="numeric"
              placeholder="Receipt id (quote, fill, hedge or decision)"
              value={input}
              onChange={(e) => setInput(e.currentTarget.value.replace(/[^\d]/g, ""))}
              aria-label="Receipt id"
            />
            <button type="submit" className="btn btn-primary" disabled={!input}>
              Verify
            </button>
          </form>
          {receipts.data?.supported && receipts.data.data.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {receipts.data.data.slice(0, 12).map((r) => (
                <button key={r.id} type="button" className="btn h-6 min-h-6 px-2 text-[11px]" onClick={() => props.onReceipt(r.id)} title={fmtDateTime(r.ts)}>
                  #{r.id} {r.kindName}
                </button>
              ))}
            </div>
          )}
          <div className="mt-3">
            {props.receiptId ? (
              <ReceiptCheck receiptId={props.receiptId} committedRootFor={committedRootFor} />
            ) : (
              <p className="text-[11.5px] text-muted">
                Every quote, fill, hedge and risk decision is a leaf (kind, book, time, payload hash) of an hourly root; the hourly roots of a period are the leaves of the receipts root
                signed into that period's mark.
              </p>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}

