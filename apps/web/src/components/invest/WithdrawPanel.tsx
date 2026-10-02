// Withdraw tab of the invest panel: the wallet's position in this book (tranche.position), a
// withdrawal request (tranche.redeem; the notice is explained, it is never a gate) and a claim of
// anything settled (tranche.claim). Every transaction goes through TxRunner with plain prompts.
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Address } from "viem";
import { useQueryError } from "../../api/hooks";
import { trpc } from "../../api/trpc";
import type { BookDetail, PositionOut } from "../../lib/api-types";
import { USDC_DECIMALS, amountIssue, amountIssueText, formatAmountDisplay, parseAmount } from "../../lib/amount";
import { CASH_WAIT_LINE, NOTICE_LINE } from "../../lib/copy";
import { fmtDuration, fmtSharePrice, fmtUsd, fmtWhen, isoToSec, usdRaw } from "../../lib/format";
import { invalidateWalletBalances } from "../../wallet/balances";
import { TxRunner } from "../../wallet/TxRunner";
import { WalletButton } from "../../wallet/WalletButton";
import { AmountInput, Callout, EmptyState, ErrorState, Segmented, SkeletonRows, Spinner, Term, ValueKind, cx } from "../ui";
import { InfoList, TrancheSwatch } from "./InvestBits";
import { TRANCHE_IDS, TRANCHE_NAME, type TrancheId, positionFlags, sharesValue, withPlainPrompts } from "./logic";
import { type TrancheAddresses, invalidateInvestReads } from "./useInvestChain";

type TranchePosition = PositionOut["tranches"][number];

const usdc = (raw: bigint | null | undefined, dp = 2) => (raw == null ? "—" : `${formatAmountDisplay(raw, USDC_DECIMALS, dp)} USDC`);
const sharesText = (v: string | null | undefined) => (v == null ? "—" : `${fmtUsd(v)} shares`);
const isPositive = (v: string | null | undefined) => (usdRaw(v) ?? 0n) > 0n;

const STATUS_TEXT: Record<string, { label: string; cls: string }> = {
  pending: { label: "Waiting for its mark", cls: "bg-surface-2 text-ink-2" },
  claimable: { label: "Ready to collect", cls: "bg-good/12 text-good-ink" },
  settled: { label: "Settled", cls: "bg-good/12 text-good-ink" },
  claimed: { label: "Collected", cls: "bg-surface-2 text-ink-2" },
};

export function WithdrawPanel(props: {
  book: BookDetail;
  ticker: string;
  addrs: TrancheAddresses;
  wallet: Address | null;
  position: { data: PositionOut | undefined; error: unknown; failureReason?: unknown; isLoading: boolean; refetch: () => unknown };
  onDepositTab: () => void;
}) {
  const error = useQueryError(props.position);
  // Keep the claim box (and its confirmation) on screen after a claim empties what was claimable.
  const [claimUsed, setClaimUsed] = useState(false);
  if (!props.wallet) {
    return (
      <Callout tone="info" title="Connect a wallet to see your position" action={<WalletButton label="Connect wallet" />}>
        Your shares, pending withdrawals and anything ready to collect in {props.ticker} show up here.
      </Callout>
    );
  }
  const p = props.position.data;
  if (!p) {
    if (error) return <ErrorState error={error} onRetry={() => props.position.refetch()} compact />;
    return <SkeletonRows rows={4} />;
  }
  const flags = positionFlags(p.tranches);
  const cancelled = props.book.state === "Cancelled";
  if (!flags.anything && !cancelled && !claimUsed) {
    return (
      <EmptyState
        title={`No position in ${props.ticker}`}
        body="Once you deposit, your shares, withdrawal requests and anything ready to collect appear here. Withdrawal requests are always accepted, whatever the book's state."
        action={
          <button type="button" className="btn btn-primary btn-sm" onClick={props.onDepositTab}>
            Make a deposit
          </button>
        }
      />
    );
  }
  return (
    <div className="space-y-6">
      <section aria-label="Your position">
        <div className="grid gap-3 sm:grid-cols-2">
          {p.tranches.map((t) => (
            <PositionCard key={t.tranche} t={t} />
          ))}
        </div>
        {p.source === "db" && <p className="mt-2 text-[12px] text-muted">Chain reads are unavailable right now; showing indexed data.</p>}
      </section>

      {(flags.allocationToClaim || flags.redemptionToClaim || cancelled || claimUsed) && <ClaimBox {...props} p={p} cancelled={cancelled} onUsed={() => setClaimUsed(true)} />}

      <RedeemBox {...props} p={p} />

      <RequestList p={p} />
    </div>
  );
}

function PositionCard({ t }: { t: TranchePosition }) {
  const name = TRANCHE_NAME[t.tranche];
  const toClaim = t.claimableAllocation && (isPositive(t.claimableAllocation.shares) || isPositive(t.claimableAllocation.refundUsd));
  return (
    <div className={cx("rounded-card border bg-surface p-4", t.tranche === "senior" ? "border-senior/40" : "border-junior/45")}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-[14px] font-semibold">
          <TrancheSwatch t={t.tranche} />
          {name}
        </span>
        <ValueKind kind="marked" />
      </div>
      <div className="num mt-2 text-[22px] font-medium tracking-[-0.02em]">{sharesText(t.shares)}</div>
      <div className="num text-[12.5px] text-ink-2">
        worth {t.navValueUsd === null ? "—" : fmtUsd(t.navValueUsd, { symbol: true })} at {fmtSharePrice(t.sharePrice, 6)} per share
      </div>
      <ul className="mt-3 space-y-1 text-[12.5px]">
        {isPositive(t.committedUsd) && (
          <li className="text-ink-2">
            <span className="num font-medium text-ink">{fmtUsd(t.committedUsd)} USDC</span> waiting in the current round
          </li>
        )}
        {toClaim && t.claimableAllocation && (
          <li className="text-good-ink">
            Ready to collect: <span className="num">{fmtUsd(t.claimableAllocation.shares)}</span> shares
            {isPositive(t.claimableAllocation.refundUsd) ? (
              <>
                {" "}
                + <span className="num">{fmtUsd(t.claimableAllocation.refundUsd)}</span> USDC refund
              </>
            ) : null}
          </li>
        )}
        {isPositive(t.claimableRedemptionUsd) && (
          <li className="text-good-ink">
            Ready to collect: <span className="num">{fmtUsd(t.claimableRedemptionUsd)}</span> USDC from withdrawals
          </li>
        )}
      </ul>
    </div>
  );
}

function ClaimBox(props: { book: BookDetail; ticker: string; addrs: TrancheAddresses; wallet: Address | null; p: PositionOut; cancelled: boolean; onUsed: () => void }) {
  const claim = trpc.tranche.claim.useMutation();
  const utils = trpc.useUtils();
  const qc = useQueryClient();
  const [done, setDone] = useState(false);
  const txs = useMemo(
    () => (claim.data ? withPlainPrompts(claim.data.txs, { book: props.ticker, tranches: { senior: props.addrs.senior, junior: props.addrs.junior } }) : []),
    [claim.data, props.ticker, props.addrs.senior, props.addrs.junior],
  );
  const onConfirmed = () => {
    setDone(true);
    props.onUsed();
    void invalidateWalletBalances(qc);
    void invalidateInvestReads(qc);
    void utils.tranche.position.invalidate();
  };
  return (
    <section className="rounded-card border border-good/30 bg-good/[0.05] p-4 sm:p-5" aria-label="Collect">
      <h3 className="text-[15px] font-semibold">Ready to collect</h3>
      <p className="mt-1 text-[13px] text-ink-2">
        {props.cancelled
          ? "This book was cancelled at the end of its subscription window, so every commitment can be taken back in full."
          : `A round or a withdrawal has settled. Collecting is a separate transaction that sends the shares, any refund and any withdrawn USDC to your wallet. ${CASH_WAIT_LINE} Claims are never blocked by a pause or a kill.`}
      </p>
      {done ? (
        <Callout tone="success" compact className="mt-3" title="Collected">
          The shares and USDC are in your wallet now.
        </Callout>
      ) : !claim.data ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary btn-sm" disabled={claim.isPending || !props.wallet} onClick={() => props.wallet && claim.mutate({ bookId: props.book.bookId, wallet: props.wallet })}>
            {claim.isPending ? (
              <>
                <Spinner size={14} /> Preparing…
              </>
            ) : (
              "Prepare the claim"
            )}
          </button>
        </div>
      ) : null}
      {claim.error && <ErrorState compact error={claim.error} />}
      {claim.data && (
        <div className="mt-3 space-y-2">
          {claim.data.txs.length === 0 ? (
            <p className="text-[13px] text-ink-2">Nothing to collect right now: the chain shows no settled amount for this wallet yet.</p>
          ) : (
            <TxRunner txs={txs} signer={claim.data.signer} onConfirmed={onConfirmed} />
          )}
        </div>
      )}
    </section>
  );
}

function RedeemBox(props: { book: BookDetail; ticker: string; addrs: TrancheAddresses; wallet: Address | null; p: PositionOut }) {
  const withShares = props.p.tranches.filter((t) => isPositive(t.shares));
  const [tranche, setTranche] = useState<TrancheId>(withShares[0]?.tranche ?? "senior");
  const [value, setValue] = useState("");
  const [sent, setSent] = useState(false);
  const red = trpc.tranche.redeem.useMutation();
  const utils = trpc.useUtils();
  const qc = useQueryClient();
  const pos = props.p.tranches.find((t) => t.tranche === tranche);
  const balance = usdRaw(pos?.shares ?? null);
  const issue = amountIssue(value, { decimals: USDC_DECIMALS, balance });
  const raw = issue === null ? parseAmount(value, USDC_DECIMALS) : null;
  const est = raw !== null && pos ? sharesValue(raw, pos.sharePrice) : null;
  const notice = props.book.charter?.juniorNoticeSeconds ?? 0;
  const eligibleSec = red.data ? red.data.eligibleAtUnix : null;
  const settlesSec = red.data ? isoToSec(red.data.settlesAtPeriodEnd) : null;
  const txs = useMemo(
    () =>
      red.data
        ? withPlainPrompts(red.data.txs, {
            book: props.ticker,
            tranches: { senior: props.addrs.senior, junior: props.addrs.junior },
            eligibleText: eligibleSec ? fmtWhen(eligibleSec) : null,
          })
        : [],
    [red.data, props.ticker, props.addrs.senior, props.addrs.junior, eligibleSec],
  );
  const reset = () => {
    red.reset();
    setSent(false);
  };
  const onConfirmed = () => {
    setSent(true);
    void invalidateWalletBalances(qc);
    void invalidateInvestReads(qc);
    void utils.tranche.position.invalidate();
  };

  if (withShares.length === 0 && !red.data) {
    return (
      <section aria-label="Request a withdrawal">
        <h3 className="text-[15px] font-semibold">Request a withdrawal</h3>
        <p className="mt-1 text-[13px] text-ink-2">
          You hold no shares in your wallet yet. If a round has settled for you, collect your shares above first; then you can ask to withdraw them here.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Request a withdrawal" className="space-y-3">
      <div>
        <h3 className="text-[15px] font-semibold">Request a withdrawal</h3>
        <p className="mt-1 text-[13px] text-ink-2">
          You give back shares and receive USDC at the share price of the <Term id="mark">mark</Term> that settles your request. {NOTICE_LINE}
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="min-w-0 space-y-3">
          {withShares.length > 1 && (
            <Segmented
              ariaLabel="Tranche to withdraw from"
              value={tranche}
              onChange={(t) => {
                setTranche(t);
                setValue("");
                reset();
              }}
              options={TRANCHE_IDS.filter((t) => withShares.some((x) => x.tranche === t)).map((t) => ({ value: t, label: TRANCHE_NAME[t] }))}
            />
          )}
          <AmountInput
            id={`redeem-${props.book.bookId}`}
            label={`${TRANCHE_NAME[tranche]} shares to withdraw`}
            symbol="shares"
            value={value}
            onChange={(v) => {
              setValue(v);
              if (red.data || red.error) reset();
            }}
            balance={balance}
            balanceLabel="You hold"
            error={sent ? null : issue === "exceeds-balance" ? "This is more shares than the wallet holds." : amountIssueText(issue, "shares")}
            help={est !== null ? `Worth about ${usdc(est)} at the last mark. This is an estimate: the settling mark sets the real price.` : undefined}
            disabled={sent}
          />
          {!red.data && (
            <button type="button" className="btn btn-primary" disabled={raw === null || red.isPending || !props.wallet} onClick={() => props.wallet && red.mutate({ bookId: props.book.bookId, tranche, shares: value.trim(), wallet: props.wallet })}>
              {red.isPending ? (
                <>
                  <Spinner size={14} /> Preparing…
                </>
              ) : (
                "Prepare withdrawal request"
              )}
            </button>
          )}
          {red.error && <ErrorState compact error={red.error} />}
        </div>
        <aside className="min-w-0 rounded-card border border-line bg-surface-2/60 p-4 text-[13px]" aria-label="When it settles">
          <div className="font-semibold">When it settles</div>
          <p className="mt-1 text-ink-2">
            {tranche === "senior" || notice <= 0
              ? `${TRANCHE_NAME[tranche]} has no notice period. A request settles at the next mark (${fmtWhen(props.book.markSchedule.nextPeriodEnd)}).`
              : `Junior has a ${fmtDuration(notice)} notice period. A request becomes eligible ${fmtDuration(notice)} after you send it, then settles at the first mark after that.`}{" "}
            After it settles, collect the USDC here in a separate transaction. {CASH_WAIT_LINE}
          </p>
        </aside>
      </div>

      {red.data && (
        <div className="space-y-3">
          {sent ? (
            <Callout tone="success" title="Withdrawal requested" action={<button type="button" className="btn btn-sm" onClick={() => (setValue(""), reset())}>Request another</button>}>
              It settles at the mark of {fmtWhen(settlesSec)}. Come back to this tab after that to collect the USDC.
            </Callout>
          ) : (
            <InfoList
              rows={[
                ["Shares", `${formatAmountDisplay(parseAmount(red.data.shares, USDC_DECIMALS) ?? 0n, USDC_DECIMALS)} ${TRANCHE_NAME[tranche]}`],
                ["Eligible from", fmtWhen(eligibleSec)],
                ["Settles at the mark of", fmtWhen(settlesSec)],
                ["Value (estimate)", `${fmtUsd(red.data.indicative.valueUsd, { symbol: true })} at ${fmtSharePrice(red.data.indicative.sharePrice, 6)} per share`],
              ]}
            />
          )}
          {!sent && <p className="text-[12.5px] text-muted">{red.data.indicative.text}.</p>}
          <TxRunner txs={txs} signer={red.data.signer} onConfirmed={onConfirmed} />
          {!sent && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={reset}>
              Change the amount
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function RequestList({ p }: { p: PositionOut }) {
  const rows = p.tranches.flatMap((t) => t.redemptions.map((r) => ({ ...r, tranche: t.tranche })));
  if (rows.length === 0) return null;
  return (
    <section aria-label="Your withdrawal requests">
      <h3 className="text-[15px] font-semibold">Your withdrawal requests</h3>
      <ul className="mt-2 divide-y divide-line rounded-card border border-line">
        {rows.map((r) => {
          const s = STATUS_TEXT[r.status] ?? { label: r.status, cls: "bg-surface-2 text-ink-2" };
          return (
            <li key={`${r.tranche}-${r.requestId}-${r.requestTx}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-[13px]">
              <span className="inline-flex items-center gap-2">
                <TrancheSwatch t={r.tranche} />
                <span className="num font-medium">{fmtUsd(r.shares)}</span> {TRANCHE_NAME[r.tranche]} shares
              </span>
              <span className="text-ink-2">settles at the mark of {fmtWhen(isoToSec(r.settlesAtPeriodEnd))}</span>
              <span className={cx("rounded-full px-2.5 py-0.5 text-[12px] font-medium", s.cls)}>{s.label}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
