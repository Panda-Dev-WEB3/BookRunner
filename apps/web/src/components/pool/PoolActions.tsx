// Deposit / Withdraw / Requests for the insurance pool. Every step is prepared by the API (pool.deposit,
// pool.withdraw, pool.cancelDeposit, pool.claimDeposit, pool.claim), verified in the browser against the pool
// address read from the chain (wallet/txVerify.ts) and sent through <TxRunner/>; the position refreshes after.
import { type ReactNode, useState } from "react";
import { useNow } from "../../api/hooks";
import { trpc } from "../../api/trpc";
import { USDC_DECIMALS, amountIssue, normalizeAmount, parseAmount } from "../../lib/amount";
import type { PoolDepositItem, PoolOverviewOut, PoolPositionOut, PoolWithdrawalItem, PreparedTx } from "../../lib/api-types";
import { fmtDuration, fmtUsd } from "../../lib/format";
import { appChain } from "../../wallet/chains";
import { isTestChain } from "../../wallet/network";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { TxRunner } from "../../wallet/TxRunner";
import { WalletButton } from "../../wallet/WalletButton";
import { cx } from "../cx";
import { IconArrowRight } from "../icons";
import { AmountInput, Badge, Callout, Card, Chip, ErrorState, Spinner, Tabs, Term } from "../ui";
import {
  DEFAULT_COOLDOWN_SEC,
  POOL_SHARE_DECIMALS,
  actionableCount,
  canCancelDeposit,
  canCollectDeposit,
  canCollectWithdrawal,
  cooldownLine,
  depositStatus,
  fmtShares,
  openRequests,
  sharesInput,
  sharesRaw,
  withdrawIssueText,
  withdrawSharesIssue,
  withdrawalStatus,
} from "./poolLogic";
import { useRefreshPool } from "./usePool";

type Tab = "deposit" | "withdraw" | "requests";

/** Notes from the API, the prepared transactions, and the confirmation once they are all mined. */
function Prepared(props: {
  txs: PreparedTx[];
  warnings: string[];
  signer: string;
  amount?: bigint | null;
  notesTitle: string;
  doneText: ReactNode;
  onDone: () => void;
  onBack: () => void;
}) {
  const refresh = useRefreshPool();
  const [done, setDone] = useState(false);
  return (
    <div className="space-y-3">
      {props.warnings.length > 0 && !done && (
        <Callout tone="neutral" compact title={props.notesTitle}>
          <ul className="list-disc space-y-1 pl-4">
            {props.warnings.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Callout>
      )}
      <TxRunner
        txs={props.txs}
        signer={props.signer}
        amount={props.amount}
        onConfirmed={() => {
          setDone(true);
          refresh();
        }}
      />
      {done ? (
        <Callout
          tone="success"
          compact
          title={props.doneText}
          action={
            <button type="button" className="btn btn-sm" onClick={props.onDone}>
              Done
            </button>
          }
        />
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" onClick={props.onBack}>
          Back
        </button>
      )}
    </div>
  );
}

function ConnectPrompt({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <WalletButton label={label} />
      <span className="text-[12px] text-muted">Connecting only shares your address.</span>
    </div>
  );
}

function Preparing() {
  return (
    <span className="inline-flex items-center gap-2 text-[12.5px] text-ink-2">
      <Spinner size={14} /> Preparing the transactions…
    </span>
  );
}

// ------------------------------------------------------------------ deposit
function DepositTab(props: { address: string | null; overview: PoolOverviewOut | undefined; walletUsdc: bigint | null | undefined }) {
  const sym = useSettlementSymbol();
  const [value, setValue] = useState("");
  const dep = trpc.pool.deposit.useMutation();
  const raw = parseAmount(value, USDC_DECIMALS);
  const issue = amountIssue(value, { balance: props.walletUsdc ?? null });
  const paused = props.overview?.paused?.deposits === true;
  const cooldown = props.overview?.params?.cooldownSeconds ?? DEFAULT_COOLDOWN_SEC;
  const locked = dep.isPending || !!dep.data;
  const reset = () => dep.reset();
  return (
    <div className="space-y-4">
      <AmountInput
        id="pool-deposit"
        label="Amount to deposit"
        value={value}
        onChange={(v) => {
          setValue(v);
          if (dep.data || dep.error) reset();
        }}
        balance={props.address ? (props.walletUsdc ?? null) : undefined}
        balanceLabel="In wallet"
        issue={issue}
        disabled={locked || paused}
        help={`Queued for the open epoch and turned into shares at the share price of its processing. Cancellable until the epoch ends.`}
      />
      {!dep.data && (
        <ol className="space-y-1.5 text-[12.5px] text-ink-2" aria-label="What your wallet will ask for">
          <li>1. If needed, allow the pool to move exactly this amount of {sym} from your wallet, and nothing more.</li>
          <li>2. Queue the deposit for the open epoch. The pool holds it apart from the books until the epoch is processed.</li>
          <li>3. After processing, collect your shares from the Requests tab. That starts a cooldown of {fmtDuration(cooldown)} before a withdrawal request can join an epoch.</li>
        </ol>
      )}
      {paused && (
        <Callout tone="warn" compact>
          New deposits are paused by the guardian. Withdrawals, claims and cancellations still work.
        </Callout>
      )}
      {dep.error && <ErrorState compact error={dep.error} />}
      {dep.isPending && <Preparing />}
      {dep.data && props.address && (
        <Prepared
          txs={dep.data.txs}
          warnings={dep.data.warnings}
          signer={props.address}
          amount={raw}
          notesTitle={`Queued for epoch ${dep.data.epoch}`}
          doneText="Deposit queued. It shows under Requests until its epoch is processed."
          onDone={() => {
            reset();
            setValue("");
          }}
          onBack={reset}
        />
      )}
      {!dep.data &&
        !dep.isPending &&
        (!props.address ? (
          <ConnectPrompt label="Connect a wallet to deposit" />
        ) : (
          <button
            type="button"
            className="btn btn-primary w-full sm:w-auto"
            disabled={paused || issue !== null || raw === null}
            onClick={() => {
              const amountUsd = normalizeAmount(value);
              if (props.address && amountUsd) dep.mutate({ wallet: props.address, amountUsd });
            }}
          >
            Review deposit
            <IconArrowRight size={14} />
          </button>
        ))}
    </div>
  );
}

// ------------------------------------------------------------------ withdraw
function WithdrawTab(props: { address: string | null; position: PoolPositionOut | undefined }) {
  const now = useNow(30_000);
  const [value, setValue] = useState("");
  const wd = trpc.pool.withdraw.useMutation();
  const held = sharesRaw(props.position?.shares);
  const raw = parseAmount(value, POOL_SHARE_DECIMALS);
  const issue = withdrawSharesIssue(value, held);
  const cd = cooldownLine(props.position, now);
  const locked = wd.isPending || !!wd.data;
  const reset = () => wd.reset();
  return (
    <div className="space-y-4">
      {props.address && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-ink-2">
          <span className="num">
            In wallet {fmtShares(props.position?.shares)} shares
            {props.position?.valueUsd ? ` · worth ${fmtUsd(props.position.valueUsd)} at the current share price` : ""}
          </span>
          {held !== null && held > 0n && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={locked} onClick={() => setValue(sharesInput(held))}>
              Max
            </button>
          )}
        </div>
      )}
      <AmountInput
        id="pool-withdraw"
        label="Shares to withdraw"
        symbol="shares"
        decimals={POOL_SHARE_DECIMALS}
        placeholder="0"
        value={value}
        onChange={(v) => {
          setValue(v);
          if (wd.data || wd.error) reset();
        }}
        issue={issue}
        error={withdrawIssueText(issue)}
        disabled={locked}
        help="A withdrawal request is never refused. It is priced when its epoch is processed, so a loss marked before then is shared."
      />
      {cd && (
        <Callout tone="neutral" compact>
          {cd}
        </Callout>
      )}
      {wd.error && <ErrorState compact error={wd.error} />}
      {wd.isPending && <Preparing />}
      {wd.data && props.address && (
        <Prepared
          txs={wd.data.txs}
          warnings={wd.data.warnings}
          signer={props.address}
          amount={raw}
          notesTitle={`Queued for epoch ${wd.data.epoch}`}
          doneText="Withdrawal queued. Collect the payout from the Requests tab once its epoch is processed."
          onDone={() => {
            reset();
            setValue("");
          }}
          onBack={reset}
        />
      )}
      {!wd.data &&
        !wd.isPending &&
        (!props.address ? (
          <ConnectPrompt label="Connect a wallet to withdraw" />
        ) : (
          <button
            type="button"
            className="btn btn-primary w-full sm:w-auto"
            disabled={issue !== null || raw === null}
            onClick={() => props.address && raw !== null && wd.mutate({ wallet: props.address, shares: sharesInput(raw) })}
          >
            Review withdrawal request
            <IconArrowRight size={14} />
          </button>
        ))}
    </div>
  );
}

// ------------------------------------------------------------------ requests
type Pending = { kind: "cancel" | "collectShares"; id: number } | { kind: "collect"; id: number };

function RequestRow(props: { kind: "Deposit" | "Withdrawal"; amount: string; status: { label: string; tone: "neutral" | "accent" | "good" | "warn" | "serious" | "critical"; detail: string }; actions?: ReactNode; children?: ReactNode }) {
  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="font-semibold text-ink">{props.kind}</span>
            <span className="num text-ink-2">{props.amount}</span>
            <Chip tone={props.status.tone}>{props.status.label}</Chip>
          </div>
          {props.status.detail && <div className="mt-0.5 text-[12px] text-ink-2">{props.status.detail}</div>}
        </div>
        {props.actions && <div className="flex shrink-0 flex-wrap gap-2">{props.actions}</div>}
      </div>
      {props.children}
    </li>
  );
}

function RequestsTab(props: { address: string | null; position: PoolPositionOut | undefined; positionLoading: boolean; positionError: unknown; onRetry: () => void }) {
  const sym = useSettlementSymbol();
  const now = useNow(15_000);
  const [pending, setPending] = useState<Pending | null>(null);
  const cancel = trpc.pool.cancelDeposit.useMutation();
  const collectShares = trpc.pool.claimDeposit.useMutation();
  const collect = trpc.pool.claim.useMutation();
  const busy = cancel.isPending || collectShares.isPending || collect.isPending;
  const clear = () => {
    setPending(null);
    cancel.reset();
    collectShares.reset();
    collect.reset();
  };
  const start = (p: Pending) => {
    if (!props.address) return;
    clear();
    setPending(p);
    if (p.kind === "cancel") cancel.mutate({ wallet: props.address, depositId: p.id });
    else if (p.kind === "collectShares") collectShares.mutate({ wallet: props.address, depositId: p.id });
    else collect.mutate({ wallet: props.address, requestId: p.id });
  };

  if (!props.address) return <ConnectPrompt label="Connect a wallet to see your requests" />;
  if (!props.position) {
    if (props.positionError) return <ErrorState compact error={props.positionError} onRetry={props.onRetry} />;
    return (
      <span className="inline-flex items-center gap-2 text-[12.5px] text-ink-2">
        <Spinner size={14} /> Reading your requests…
      </span>
    );
  }
  const open = openRequests(props.position);
  const past = {
    deposits: props.position.deposits.filter((d) => !open.deposits.includes(d)),
    withdrawals: props.position.withdrawals.filter((w) => !open.withdrawals.includes(w)),
  };

  const active = (kind: Pending["kind"], id: number) => pending?.kind === kind && pending.id === id;
  const m = pending?.kind === "cancel" ? cancel : pending?.kind === "collectShares" ? collectShares : pending?.kind === "collect" ? collect : null;
  const review = (kind: Pending["kind"], id: number, doneText: string) => {
    if (!active(kind, id) || !m) return null;
    if (m.isPending) return <Preparing />;
    if (m.error)
      return (
        <div className="space-y-2">
          <ErrorState compact error={m.error} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>
            Back
          </button>
        </div>
      );
    if (!m.data || !props.address) return null;
    return <Prepared txs={m.data.txs} warnings={m.data.warnings} signer={props.address} notesTitle="Notes" doneText={doneText} onDone={clear} onBack={clear} />;
  };
  const locked = pending !== null && (busy || !!m?.data);

  const depositRow = (d: PoolDepositItem) => {
    const s = depositStatus(d, now, sym);
    const actions = (
      <>
        {canCollectDeposit(d) && (
          <button type="button" className="btn btn-primary btn-sm" disabled={locked} onClick={() => start({ kind: "collectShares", id: d.depositId })}>
            Collect shares
          </button>
        )}
        {canCancelDeposit(d, now) && (
          <button type="button" className="btn btn-sm" disabled={locked} onClick={() => start({ kind: "cancel", id: d.depositId })}>
            Cancel
          </button>
        )}
      </>
    );
    return (
      <RequestRow key={`d${d.depositId}`} kind="Deposit" amount={`${fmtUsd(d.assetsUsd)} ${sym}`} status={s} actions={actions}>
        {review("collectShares", d.depositId, "Shares collected. Your cooldown has started.")}
        {review("cancel", d.depositId, `Deposit cancelled. The ${sym} is back in your wallet.`)}
      </RequestRow>
    );
  };
  const withdrawalRow = (w: PoolWithdrawalItem) => {
    const s = withdrawalStatus(w, sym);
    return (
      <RequestRow
        key={`w${w.requestId}`}
        kind="Withdrawal"
        amount={`${fmtShares(w.shares)} shares`}
        status={s}
        actions={
          canCollectWithdrawal(w) ? (
            <button type="button" className="btn btn-primary btn-sm" disabled={locked} onClick={() => start({ kind: "collect", id: w.requestId })}>
              Collect {fmtUsd(w.claimableUsd)} {sym}
            </button>
          ) : undefined
        }
      >
        {review("collect", w.requestId, `Collected. The ${sym} is in your wallet.`)}
      </RequestRow>
    );
  };

  return (
    <div className="space-y-4">
      {open.deposits.length + open.withdrawals.length === 0 ? (
        <p className="text-[13px] text-ink-2">No open requests. Deposits and withdrawals you queue show here until they are collected.</p>
      ) : (
        <ul className="divide-y divide-line">
          {open.deposits.map(depositRow)}
          {open.withdrawals.map(withdrawalRow)}
        </ul>
      )}
      {past.deposits.length + past.withdrawals.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[12.5px] text-ink-2">Earlier requests ({past.deposits.length + past.withdrawals.length})</summary>
          <ul className="mt-2 divide-y divide-line">
            {past.deposits.map(depositRow)}
            {past.withdrawals.map(withdrawalRow)}
          </ul>
        </details>
      )}
      {!props.position.live && <p className="text-[11.5px] text-muted">The chain could not be read just now: statuses come from the indexer and may lag by a block or two.</p>}
    </div>
  );
}

export function PoolActions(props: {
  address: string | null;
  overview: PoolOverviewOut | undefined;
  position: PoolPositionOut | undefined;
  positionLoading: boolean;
  positionError: unknown;
  onRetry: () => void;
  walletUsdc: bigint | null | undefined;
}) {
  const [tab, setTab] = useState<Tab>("deposit");
  const todo = actionableCount(props.position);
  const open = openRequests(props.position);
  const inFlight = open.deposits.length + open.withdrawals.length;
  return (
    <Card padding="none" className="overflow-hidden" aria-label="Deposit, withdraw or collect">
      <div className="px-4 pt-2 sm:px-5">
        <Tabs
          ariaLabel="Insurance pool actions"
          value={tab}
          onChange={(id) => setTab(id as Tab)}
          keepMounted
          panelClassName="pb-5 pt-5"
          items={[
            { id: "deposit", label: "Deposit", content: <DepositTab address={props.address} overview={props.overview} walletUsdc={props.walletUsdc} /> },
            { id: "withdraw", label: "Withdraw", content: <WithdrawTab address={props.address} position={props.position} /> },
            {
              id: "requests",
              label: "Requests",
              content: <RequestsTab address={props.address} position={props.position} positionLoading={props.positionLoading} positionError={props.positionError} onRetry={props.onRetry} />,
              badge:
                todo > 0 ? (
                  <Badge tone="good" size="sm">
                    {todo}
                    <span className="sr-only"> ready to collect</span>
                  </Badge>
                ) : inFlight > 0 ? (
                  <Badge tone="accent" size="sm">
                    {inFlight}
                    <span className="sr-only"> open</span>
                  </Badge>
                ) : undefined,
            },
          ]}
        />
      </div>
      <div className={cx("border-t border-line bg-surface-2/60 px-4 py-3 text-[12px] text-ink-2 sm:px-5")}>
        {isTestChain ? (
          <>
            {appChain.name} is a <Term id="testnet">test network</Term>: its settlement token has no value. Every step opens in your wallet first; check it before you confirm.
          </>
        ) : (
          <>Pool shares can lose value if a book cannot repay its insurance fund. Every step opens in your wallet first; check it before you confirm.</>
        )}
      </div>
    </Card>
  );
}
