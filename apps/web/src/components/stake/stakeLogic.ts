// Pure staking logic for the Stake page (unit-tested in test/stake.test.ts): the unstake cooldown
// state, the countdown text, amount checks, the split of a staked balance, and the prepared
// transactions for BkrnStaking (stake, requestUnstake, cancelUnstake, unstake, claimReward).
// Semantics follow contracts/src/BkrnStaking.sol:
//   staked = available + locked + pending; locked stake (bonds) cannot be unstaked;
//   requestUnstake adds to the pending amount and restarts the cooldown for all of it;
//   unstake() withdraws the whole pending amount once block.timestamp >= availableAt;
//   pending and locked stake keep counting as staked (they still share distributions).
import { bkrnStakingAbi } from "@bookrunner/shared/abi/BkrnStaking";
import { type Address, encodeFunctionData, erc20Abi, getAddress } from "viem";
import { type AmountIssue, BKRN_DECIMALS, amountIssue, formatAmountDisplay } from "../../lib/amount";
import type { PreparedTx } from "../../lib/api-types";
import { fmtDuration } from "../../lib/format";

/** On-chain position of one wallet in BkrnStaking (BKRN base units, 18 decimals). */
export interface StakePosition {
  staked: bigint;
  locked: bigint;
  /** staked - locked - pending: what can be put into an unstake request. */
  available: bigint;
  /** Amount in the unstake cooldown (0 when no request is open). */
  pending: bigint;
  /** Unix seconds when the pending amount can be withdrawn (0 when no request is open). */
  availableAt: number;
  /** Distributed BKRN the wallet can claim now. */
  earned: bigint;
  /** BKRN the staking contract may pull from the wallet (ERC-20 allowance). */
  allowance: bigint;
}

// ------------------------------------------------------------------ cooldown
export type CooldownState =
  | { kind: "none" }
  | { kind: "cooling"; amount: bigint; availableAt: number; secondsLeft: number; /** 0..1 elapsed, null when the cooldown length is unknown. */ progress: number | null }
  | { kind: "ready"; amount: bigint; availableAt: number };

/**
 * Where an unstake request stands at `nowSec`. `cooldownSec` (the contract's current cooldown)
 * only feeds the progress bar; the request's own `availableAt` decides when it is ready.
 */
export function cooldownState(pending: bigint, availableAt: number, nowSec: number, cooldownSec?: number | null): CooldownState {
  if (pending <= 0n) return { kind: "none" };
  if (nowSec >= availableAt) return { kind: "ready", amount: pending, availableAt };
  const secondsLeft = Math.max(0, Math.ceil(availableAt - nowSec));
  let progress: number | null = null;
  if (cooldownSec != null && cooldownSec > 0) progress = Math.min(1, Math.max(0, 1 - secondsLeft / cooldownSec));
  return { kind: "cooling", amount: pending, availableAt, secondsLeft, progress };
}

const pad2 = (n: number) => n.toString().padStart(2, "0");

/** Countdown text: "6d 23h 59m", "5h 04m 09s", "12m 05s", "45s". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${pad2(m)}m`;
  if (h > 0) return `${h}h ${pad2(m)}m ${pad2(sec)}s`;
  if (m > 0) return `${m}m ${pad2(sec)}s`;
  return `${sec}s`;
}

/** Screen-reader form of the countdown, updated rarely: "about 6 days 23 h left". */
export function countdownLabel(seconds: number): string {
  return seconds <= 0 ? "ready now" : `about ${fmtDuration(seconds)} left`;
}

// ------------------------------------------------------------------ amounts
/** "1,234.56" (floored; "<0.01" for dust; dash when unknown). */
export const bkrnNum = (raw: bigint | null | undefined, dp = 2): string => formatAmountDisplay(raw, BKRN_DECIMALS, dp);

/** "1,234.56 BKRN" (floored; "<0.01" for dust; dash when unknown). */
export const fmtBkrn = (raw: bigint | null | undefined, dp = 2): string => (raw == null ? "—" : `${bkrnNum(raw, dp)} BKRN`);

/** Headline form without the unit: 2,200,000e18 -> "2.2M", 12,345e18 -> "12.3K", 950.5e18 -> "950.50". */
export function fmtBkrnCompact(raw: bigint | null | undefined): string {
  if (raw == null) return "—";
  const whole = raw / 10n ** BigInt(BKRN_DECIMALS);
  const trim = (n: number, dp: number) => n.toFixed(dp).replace(/\.?0+$/, "");
  if (whole >= 1_000_000_000n) return `${trim(Number(whole / 1_000_000n) / 1_000, 2)}B`;
  if (whole >= 1_000_000n) return `${trim(Number(whole / 1_000n) / 1_000, 2)}M`;
  if (whole >= 10_000n) return `${trim(Number(whole) / 1_000, 1)}K`;
  return formatAmountDisplay(raw, BKRN_DECIMALS, 2);
}

/** First problem with a stake amount, checked against the wallet's BKRN. */
export function stakeAmountIssue(value: string, walletBalance: bigint | null | undefined): AmountIssue | null {
  return amountIssue(value, { decimals: BKRN_DECIMALS, balance: walletBalance ?? null });
}

/** First problem with an unstake request, checked against the unlocked, not-yet-requested stake. */
export function unstakeAmountIssue(value: string, available: bigint | null | undefined): AmountIssue | null {
  return amountIssue(value, { decimals: BKRN_DECIMALS, max: available ?? null });
}

/** Plain-language message for an unstake issue ("above-max" means more than the free stake). */
export function unstakeIssueText(issue: AmountIssue | null, available: bigint | null | undefined): string | null {
  if (issue === "above-max") {
    return available === 0n ? "Nothing is free to unstake: the rest is locked as a bond or already cooling down." : `You can request at most ${fmtBkrn(available ?? 0n)}. The rest is locked as a bond or already cooling down.`;
  }
  return null;
}

// ------------------------------------------------------------------ breakdown
/** a / b as a float in [0, 1] without losing bigint precision on large values. */
export function ratio(a: bigint, b: bigint): number {
  if (b <= 0n || a <= 0n) return 0;
  if (a >= b) return 1;
  return Number((a * 1_000_000n) / b) / 1_000_000;
}

export type StakePart = "available" | "pending" | "locked";

/** How a staked balance splits: free to unstake, cooling down, locked as bonds (shares of staked). */
export function stakeBreakdown(p: Pick<StakePosition, "staked" | "available" | "pending" | "locked">): Array<{ part: StakePart; amount: bigint; share: number }> {
  return (
    [
      ["available", p.available],
      ["pending", p.pending],
      ["locked", p.locked],
    ] as const
  ).map(([part, amount]) => ({ part, amount, share: ratio(amount, p.staked) }));
}

/** The wallet's share of everything staked, or null when nothing is staked in total. */
export function poolShare(staked: bigint, totalStaked: bigint | null | undefined): number | null {
  if (totalStaked == null || totalStaked <= 0n) return null;
  return ratio(staked, totalStaked);
}

/** Percent text for small shares: 0 -> "0%", 0.00004 -> "<0.01%", 0.1234 -> "12.34%". */
export function fmtShare(share: number | null): string {
  if (share == null) return "—";
  if (share <= 0) return "0%";
  if (share < 0.0001) return "<0.01%";
  return `${(share * 100).toFixed(2)}%`;
}

/**
 * Staking needs only the first three setup steps (wallet, network, gas); test USDC is for books.
 * True once those are done.
 */
export function stakeSetupDone(steps: ReadonlyArray<{ id: string; status: "done" | "active" | "todo" }>): boolean {
  const need = ["connect", "network", "gas"];
  return need.every((id) => steps.find((s) => s.id === id)?.status === "done");
}

// ------------------------------------------------------------------ prepared transactions
interface TxBase {
  chainId: number;
  staking: Address;
}

const prepared = (chainId: number, to: Address, data: PreparedTx["data"], description: string): PreparedTx => ({
  to: getAddress(to),
  data,
  value: "0",
  chainId,
  description,
});

/**
 * Approve (only when the allowance is short, and only for this exact amount) then stake.
 * The approval never grants more than the amount being staked.
 */
export function stakeTxs(p: TxBase & { bkrn: Address; amount: bigint; allowance: bigint | null | undefined }): PreparedTx[] {
  const out: PreparedTx[] = [];
  if (p.amount <= 0n) return out;
  if (p.allowance == null || p.allowance < p.amount) {
    out.push(
      prepared(
        p.chainId,
        p.bkrn,
        encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(p.staking), p.amount] }),
        `Allow the staking contract to move ${fmtBkrn(p.amount)} from your wallet (this amount only)`,
      ),
    );
  }
  out.push(prepared(p.chainId, p.staking, encodeFunctionData({ abi: bkrnStakingAbi, functionName: "stake", args: [p.amount] }), `Stake ${fmtBkrn(p.amount)}`));
  return out;
}

/** Starts (or adds to) an unstake request; the cooldown restarts for the whole pending amount. */
export function requestUnstakeTx(p: TxBase & { amount: bigint; cooldownSec: number | null; pending: bigint }): PreparedTx {
  const wait = p.cooldownSec != null ? fmtDuration(p.cooldownSec) : null;
  const total = p.pending + p.amount;
  const description =
    p.pending > 0n
      ? `Request to unstake ${fmtBkrn(p.amount)} more (${fmtBkrn(total)} pending in total; the cooldown${wait ? ` of ${wait}` : ""} restarts for all of it)`
      : `Request to unstake ${fmtBkrn(p.amount)} (withdrawable after ${wait ?? "the cooldown"})`;
  return prepared(p.chainId, p.staking, encodeFunctionData({ abi: bkrnStakingAbi, functionName: "requestUnstake", args: [p.amount] }), description);
}

/** Cancels the open unstake request; the pending amount becomes free stake again. */
export function cancelUnstakeTx(p: TxBase & { pending: bigint }): PreparedTx {
  return prepared(
    p.chainId,
    p.staking,
    encodeFunctionData({ abi: bkrnStakingAbi, functionName: "cancelUnstake" }),
    `Cancel the unstake request (${fmtBkrn(p.pending)} stays staked)`,
  );
}

/** Withdraws the whole pending amount once the cooldown is over. */
export function withdrawTx(p: TxBase & { pending: bigint }): PreparedTx {
  return prepared(p.chainId, p.staking, encodeFunctionData({ abi: bkrnStakingAbi, functionName: "unstake" }), `Withdraw ${fmtBkrn(p.pending)} to your wallet`);
}

/** Claims every BKRN distributed to this wallet so far. */
export function claimTx(p: TxBase & { earned: bigint }): PreparedTx {
  return prepared(
    p.chainId,
    p.staking,
    encodeFunctionData({ abi: bkrnStakingAbi, functionName: "claimReward" }),
    `Claim ${fmtBkrn(p.earned, 4)} distributed to stakers`,
  );
}
