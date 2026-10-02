// Steps 2 and 3 of the deposit flow. Amount: AmountInput with the USDC balance, Max, the per-wallet
// cap, the room left in the round and the Senior cap room (estimate). Review: the plain-language
// summary, then tranche.subscribe prepares approve + deposit and TxRunner sends them, each wallet
// prompt described in plain words. Success: what happens next, with explorer links.
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { Address } from "viem";
import { refreshPositions, trpc } from "../../api/trpc";
import type { BookDetail } from "../../lib/api-types";
import { USDC_DECIMALS, formatAmountDisplay, normalizeAmount } from "../../lib/amount";
import { addressUrl } from "../../lib/config";
import { fmtDuration, fmtSharePrice, fmtWhen, shortHex, usdRaw } from "../../lib/format";
import { invalidateWalletBalances } from "../../wallet/balances";
import { appChain } from "../../wallet/chains";
import { TxRunner } from "../../wallet/TxRunner";
import { useOnboarding } from "../../wallet/useOnboarding";
import { WalletButton } from "../../wallet/WalletButton";
import { sameAddress, useWallet } from "../../wallet/WalletContext";
import { IconArrowRight } from "../icons";
import { SetupChecklist } from "../SetupChecklist";
import { AmountInput, Callout, ErrorState, ExternalLink, Spinner, Stepper, type StepperStep, Term } from "../ui";
import { InfoList, RiskNotice, TrancheSwatch } from "./InvestBits";
import { noCancelLine, perWalletCapText, roomFigure } from "./investCopy";
import { type DepositWindow, type RoundRoom, TRANCHE_NAME, type TrancheId, checkDeposit, indicativeShares, pctOfBps, seniorRoomPerJunior, walletRoom, withPlainPrompts } from "./logic";
import { type TrancheAddresses, invalidateInvestReads, useWalletRoom } from "./useInvestChain";

const usdc = (raw: bigint | null | undefined, dp = 2) => (raw == null ? "—" : `${formatAmountDisplay(raw, USDC_DECIMALS, dp)} USDC`);

export interface DepositContext {
  book: BookDetail;
  ticker: string;
  addrs: TrancheAddresses;
  tranche: TrancheId;
  window: DepositWindow;
  room: RoundRoom | null;
  /** Estimated Senior room under the Senior cap (null: not binding or not a top-up). */
  seniorRoom: bigint | null;
}

// ------------------------------------------------------------------ step 2: amount

export function AmountStep(props: DepositContext & { amount: string; onAmount: (v: string) => void; onBack: () => void; onReview: () => void }) {
  const w = useWallet();
  const ob = useOnboarding();
  const me = w.active?.address ?? null;
  const wr = useWalletRoom(props.addrs, me);
  const t = props.tranche;
  const name = TRANCHE_NAME[t];
  const mine = wr.data?.[t];
  const capUsd = usdRaw(props.book.charter?.perWalletCapUsd ?? null);
  const room = props.window.status === "open" ? walletRoom(mine?.maxDeposit, mine?.committed, capUsd) : undefined;
  const isSponsor = !!me && !!props.book.charter && sameAddress(props.book.charter.sponsor, me);
  const check = checkDeposit(props.amount, {
    tranche: t,
    balance: ob.balances.usdc,
    walletRoom: room,
    capacityRemaining: props.window.status === "open" && props.window.kind === "topup" ? (props.room?.remaining ?? null) : null,
    seniorRoom: t === "senior" ? props.seniorRoom : null,
    seniorCapBps: props.book.charter?.seniorCapBps ?? null,
  });
  const est = check.raw !== null ? indicativeShares(check.raw, t === "senior" ? props.book.seniorSharePrice : props.book.juniorSharePrice) : null;
  const open = props.window.status === "open";
  const canReview = open && ob.ready && check.raw !== null && check.error === null;
  const perJunior = seniorRoomPerJunior(props.book.charter?.seniorCapBps ?? 10_000);

  const back = (
    <button type="button" className="btn btn-ghost btn-sm" onClick={props.onBack}>
      Change tranche
    </button>
  );

  if (!w.active) {
    return (
      <div className="space-y-4">
        <SelectedLine t={t} ticker={props.ticker} action={back} />
        <Callout tone="info" title="Connect a wallet to enter an amount" action={<WalletButton label="Connect wallet" />}>
          Connecting only shares your address. Nothing is sent until you review it and sign in your wallet.
        </Callout>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SelectedLine t={t} ticker={props.ticker} action={back} />
      {!ob.ready && !ob.unsure && (
        <SetupChecklist compact whenReady="hide" title="Finish setting up your wallet" description="A few things are missing before you can deposit. Each step ticks itself when done." />
      )}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="min-w-0 space-y-4">
          <AmountInput
            id={`deposit-${props.book.bookId}`}
            label="Amount"
            value={props.amount}
            onChange={props.onAmount}
            balance={ob.balances.usdc}
            balanceLabel="Wallet balance"
            max={check.max}
            error={props.amount.trim() !== "" ? check.error : null}
            help={est !== null ? `About ${formatAmountDisplay(est, USDC_DECIMALS)} shares at the last marked price. This is an estimate: the settling mark sets the real price.` : "Up to 6 decimals. Max uses the smallest of your balance, your cap and the room left."}
            disabled={!open}
          />
          {check.warnings.length > 0 && (
            <Callout tone="warn" compact title="Good to know">
              <ul className="list-disc space-y-1 pl-4">
                {check.warnings.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </Callout>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-primary" disabled={!canReview} onClick={props.onReview}>
              Review deposit
              <IconArrowRight size={15} />
            </button>
            {!ob.ready && (
              <span className="text-[12.5px] text-muted">
                {ob.steps.some((s) => s.checking) ? "Checking your wallet…" : ob.unsure ? "Could not read your wallet balance; retrying…" : "Finish the setup steps above first."}
              </span>
            )}
            {ob.ready && !open && <span className="text-[12.5px] text-muted">Deposits are not open right now.</span>}
          </div>
        </div>

        <aside className="min-w-0 rounded-card border border-line bg-surface-2/60 p-4 text-[13px]" aria-label="Deposit limits">
          <div className="font-semibold text-ink">Limits for this deposit</div>
          <InfoList
            className="mt-2"
            rows={[
              ["Wallet balance", ob.balances.usdc === undefined ? "…" : usdc(ob.balances.usdc)],
              props.window.status === "open" &&
                props.window.kind === "topup" &&
                props.room && [`${name} this round`, roomFigure(props.room)],
              ["Per-wallet cap", capUsd === 0n ? "No cap" : perWalletCapText(capUsd, props.window.status === "open" && props.window.kind === "topup" ? (props.room?.capacity ?? null) : null, isSponsor)],
              mine?.committed != null && mine.committed > 0n && ["You committed this round", usdc(mine.committed)],
              room != null && !isSponsor && capUsd !== null && capUsd > 0n && ["You can still add", usdc(room)],
              t === "senior" && props.seniorRoom !== null && ["Senior cap room (estimate)", usdc(props.seniorRoom, 0)],
            ]}
          />
          {t === "senior" && props.seniorRoom !== null && (
            <p className="mt-2 text-[12px] text-ink-2">
              Senior can be at most {pctOfBps(props.book.charter?.seniorCapBps ?? null)} of the book when the round settles.
              {perJunior !== null ? ` Each 1 USDC of Junior accepted in the round adds about ${perJunior.toFixed(2)} USDC of Senior room.` : ""} Estimated from the last mark.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

function SelectedLine(props: { t: TrancheId; ticker: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-surface-2/60 px-3 py-2">
      <span className="inline-flex items-center gap-2 text-[13.5px]">
        <TrancheSwatch t={props.t} />
        <span>
          Depositing into <span className="font-semibold">{props.ticker} {TRANCHE_NAME[props.t]}</span>
        </span>
      </span>
      {props.action}
    </div>
  );
}

// ------------------------------------------------------------------ step 3: review and sign

export function ReviewStep(props: DepositContext & { amount: string; onBack: () => void; onAnother: () => void; onWithdrawTab: () => void }) {
  const w = useWallet();
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const sub = trpc.tranche.subscribe.useMutation();
  const [confirmed, setConfirmed] = useState(false);
  const asked = useRef(false);
  const me = (w.active?.address ?? null) as Address | null;
  const t = props.tranche;
  const name = TRANCHE_NAME[t];
  // The API accepts only canonical amounts ("1000", never "1000."): send and show the parsed value.
  const amountIn = normalizeAmount(props.amount, USDC_DECIMALS);
  const amountText = usdc(amountIn === null ? null : usdRaw(amountIn));
  const win = props.window;
  const settlesAt = win.status === "open" || win.status === "settling" || win.status === "paused" ? win.settlesAt : null;
  const endsAt = win.status === "open" || win.status === "settling" || win.status === "paused" ? win.endsAt : null;
  const subscription = win.status !== "closed" && win.status !== "loading" && win.kind === "subscription";
  const raw = amountIn === null ? null : usdRaw(amountIn);
  const est = raw !== null ? indicativeShares(raw, t === "senior" ? props.book.seniorSharePrice : props.book.juniorSharePrice) : null;

  const prepare = () => {
    if (!me || amountIn === null) return;
    sub.mutate({ bookId: props.book.bookId, tranche: t, amountUsd: amountIn, wallet: me });
  };
  // Prepare the transactions as soon as the review opens (the parent remounts this step when the
  // wallet, tranche or amount changes, so a prepared list always matches what is shown).
  useEffect(() => {
    if (asked.current || !me) return;
    asked.current = true;
    prepare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  const txs = useMemo(
    () =>
      sub.data
        ? withPlainPrompts(sub.data.txs, {
            book: props.ticker,
            tranches: { senior: props.addrs.senior, junior: props.addrs.junior },
            settlesText: settlesAt ? (subscription ? `when the window closes, ${fmtWhen(settlesAt)}` : `first mark on or after ${fmtWhen(settlesAt)}`) : null,
          })
        : [],
    [sub.data, props.ticker, props.addrs.senior, props.addrs.junior, settlesAt, subscription],
  );

  const onConfirmed = () => {
    setConfirmed(true);
    void invalidateWalletBalances(qc);
    void invalidateInvestReads(qc);
    refreshPositions(utils);
    void utils.book.get.invalidate({ bookId: props.book.bookId });
  };

  const sharesLine = subscription
    ? `Shares are issued at 1.00 USDC each when the subscription window closes (${fmtWhen(endsAt)}). If more is committed than the book can take, the excess is refunded.`
    : `Shares are issued at the price of the first mark after the round ends (${fmtWhen(settlesAt)}).`;

  return (
    <div className="space-y-5">
      {!confirmed && (
        <div className="rounded-card border border-line bg-surface p-4 sm:p-5">
          <div className="eyebrow mb-2">Your deposit</div>
          <p className="text-[15px] leading-relaxed text-ink sm:text-[16px]">
            You deposit <span className="num font-semibold">{amountText}</span> into{" "}
            <span className="inline-flex items-baseline gap-1.5 font-semibold">
              <TrancheSwatch t={t} className="self-center" />
              {props.ticker} {name}
            </span>
            . {sharesLine}
          </p>
          <p className="mt-2 rounded-control bg-warn/10 px-3 py-2 text-[13.5px] text-ink">
            <span className="font-semibold">Locked until settlement. </span>
            {noCancelLine(win)}
          </p>
          <p className="mt-2 text-[13.5px] text-ink-2">
            Once you hold shares, you can request a <Term id="redemptionNotice">withdrawal</Term> at any time;{" "}
            {t === "junior" && (props.book.charter?.juniorNoticeSeconds ?? 0) > 0
              ? `it settles after the ${fmtDuration(props.book.charter?.juniorNoticeSeconds ?? 0)} notice period, at the first mark after that, and you then collect the USDC in a separate transaction.`
              : "Senior has no notice period, so it settles at the next mark after you ask; you then collect the USDC in a separate transaction."}
          </p>
          <InfoList
            className="mt-4"
            rows={[
              ["Tranche", `${props.ticker} ${name}`],
              ["Amount", amountText],
              endsAt !== null && [subscription ? "Window closes" : "Round ends", fmtWhen(endsAt)],
              settlesAt !== null && !subscription && [<Term key="k" id="mark">Shares issued</Term>, `At the mark of ${fmtWhen(settlesAt)}`],
              ["Cancel before it settles", "Not possible"],
              est !== null && !subscription && ["Shares (estimate)", `about ${formatAmountDisplay(est, USDC_DECIMALS)} at ${fmtSharePrice(t === "senior" ? props.book.seniorSharePrice : props.book.juniorSharePrice, 6)}`],
              ["Withdrawals", t === "senior" ? "No notice, next mark" : `${fmtDuration(props.book.charter?.juniorNoticeSeconds ?? 0)} notice, then the next mark`],
              me && ["From wallet", shortHex(me, 6, 4)],
              ["Network", appChain.name],
            ]}
          />
          <p className="mt-3 text-[12.5px] text-ink-2">
            Shares and withdrawals are always priced at a signed mark, never at a live estimate. The price at that mark can be higher or lower than today's.
          </p>
        </div>
      )}

      {confirmed && <DepositDone {...props} amountText={amountText} me={me} settlesAt={settlesAt} endsAt={endsAt} subscription={subscription} />}

      {!confirmed && <RiskNotice compact />}

      {sub.isPending && (
        <div className="flex items-center gap-2 text-[13.5px] text-ink-2" role="status">
          <Spinner size={16} /> Preparing your transactions…
        </div>
      )}
      {sub.error && (
        <div className="space-y-3">
          <ErrorState error={sub.error} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary btn-sm" onClick={prepare}>
              Try again
            </button>
            <button type="button" className="btn btn-sm" onClick={props.onBack}>
              Change the amount
            </button>
          </div>
        </div>
      )}
      {sub.data && (
        <div className="space-y-3">
          {sub.data.warnings.length > 0 && !confirmed && (
            <Callout tone="warn" compact title="Notes on this deposit">
              <ul className="list-disc space-y-1 pl-4">
                {sub.data.warnings.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </Callout>
          )}
          {!confirmed && (
            <p className="text-[13.5px] text-ink-2">
              Your wallet will ask you to confirm{" "}
              {sub.data.txs.length === 1 ? "one transaction" : `${sub.data.txs.length} transactions, one after the other`}. Each line below says what it does: check that your wallet shows the
              same amount before you confirm.
            </p>
          )}
          <TxRunner txs={txs} signer={sub.data.signer} onConfirmed={onConfirmed} />
        </div>
      )}

      {!confirmed && (
        <div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={props.onBack}>
            Back to the amount
          </button>
        </div>
      )}
    </div>
  );
}

function DepositDone(
  props: DepositContext & { amountText: string; me: Address | null; settlesAt: number | null; endsAt: number | null; subscription: boolean; onAnother: () => void; onWithdrawTab: () => void },
) {
  const name = TRANCHE_NAME[props.tranche];
  const tranche = props.tranche === "senior" ? props.addrs.senior : props.addrs.junior;
  const steps: StepperStep[] = props.subscription
    ? [
        { id: "committed", status: "done", title: "USDC committed", description: "It waits in the tranche's escrow until the window closes, and cannot be cancelled before then." },
        { id: "close", status: "active", title: `Window closes · ${fmtWhen(props.endsAt)}`, description: "Commitments are allocated pro-rata (the sponsor first in Junior); any excess is refunded." },
        { id: "claim", status: "todo", title: "Collect your shares", description: "Shares start at 1.00 USDC each. Collect them, and any refund, from the Withdraw tab." },
      ]
    : [
        {
          id: "committed",
          status: "done",
          title: "USDC committed",
          description: "It waits in the tranche's escrow until the round settles, and cannot be cancelled or withdrawn before then. If the book retires first, the round is cancelled and the deposit is refunded in full.",
        },
        { id: "end", status: "active", title: `Round ends · ${fmtWhen(props.endsAt)}`, description: "Other allocators can still deposit until then." },
        {
          id: "mark",
          status: "todo",
          title: `First mark after the round · ${fmtWhen(props.settlesAt)}`,
          description: "The round settles at that mark's share price. If more was committed than the capacity, every deposit is scaled down pro-rata and the rest is refunded.",
        },
        { id: "claim", status: "todo", title: "Collect your shares", description: "Once the round has settled, collect your shares and any refund from the Withdraw tab." },
      ];
  return (
    <div className="space-y-4 fade-in">
      <Callout tone="success" title="Deposit confirmed">
        <span className="num">{props.amountText}</span> is committed to {props.ticker} {name}. Here is what happens next.
      </Callout>
      <div className="rounded-card border border-line bg-surface p-4 sm:p-5">
        <Stepper steps={steps} ariaLabel="What happens next" compact />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        {props.me && addressUrl(props.me) && <ExternalLink href={addressUrl(props.me) as string}>Your wallet on the explorer</ExternalLink>}
        {addressUrl(tranche) && <ExternalLink href={addressUrl(tranche) as string}>{`The ${name} tranche contract`}</ExternalLink>}
        <Link className="link" to="/portfolio">
          Open your portfolio
        </Link>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary btn-sm" onClick={props.onAnother}>
          Make another deposit
        </button>
        <button type="button" className="btn btn-sm" onClick={props.onWithdrawTab}>
          See your position
        </button>
      </div>
      <p className="text-[12.5px] text-muted">Each transaction in the list below links to the explorer.</p>
    </div>
  );
}
