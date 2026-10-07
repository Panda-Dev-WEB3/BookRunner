// Transaction steps: the API's prepared transactions and the ones this desk encodes itself (test
// USDC mint, BkrnStaking, Book.openTopUp), plus the sequential runner. Pure: the runner takes an
// executor (simulate / send / wait) so it is unit-tested without a wallet (test/txs.test.ts).
import { bkrnStakingAbi } from "@bookrunner/shared/abi/BkrnStaking";
import { bookAbi } from "@bookrunner/shared/abi/Book";
import { type Address, type Hex, encodeFunctionData, erc20Abi, getAddress, isAddress } from "viem";
import { BKRN_DECIMALS, formatAmountDisplay } from "./amount";
import { CHAIN } from "./config";
import { duration } from "./format";
import { errText, isUserRejection } from "./revert";

export interface TxStep {
  to: Address;
  data: Hex;
  value: bigint;
  description: string;
  /** Set when this step must be signed by a specific wallet (e.g. an operator's consentKey). */
  signer?: Address;
}

export interface PreparedTxLike {
  to: string;
  data: string;
  value: string;
  chainId: number;
  description: string;
  signer?: string;
}

/** API prepared txs -> steps. Refuses txs for another chain or with a value (the API never sends value). */
export function fromPrepared(txs: readonly PreparedTxLike[], chainId: number = CHAIN.id): TxStep[] {
  return txs.map((t, i) => {
    if (t.chainId !== chainId) throw new Error(`Step ${i + 1} targets chain ${t.chainId}, not ${chainId}. Nothing was sent.`);
    if (!isAddress(t.to)) throw new Error(`Step ${i + 1} has an invalid target address. Nothing was sent.`);
    if (!/^0x[0-9a-fA-F]*$/.test(t.data)) throw new Error(`Step ${i + 1} has malformed calldata. Nothing was sent.`);
    if (t.value !== "0") throw new Error(`Step ${i + 1} asks to send ETH; this desk never sends value. Nothing was sent.`);
    return {
      to: getAddress(t.to),
      data: t.data as Hex,
      value: 0n,
      description: t.description,
      ...(t.signer && isAddress(t.signer) ? { signer: getAddress(t.signer) } : {}),
    };
  });
}

// ------------------------------------------------------------------ test USDC
export const MOCK_MINT_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/** 10,000 USDC (6 decimals). */
export const TEST_USDC_AMOUNT = 10_000_000_000n;

export function mintTestUsdcStep(usdc: Address, to: Address, amount: bigint = TEST_USDC_AMOUNT): TxStep {
  const whole = amount / 1_000_000n;
  return {
    to: getAddress(usdc),
    data: encodeFunctionData({ abi: MOCK_MINT_ABI, functionName: "mint", args: [getAddress(to), amount] }),
    value: 0n,
    description: `Mint ${whole.toLocaleString("en-US")} test USDC to your wallet (testnet mock token, no value)`,
  };
}

// ------------------------------------------------------------------ staking
const fmtBkrn = (raw: bigint, dp = 2) => `${formatAmountDisplay(raw, BKRN_DECIMALS, dp)} BKRN`;

/** Approve (only when short, only this amount) then stake. */
export function stakeSteps(p: { bkrn: Address; staking: Address; amount: bigint; allowance: bigint | null }): TxStep[] {
  if (p.amount <= 0n) throw new Error("Enter an amount above zero.");
  const out: TxStep[] = [];
  if (p.allowance === null || p.allowance < p.amount) {
    out.push({
      to: getAddress(p.bkrn),
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(p.staking), p.amount] }),
      value: 0n,
      description: `Allow the staking contract to move ${fmtBkrn(p.amount)} from your wallet (this amount only)`,
    });
  }
  out.push({ to: getAddress(p.staking), data: encodeFunctionData({ abi: bkrnStakingAbi, functionName: "stake", args: [p.amount] }), value: 0n, description: `Stake ${fmtBkrn(p.amount)}` });
  return out;
}

export function requestUnstakeStep(p: { staking: Address; amount: bigint; available: bigint | null; pending: bigint; cooldownSec: number | null }): TxStep {
  if (p.amount <= 0n) throw new Error("Enter an amount above zero.");
  if (p.available !== null && p.amount > p.available) throw new Error(`At most ${fmtBkrn(p.available)} is free to unstake; the rest is locked as a bond or already cooling down.`);
  const wait = p.cooldownSec != null ? duration(p.cooldownSec) : null;
  const description =
    p.pending > 0n
      ? `Request to unstake ${fmtBkrn(p.amount)} more (${fmtBkrn(p.pending + p.amount)} pending in total; the cooldown${wait ? ` of ${wait}` : ""} restarts for all of it)`
      : `Request to unstake ${fmtBkrn(p.amount)} (withdrawable after ${wait ?? "the cooldown"})`;
  return { to: getAddress(p.staking), data: encodeFunctionData({ abi: bkrnStakingAbi, functionName: "requestUnstake", args: [p.amount] }), value: 0n, description };
}

export function cancelUnstakeStep(staking: Address, pending: bigint): TxStep {
  return { to: getAddress(staking), data: encodeFunctionData({ abi: bkrnStakingAbi, functionName: "cancelUnstake" }), value: 0n, description: `Cancel the unstake request (${fmtBkrn(pending)} stays staked)` };
}

export function withdrawUnstakedStep(staking: Address, pending: bigint): TxStep {
  return { to: getAddress(staking), data: encodeFunctionData({ abi: bkrnStakingAbi, functionName: "unstake" }), value: 0n, description: `Withdraw ${fmtBkrn(pending)} to your wallet` };
}

export function claimRewardStep(staking: Address, earned: bigint): TxStep {
  return { to: getAddress(staking), data: encodeFunctionData({ abi: bkrnStakingAbi, functionName: "claimReward" }), value: 0n, description: `Claim ${fmtBkrn(earned, 4)} distributed to stakers` };
}

// ------------------------------------------------------------------ top-up round (sponsor)
export const MAX_UINT32 = 4_294_967_295;

export function openTopUpStep(p: { book: Address; windowSeconds: number; seniorCapacityUsd: bigint; juniorCapacityUsd: bigint; maxWindowSeconds?: number | null }): TxStep {
  if (!Number.isInteger(p.windowSeconds) || p.windowSeconds <= 0 || p.windowSeconds > MAX_UINT32) throw new Error("The round window must be a whole number of seconds above zero.");
  if (p.maxWindowSeconds != null && p.windowSeconds > p.maxWindowSeconds) throw new Error(`The round window can be at most ${duration(p.maxWindowSeconds)}.`);
  if (p.seniorCapacityUsd < 0n || p.juniorCapacityUsd < 0n) throw new Error("Capacities cannot be negative.");
  if (p.seniorCapacityUsd === 0n && p.juniorCapacityUsd === 0n) throw new Error("Give at least one tranche a capacity above zero.");
  const usd = (v: bigint) => formatAmountDisplay(v, 6, 2);
  return {
    to: getAddress(p.book),
    data: encodeFunctionData({ abi: bookAbi, functionName: "openTopUp", args: [p.windowSeconds, p.seniorCapacityUsd, p.juniorCapacityUsd] }),
    value: 0n,
    description: `Open a ${duration(p.windowSeconds)} top-up round (Senior capacity ${usd(p.seniorCapacityUsd)} USDC, Junior ${usd(p.juniorCapacityUsd)} USDC); it settles at the first mark on or after the round end`,
  };
}

// ------------------------------------------------------------------ runner
export type StepStatus = "queued" | "simulating" | "signing" | "pending" | "confirmed" | "failed" | "skipped";

export interface StepItem {
  step: TxStep;
  status: StepStatus;
  hash?: Hex;
  error?: string;
}

export interface StepExecutor {
  /** Throws (with revert data in the chain) when the step would fail now. */
  simulate(step: TxStep): Promise<void>;
  send(step: TxStep): Promise<Hex>;
  wait(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
  /** The connected account (checked against step.signer). */
  account(): Address | null;
}

export const initialItems = (steps: TxStep[]): StepItem[] => steps.map((step) => ({ step, status: "queued" }));

/**
 * Runs steps in order, each simulated right before its wallet prompt (so an approval is mined before
 * the deposit that needs it is simulated). Confirmed items are skipped on a retry; a broadcast item
 * that only lost its receipt wait resumes waiting instead of sending twice. Stops at the first failure.
 */
export async function runSteps(items: StepItem[], exec: StepExecutor, onUpdate: (items: StepItem[]) => void): Promise<{ ok: boolean; items: StepItem[] }> {
  let cur = items.map((i) => (i.status === "confirmed" ? i : { ...i, status: "queued" as StepStatus, error: undefined }));
  const set = (idx: number, patch: Partial<StepItem>) => {
    cur = cur.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    onUpdate(cur);
  };
  for (let i = 0; i < cur.length; i++) {
    const item = cur[i];
    if (!item || item.status === "confirmed") continue;
    try {
      const me = exec.account();
      if (!me) throw new Error("Connect a wallet first.");
      if (item.step.signer && item.step.signer.toLowerCase() !== me.toLowerCase()) {
        throw new Error(`This step must be signed by ${item.step.signer}. Switch to that account in your wallet, then retry.`);
      }
      let hash = item.hash;
      if (!hash) {
        set(i, { status: "simulating" });
        await exec.simulate(item.step);
        set(i, { status: "signing" });
        hash = await exec.send(item.step);
      }
      set(i, { status: "pending", hash });
      const r = await exec.wait(hash);
      if (r.status !== "success") {
        set(i, { hash: undefined });
        throw new Error(`The transaction reverted in block ${r.blockNumber}.`);
      }
      set(i, { status: "confirmed" });
    } catch (e) {
      set(i, { status: isUserRejection(e) ? "skipped" : "failed", error: errText(e) });
      cur = cur.map((it, j) => (j > i && it.status !== "confirmed" ? { ...it, status: "skipped" as StepStatus } : it));
      onUpdate(cur);
      return { ok: false, items: cur };
    }
  }
  return { ok: true, items: cur };
}

export function summarize(items: StepItem[]): { done: number; total: number; failed: boolean; running: boolean; allConfirmed: boolean } {
  const done = items.filter((i) => i.status === "confirmed").length;
  return {
    done,
    total: items.length,
    failed: items.some((i) => i.status === "failed" || i.status === "skipped"),
    running: items.some((i) => i.status === "simulating" || i.status === "signing" || i.status === "pending"),
    allConfirmed: items.length > 0 && done === items.length,
  };
}
