// Stake / Unstake / Claim. The calldata for BkrnStaking is built in the browser (stakeLogic.ts; the
// API has no staking procedures) in the same PreparedTx shape the API returns, and runs through
// <TxRunner/> so wallet prompts and progress look like every other flow in the app.
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useNow } from "../../api/hooks";
import { BKRN_DECIMALS, parseAmount } from "../../lib/amount";
import type { PreparedTx } from "../../lib/api-types";
import { fmtDuration } from "../../lib/format";
import { appChain } from "../../wallet/chains";
import { TxRunner } from "../../wallet/TxRunner";
import { WalletButton } from "../../wallet/WalletButton";
import { isTestChain } from "../../wallet/network";
import { cx } from "../cx";
import { IconArrowRight } from "../icons";
import { AmountInput, Badge, Callout, Card, Spinner, Tabs, Term } from "../ui";
import { CooldownStatus } from "./StakePosition";
import {
  type StakePosition,
  bkrnNum,
  cancelUnstakeTx,
  claimTx,
  cooldownState,
  fmtBkrn,
  requestUnstakeTx,
  stakeAmountIssue,
  stakeTxs,
  unstakeAmountIssue,
  unstakeIssueText,
  withdrawTx,
} from "./stakeLogic";
import { invalidateStaking } from "./useStaking";

type Tab = "stake" | "unstake" | "claim";
type ReviewKind = "stake" | "request" | "cancel" | "withdraw" | "claim";
interface Review {
  kind: ReviewKind;
  txs: PreparedTx[];
  done: boolean;
}

const DONE_TEXT: Record<ReviewKind, string> = {
  stake: "Staked. Your stake updates within a few seconds.",
  request: "Unstake request sent. The cooldown has started.",
  cancel: "Request cancelled. That BKRN is free stake again.",
  withdraw: "Withdrawn. The BKRN is back in your wallet.",
  claim: "Claimed. The BKRN is in your wallet.",
};

export interface StakeActionsProps {
  address: string | null;
  staking: `0x${string}` | null;
  bkrn: `0x${string}` | null;
  position: StakePosition | undefined;
  positionLoading: boolean;
  walletBkrn: bigint | null | undefined;
  cooldownSec: number | null;
}

/** Numbered preview of what the wallet will ask for (before the review list appears). */
function StepsPreview(props: { items: Array<{ text: ReactNode; skipped?: boolean }> }) {
  return (
    <ol className="space-y-1.5 text-[12.5px] text-ink-2" aria-label="What your wallet will ask for">
      {props.items.map((it, i) => (
        <li key={i} className={cx("flex items-start gap-2", it.skipped && "text-muted")}>
          <span className="num mt-px inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border border-line-strong text-[10.5px] font-semibold">{i + 1}</span>
          <span>{it.text}</span>
        </li>
      ))}
    </ol>
  );
}

function NoBkrnNote() {
  return (
    <Callout tone="neutral" compact title="This wallet holds no BKRN">
      {isTestChain
        ? "BKRN has a fixed supply and no mint, so this app cannot create any. On testnet it was sent at launch to the protocol's test accounts. You can still follow every live figure on this page."
        : "Staking needs BKRN in this wallet on Robinhood Chain."}
    </Callout>
  );
}

export function StakeActions(props: StakeActionsProps) {
  const qc = useQueryClient();
  const now = useNow(10_000);
  const [tab, setTab] = useState<Tab>("stake");
  const [stakeValue, setStakeValue] = useState("");
  const [unstakeValue, setUnstakeValue] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const p = props.position;
  const connected = !!props.address;
  const ready = connected && !!p && !!props.staking && !!props.bkrn;
  const base = props.staking ? { chainId: appChain.id, staking: props.staking } : null;
  const cooldownText = props.cooldownSec === null ? "the cooldown" : fmtDuration(props.cooldownSec);

  const open = (kind: ReviewKind, txs: PreparedTx[]) => setReview({ kind, txs, done: false });
  const onConfirmed = () => {
    setReview((r) => (r ? { ...r, done: true } : r));
    void invalidateStaking(qc);
  };
  const resetReview = () => setReview(null);

  const reviewBlock = (kinds: ReviewKind[], after?: () => void) => {
    if (!review || !kinds.includes(review.kind)) return null;
    return (
      <div className="space-y-3">
        <TxRunner txs={review.txs} signer={props.address} onConfirmed={onConfirmed} />
        {review.done ? (
          <Callout
            tone="success"
            compact
            title={DONE_TEXT[review.kind]}
            action={
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  resetReview();
                  after?.();
                }}
              >
                Done
              </button>
            }
          />
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={resetReview}>
            Back to edit
          </button>
        )}
      </div>
    );
  };

  const connectPrompt = (label: string) => (
    <div className="flex flex-col items-start gap-2">
      <WalletButton label={label} />
      <span className="text-[12px] text-muted">Connecting only shares your address.</span>
    </div>
  );
  const loadingPrompt =
    props.positionLoading || !props.staking ? (
      <span className="inline-flex items-center gap-2 text-[12.5px] text-ink-2">
        <Spinner size={14} /> Reading your stake…
      </span>
    ) : (
      <span className="text-[12.5px] text-critical-ink">Your stake could not be read from the chain, so nothing can be prepared. Try again from the card above.</span>
    );

  // ---- stake
  const stakeIssue = stakeAmountIssue(stakeValue, props.walletBkrn);
  const stakeRaw = parseAmount(stakeValue, BKRN_DECIMALS);
  const needsApprove = !p || stakeRaw === null || p.allowance < stakeRaw;
  const stakeTab = (
    <div className="space-y-4">
      {connected && props.walletBkrn === 0n && <NoBkrnNote />}
      <AmountInput
        id="stake-amount"
        label="Amount to stake"
        symbol="BKRN"
        decimals={BKRN_DECIMALS}
        value={stakeValue}
        onChange={(v) => {
          setStakeValue(v);
          if (review?.kind === "stake" && !review.done) resetReview();
        }}
        balance={connected ? (props.walletBkrn ?? null) : undefined}
        balanceLabel="In wallet"
        issue={stakeIssue}
        disabled={review?.kind === "stake" && !review.done}
        help={`Staked BKRN stays yours. Getting it back takes an unstake request and a wait of ${cooldownText}.`}
      />
      {!review && (
        <StepsPreview
          items={[
            needsApprove
              ? { text: "Allow the staking contract to move this exact amount from your wallet, and nothing more." }
              : { text: "Allow the transfer: not needed, your earlier approval already covers this amount.", skipped: true },
            { text: "Stake it. From then on it counts toward your share of each buyback." },
          ]}
        />
      )}
      {reviewBlock(["stake"], () => setStakeValue(""))}
      {!review &&
        (!connected ? (
          connectPrompt("Connect a wallet to stake")
        ) : !ready ? (
          loadingPrompt
        ) : (
          <button
            type="button"
            className="btn btn-primary w-full sm:w-auto"
            disabled={stakeIssue !== null || stakeRaw === null}
            onClick={() => base && props.bkrn && stakeRaw !== null && open("stake", stakeTxs({ ...base, bkrn: props.bkrn, amount: stakeRaw, allowance: p?.allowance ?? null }))}
          >
            Review stake
            <IconArrowRight size={14} />
          </button>
        ))}
    </div>
  );

  // ---- unstake
  const unstakeIssue = unstakeAmountIssue(unstakeValue, p?.available);
  const unstakeRaw = parseAmount(unstakeValue, BKRN_DECIMALS);
  const unstakeTab = (
    <div className="space-y-4">
      {p && p.pending > 0n && (
        <PendingRequest
          pending={p.pending}
          availableAt={p.availableAt}
          cooldownSec={props.cooldownSec}
          busy={!!review}
          onWithdraw={() => base && open("withdraw", [withdrawTx({ ...base, pending: p.pending })])}
          onCancel={() => base && open("cancel", [cancelUnstakeTx({ ...base, pending: p.pending })])}
        />
      )}
      {reviewBlock(["withdraw", "cancel"])}
      {review?.kind !== "withdraw" && review?.kind !== "cancel" && (
        <>
          {p && p.pending > 0n && <h3 className="pt-1 text-[13.5px] font-semibold text-ink">Request more</h3>}
          <AmountInput
            id="unstake-amount"
            label="Amount to unstake"
            symbol="BKRN"
            decimals={BKRN_DECIMALS}
            value={unstakeValue}
            onChange={(v) => {
              setUnstakeValue(v);
              if (review?.kind === "request" && !review.done) resetReview();
            }}
            balance={connected ? (p?.available ?? null) : undefined}
            balanceLabel="Free to unstake"
            issue={unstakeIssue}
            error={unstakeIssueText(unstakeIssue, p?.available)}
            disabled={review?.kind === "request" && !review.done}
            help={`Locked bonds and BKRN already cooling down cannot be requested. After ${cooldownText} you withdraw it with one more transaction.`}
          />
          {p && p.pending > 0n && (
            <Callout tone="warn" compact>
              You already have {fmtBkrn(p.pending)} cooling down. A new request adds to it and restarts the wait of {cooldownText} for the whole amount.
            </Callout>
          )}
        </>
      )}
      {reviewBlock(["request"], () => setUnstakeValue(""))}
      {!review &&
        (!connected ? (
          connectPrompt("Connect a wallet to unstake")
        ) : !ready ? (
          loadingPrompt
        ) : (
          <button
            type="button"
            className="btn btn-primary w-full sm:w-auto"
            disabled={unstakeIssue !== null || unstakeRaw === null}
            onClick={() => base && p && unstakeRaw !== null && open("request", [requestUnstakeTx({ ...base, amount: unstakeRaw, cooldownSec: props.cooldownSec, pending: p.pending })])}
          >
            Review unstake request
            <IconArrowRight size={14} />
          </button>
        ))}
    </div>
  );

  // ---- claim
  const claimTab = (
    <div className="space-y-4">
      <div className="rounded-control border border-line bg-surface-2/70 p-4">
        <div className="text-[12px] font-medium text-ink-2">Ready to claim</div>
        <div className="num mt-1 text-[24px] font-medium tracking-[-0.02em] text-ink">
          {p ? bkrnNum(p.earned, 6) : "—"} <span className="text-[13px] text-ink-2">BKRN</span>
        </div>
      </div>
      <p className="text-[13px] text-ink-2">
        When a keeper buys BKRN back with half of the <Term id="carry">protocol carry</Term>, the staking contract shares it across all staked BKRN at that moment, in proportion to each
        stake. Claiming sends your part to your wallet. It does not touch your stake.
      </p>
      {reviewBlock(["claim"])}
      {!review &&
        (!connected ? (
          connectPrompt("Connect a wallet to claim")
        ) : !ready ? (
          loadingPrompt
        ) : (
          <button type="button" className="btn btn-primary w-full sm:w-auto" disabled={!p || p.earned === 0n} onClick={() => base && p && open("claim", [claimTx({ ...base, earned: p.earned })])}>
            {p && p.earned === 0n ? "Nothing to claim yet" : "Review claim"}
            {p && p.earned > 0n && <IconArrowRight size={14} />}
          </button>
        ))}
    </div>
  );

  const readyToWithdraw = !!p && p.pending > 0n && p.availableAt * 1000 <= now;
  return (
    <Card padding="none" className="overflow-hidden" aria-label="Stake, unstake or claim">
      <div className="px-4 pt-2 sm:px-5">
        <Tabs
          ariaLabel="Staking actions"
          value={tab}
          onChange={(id) => {
            setTab(id as Tab);
            if (!review || review.done) setReview(null);
          }}
          panelClassName="pb-5 pt-5"
          items={[
            { id: "stake", label: "Stake", content: stakeTab, disabled: !!review && !review.done && tab !== "stake" },
            {
              id: "unstake",
              label: "Unstake",
              content: unstakeTab,
              disabled: !!review && !review.done && tab !== "unstake",
              badge: p && p.pending > 0n ? <Badge tone={readyToWithdraw ? "good" : "bkrn"} size="sm">{readyToWithdraw ? "Ready" : "Cooling"}</Badge> : undefined,
            },
            {
              id: "claim",
              label: "Claim",
              content: claimTab,
              disabled: !!review && !review.done && tab !== "claim",
              badge:
                p && p.earned > 0n ? (
                  <Badge tone="bkrn" size="sm">
                    {bkrnNum(p.earned, 2)}
                    <span className="sr-only"> BKRN ready to claim</span>
                  </Badge>
                ) : undefined,
            },
          ]}
        />
      </div>
      <div className="border-t border-line bg-surface-2/60 px-4 py-3 text-[12px] text-ink-2 sm:px-5">
        {isTestChain ? (
          <>
            {appChain.name} is a <Term id="testnet">test network</Term>: BKRN here has no value. Every step opens in your wallet first; check it before you confirm.
          </>
        ) : (
          <>BKRN can lose value, and locked bonds can be slashed. Every step opens in your wallet first; check it before you confirm.</>
        )}
      </div>
    </Card>
  );
}

/** Open unstake request: countdown plus Withdraw (once the wait is over) and Cancel. */
function PendingRequest(props: { pending: bigint; availableAt: number; cooldownSec: number | null; busy: boolean; onWithdraw: () => void; onCancel: () => void }) {
  const now = useNow(1_000);
  const s = cooldownState(props.pending, props.availableAt, now / 1000, props.cooldownSec);
  return (
    <div className="space-y-3">
      <CooldownStatus pending={props.pending} availableAt={props.availableAt} cooldownSec={props.cooldownSec} />
      {!props.busy && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" disabled={s.kind !== "ready"} onClick={props.onWithdraw}>
            {s.kind === "ready" ? `Withdraw ${fmtBkrn(props.pending)}` : "Withdraw after the cooldown"}
          </button>
          <button type="button" className="btn" onClick={props.onCancel}>
            Cancel request
          </button>
        </div>
      )}
    </div>
  );
}
