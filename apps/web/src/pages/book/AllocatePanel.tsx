// Subscribe / request redemption / claim. The API prepares the transactions; the connected wallet
// signs them in order. Redemption requests are never gated: notice is not a gate.
import { useState } from "react";
import { useQueryError } from "../../api/hooks";
import { POLL, trpc } from "../../api/trpc";
import { Chip, ErrorState, Field, KV, Panel, Segmented, Table, Td, Th, cx } from "../../components/ui";
import { NOTICE_LINE, TRANCHE_COPY } from "../../lib/copy";
import { fmtDateTime, fmtDuration, fmtSharePrice, fmtUsd } from "../../lib/format";
import { TxRunner } from "../../wallet/TxRunner";
import { WalletButton } from "../../wallet/WalletButton";
import { useWallet } from "../../wallet/WalletContext";

type Tranche = "senior" | "junior";
type Action = "subscribe" | "redeem" | "claim";
const AMOUNT_RE = /^\d+(\.\d{1,6})?$/;

function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-1 text-[11.5px] text-ink-2">
      {items.map((w) => (
        <li key={w} className="flex gap-1.5">
          <span className="mt-1.5 size-1 shrink-0 rounded-full bg-warn" aria-hidden />
          {w}
        </li>
      ))}
    </ul>
  );
}

function Position({ bookId, wallet }: { bookId: number; wallet: string }) {
  const q = trpc.tranche.position.useQuery({ bookId, wallet }, { refetchInterval: POLL.list });
  const error = useQueryError(q);
  if (error && !q.data) return <ErrorState compact error={error} onRetry={() => q.refetch()} />;
  if (!q.data) return <div className="text-[11.5px] text-muted">Loading position…</div>;
  const p = q.data;
  const redemptions = p.tranches.flatMap((t) => t.redemptions.map((r) => ({ ...r, tranche: t.tranche })));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {p.tranches.map((t) => (
          <div key={t.tranche} className="rounded-[2px] border border-line p-2.5">
            <div className="flex items-center gap-1.5">
              <span className={cx("size-2 rounded-[1px]", t.tranche === "senior" ? "bg-senior" : "bg-junior")} aria-hidden />
              <span className="eyebrow !text-ink">{t.tranche === "senior" ? "Senior" : "Junior"}</span>
            </div>
            <div className="num mt-1 text-[15px] font-medium">{t.shares === null ? "—" : fmtUsd(t.shares)}</div>
            <div className="num text-[11px] text-muted">shares at {fmtSharePrice(t.sharePrice, 4)}</div>
            <div className="num mt-1 text-[11.5px]">NAV {t.navValueUsd === null ? "—" : fmtUsd(t.navValueUsd, { symbol: true })}</div>
            {t.committedUsd !== null && Number(t.committedUsd) > 0 && <div className="num text-[11px] text-ink-2">committed {fmtUsd(t.committedUsd)}</div>}
            {t.claimableAllocation && (Number(t.claimableAllocation.shares) > 0 || Number(t.claimableAllocation.refundUsd) > 0) && (
              <div className="num text-[11px] text-accent">
                claimable {fmtUsd(t.claimableAllocation.shares)} sh + {fmtUsd(t.claimableAllocation.refundUsd)} refund
              </div>
            )}
            {t.claimableRedemptionUsd !== null && Number(t.claimableRedemptionUsd) > 0 && <div className="num text-[11px] text-accent">redeemed {fmtUsd(t.claimableRedemptionUsd)} USDC to claim</div>}
          </div>
        ))}
      </div>
      {redemptions.length > 0 && (
        <Table minWidth={420}>
          <thead>
            <tr>
              <Th>Tranche</Th>
              <Th right>Shares</Th>
              <Th>Eligible</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {redemptions.map((r) => (
              <tr key={`${r.tranche}-${r.requestId}-${r.requestTx}`}>
                <Td>{r.tranche === "senior" ? "Senior" : "Junior"}</Td>
                <Td right num>
                  {fmtUsd(r.shares)}
                </Td>
                <Td num className="text-ink-2">
                  {fmtDateTime(r.eligibleAt)}
                </Td>
                <Td>
                  <Chip tone={r.status === "claimable" ? "accent" : r.status === "claimed" || r.status === "settled" ? "good" : "neutral"}>{r.status}</Chip>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {p.source === "db" && <p className="text-[11px] text-muted">Chain state unavailable; showing indexed data.</p>}
    </div>
  );
}

export function AllocatePanel(props: { bookId: number; state: string; juniorNoticeSeconds: number | null; subscriptionEnds: string | null }) {
  const w = useWallet();
  const utils = trpc.useUtils();
  const [action, setAction] = useState<Action>(props.state === "Subscription" ? "subscribe" : "redeem");
  const [tranche, setTranche] = useState<Tranche>("senior");
  const [amount, setAmount] = useState("");
  const sub = trpc.tranche.subscribe.useMutation();
  const red = trpc.tranche.redeem.useMutation();
  const claim = trpc.tranche.claim.useMutation();
  const wallet = w.active?.address ?? null;
  const validAmount = AMOUNT_RE.test(amount.trim()) && Number(amount) > 0;

  const reset = () => {
    sub.reset();
    red.reset();
    claim.reset();
  };
  const refresh = () => {
    void utils.tranche.position.invalidate();
    void utils.book.get.invalidate({ bookId: props.bookId });
  };

  const prepare = () => {
    if (!wallet) return;
    if (action === "subscribe") sub.mutate({ bookId: props.bookId, tranche, amountUsd: amount.trim(), wallet });
    else if (action === "redeem") red.mutate({ bookId: props.bookId, tranche, shares: amount.trim(), wallet });
    else claim.mutate({ bookId: props.bookId, wallet });
  };
  const active = action === "subscribe" ? sub : action === "redeem" ? red : claim;

  return (
    <Panel title="Allocate" meta={props.state === "Subscription" && props.subscriptionEnds ? `window closes ${fmtDateTime(props.subscriptionEnds)}` : undefined}>
      <div className="space-y-3">
        <Segmented
          value={action}
          onChange={(a) => (setAction(a), reset())}
          ariaLabel="Action"
          options={[
            { value: "subscribe", label: "Subscribe" },
            { value: "redeem", label: "Request redemption" },
            { value: "claim", label: "Claim" },
          ]}
        />
        {action !== "claim" && (
          <div className="grid grid-cols-2 gap-2">
            {(["senior", "junior"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => (setTranche(t), reset())}
                aria-pressed={tranche === t}
                className={cx(
                  "rounded-[3px] border p-2.5 text-left transition-colors",
                  tranche === t ? (t === "senior" ? "border-senior bg-senior/8" : "border-junior bg-junior/8") : "border-line hover:border-line-strong",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className={cx("size-2 rounded-[1px]", t === "senior" ? "bg-senior" : "bg-junior")} aria-hidden />
                  <span className="text-[13px] font-semibold">{TRANCHE_COPY[t].name}</span>
                </div>
                <div className="mt-1 text-[11px] leading-snug text-ink-2">{TRANCHE_COPY[t].line}</div>
              </button>
            ))}
          </div>
        )}
        {action !== "claim" && (
          <Field
            label={action === "subscribe" ? "Commitment (USDC)" : "Shares to redeem"}
            htmlFor="alloc-amount"
            help={
              action === "subscribe"
                ? "Commitments allocate pro-rata at window close; any excess above the Senior cap or the raise is refundable."
                : tranche === "junior" && props.juniorNoticeSeconds
                  ? `Junior notice ${fmtDuration(props.juniorNoticeSeconds)}. ${NOTICE_LINE}`
                  : "Senior requests settle at the next mark, at that mark's NAV per share."
            }
            error={amount && !validAmount ? "Enter a positive amount with up to 6 decimals" : null}
          >
            <input
              id="alloc-amount"
              className="field num"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              aria-invalid={!!amount && !validAmount}
              onChange={(e) => (setAmount(e.currentTarget.value.replace(/[^\d.]/g, "")), reset())}
            />
          </Field>
        )}
        {action === "claim" && <p className="text-[12px] text-ink-2">Prepares claims for both tranches: window allocations (shares plus any refund), settled redemptions, and full refunds if the window was cancelled.</p>}

        {wallet ? (
          <button type="button" className="btn btn-primary w-full" disabled={active.isPending || (action !== "claim" && !validAmount)} onClick={prepare}>
            {active.isPending ? "Preparing…" : action === "subscribe" ? "Prepare subscription" : action === "redeem" ? "Prepare redemption request" : "Prepare claims"}
          </button>
        ) : (
          <WalletButton label="Connect a wallet to allocate" />
        )}

        {active.error && <ErrorState compact error={active.error} />}

        {action === "subscribe" && sub.data && (
          <div className="space-y-2">
            <KV
              rows={[
                ["Window", sub.data.window.subscriptionEnds ? `open until ${fmtDateTime(sub.data.window.subscriptionEnds)}` : sub.data.window.state],
                ["Per-wallet cap", Number(sub.data.cap.perWalletCapUsd) > 0 ? fmtUsd(sub.data.cap.perWalletCapUsd) : "none"],
                ["Already committed", fmtUsd(sub.data.cap.committedUsd)],
                sub.data.cap.remainingUsd !== null && ["Remaining after this", fmtUsd(sub.data.cap.remainingUsd)],
                sub.data.totalCommittedUsd !== null && ["Tranche committed (all wallets)", fmtUsd(sub.data.totalCommittedUsd)],
              ]}
            />
            <Warnings items={sub.data.warnings} />
            <TxRunner txs={sub.data.txs} signer={sub.data.signer} onConfirmed={refresh} />
          </div>
        )}
        {action === "redeem" && red.data && (
          <div className="space-y-2">
            <KV
              rows={[
                ["Eligible at", fmtDateTime(red.data.eligibleAt)],
                ["Settles at the mark ending", fmtDateTime(red.data.settlesAtPeriodEnd)],
                ["Indicative value", `${fmtUsd(red.data.indicative.valueUsd, { symbol: true })} at ${fmtSharePrice(red.data.indicative.sharePrice, 4)}`],
              ]}
            />
            <p className="text-[11px] text-muted">
              {red.data.notice.text} {red.data.indicative.text}.
            </p>
            <TxRunner txs={red.data.txs} signer={red.data.signer} onConfirmed={refresh} />
          </div>
        )}
        {action === "claim" && claim.data && (
          <div className="space-y-2">
            <p className="text-[12px]">{claim.data.message}</p>
            <KV
              rows={claim.data.claimable.map((c) => [
                c.tranche === "senior" ? "Senior" : "Junior",
                Number(c.cancelledRefundUsd) > 0
                  ? `${fmtUsd(c.cancelledRefundUsd)} refund`
                  : `${fmtUsd(c.allocationShares)} sh · ${fmtUsd(c.refundUsd)} refund · ${fmtUsd(c.redemptionUsd)} redeemed`,
              ])}
            />
            <TxRunner txs={claim.data.txs} signer={claim.data.signer} onConfirmed={refresh} />
          </div>
        )}

        {wallet && (
          <div className="border-t border-line pt-3">
            <div className="eyebrow mb-2">Your position</div>
            <Position bookId={props.bookId} wallet={wallet} />
          </div>
        )}
      </div>
    </Panel>
  );
}
