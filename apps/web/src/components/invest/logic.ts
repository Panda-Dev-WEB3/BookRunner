// Invest flow logic: deposit windows (subscription window or top-up round), round capacity, the
// Senior cap room, per-wallet room, amount checks, indicative share counts and plain-language
// wallet prompts. Pure and DOM-free (unit-tested in test/invest.test.ts); the components in this
// folder render it.
import { WAD, parseFixed } from "@bookrunner/shared/units";
import { type Address, type Hex, decodeFunctionData, isAddressEqual } from "viem";
import { type AmountIssue, USDC_DECIMALS, amountIssue, amountIssueText, formatAmountDisplay, parseAmount } from "../../lib/amount";
import { type TopUpRound, firstMarkAtOrAfter, isTopUpOpen } from "../../lib/topup";

export { firstMarkAtOrAfter };

export type TrancheId = "senior" | "junior";
export const TRANCHE_IDS: readonly TrancheId[] = ["senior", "junior"];
export const TRANCHE_NAME: Readonly<Record<TrancheId, string>> = { senior: "Senior", junior: "Junior" };

const BPS = 10_000;
/** Above this, Tranche.maxDeposit() means "no per-wallet cap" (it answers type(uint256).max). */
const UNCAPPED = 2n ** 255n;

// ------------------------------------------------------------------ deposit window

export interface DepositWindowInput {
  /** Book state (chain overlay when available): Subscription, Live, Retiring, Retired, Cancelled. */
  state: string;
  /** End of the subscription window (round 0), unix seconds. */
  subscriptionEndsSec: number | null;
  /** Book.topUp() for Live books; undefined while loading, null when unreadable. */
  topUp: TopUpRound | null | undefined;
  nowSec: number;
  markIntervalSec: number;
  /** BookrunnerConfig.newBooksPaused(): the guardian paused every deposit. */
  guardianPaused?: boolean | null;
  /** Tranche.paused(): deposits into this tranche are paused (sponsor or guardian). */
  tranchePaused?: boolean | null;
}

export type DepositRoundKind = "subscription" | "topup";

export type DepositWindow =
  /** Deposits are accepted now. `settlesAt`: window close (subscription) or the settling mark (top-up). */
  | { status: "open"; kind: DepositRoundKind; endsAt: number; settlesAt: number }
  /** The round ended; it settles at window close (subscription) or at the first mark whose period ends at or after the round end (top-up). */
  | { status: "settling"; kind: DepositRoundKind; endsAt: number; settlesAt: number }
  | { status: "paused"; by: "guardian" | "tranche"; kind: DepositRoundKind; endsAt: number; settlesAt: number }
  | { status: "closed"; why: "no-round" | "cancelled" | "retiring" | "retired" | "unknown" }
  | { status: "loading" };

/** Whether deposits are open for a book (and one tranche), and when the current round settles. */
export function depositWindow(i: DepositWindowInput): DepositWindow {
  let base: DepositWindow;
  if (i.state === "Subscription") {
    const endsAt = i.subscriptionEndsSec;
    if (endsAt === null) base = { status: "closed", why: "unknown" };
    else base = { status: i.nowSec < endsAt ? "open" : "settling", kind: "subscription", endsAt, settlesAt: endsAt };
  } else if (i.state === "Live") {
    if (i.topUp === undefined) return { status: "loading" };
    const r = i.topUp;
    if (!r || !r.open || r.endsAt <= 0) base = { status: "closed", why: "no-round" };
    else {
      const settlesAt = firstMarkAtOrAfter(r.endsAt, i.markIntervalSec);
      base = { status: isTopUpOpen(r, i.nowSec) ? "open" : "settling", kind: "topup", endsAt: r.endsAt, settlesAt };
    }
  } else if (i.state === "Cancelled") base = { status: "closed", why: "cancelled" };
  else if (i.state === "Retiring") base = { status: "closed", why: "retiring" };
  else if (i.state === "Retired") base = { status: "closed", why: "retired" };
  else base = { status: "closed", why: "unknown" };

  if (base.status === "open" && (i.guardianPaused || i.tranchePaused)) {
    return { status: "paused", by: i.guardianPaused ? "guardian" : "tranche", kind: base.kind, endsAt: base.endsAt, settlesAt: base.settlesAt };
  }
  return base;
}

// ------------------------------------------------------------------ capacity

export interface RoundRoom {
  capacity: bigint;
  committed: bigint;
  /** Capacity not yet committed (0 when full or oversubscribed). */
  remaining: bigint;
  /** More is committed than the capacity: every deposit will be scaled down pro-rata. */
  over: boolean;
  /** committed / capacity, clamped to 0..1 (for a progress bar). */
  filled: number;
}

/** Top-up capacity against what is committed so far this round (USDC base units). */
export function roundRoom(capacity: bigint, committed: bigint): RoundRoom {
  const remaining = capacity > committed ? capacity - committed : 0n;
  const filled = capacity > 0n ? Math.min(1, Number((committed * 10_000n) / capacity) / 10_000) : committed > 0n ? 1 : 0;
  return { capacity, committed, remaining, over: committed > capacity, filled };
}

/**
 * Senior room under the charter's Senior cap: after a round, Senior NAV may be at most capBps of the
 * book, i.e. S' <= J' * c / (1 - c) (Book._seniorTopUpRoom). An estimate from marked NAVs: the
 * settling mark's NAVs (and the Junior accepted in the same round) decide the real room.
 * Returns null when the cap does not bind (cap at 100%).
 */
export function seniorCapRoom(seniorNav: bigint, juniorNav: bigint, capBps: number): bigint | null {
  if (!Number.isFinite(capBps) || capBps >= BPS) return null;
  if (capBps <= 0) return 0n;
  const c = BigInt(Math.floor(capBps));
  const limit = (juniorNav * c) / (BigInt(BPS) - c);
  return limit > seniorNav ? limit - seniorNav : 0n;
}

/**
 * Senior room left in a top-up round (estimate): the Senior cap room at the marked NAVs, counting
 * the Junior committed so far (up to its capacity: Junior settles first at the mark), minus the
 * Senior already committed this round. null when the cap does not bind.
 */
export function seniorRoundRoom(i: { seniorNav: bigint; juniorNav: bigint; capBps: number; senior: RoundRoom; junior: RoundRoom | null }): bigint | null {
  const juniorIn = i.junior ? (i.junior.committed < i.junior.capacity ? i.junior.committed : i.junior.capacity) : 0n;
  const room = seniorCapRoom(i.seniorNav, i.juniorNav + juniorIn, i.capBps);
  if (room === null) return null;
  return room > i.senior.committed ? room - i.senior.committed : 0n;
}

/** USDC of Senior room each 1 USDC of accepted Junior adds (c / (1 - c)); null when uncapped. */
export function seniorRoomPerJunior(capBps: number): number | null {
  if (!Number.isFinite(capBps) || capBps >= BPS || capBps <= 0) return null;
  return capBps / (BPS - capBps);
}

/**
 * Room left under the per-wallet cap from Tranche.maxDeposit(wallet): null = no cap for this wallet
 * (uncapped book or the sponsor), undefined = unknown (not read yet, unreadable, or 0 because the
 * round is closed rather than because the cap is used up).
 */
export function walletRoom(maxDeposit: bigint | null | undefined, committed: bigint | null | undefined, capRaw: bigint | null | undefined): bigint | null | undefined {
  if (maxDeposit == null) return undefined;
  if (maxDeposit >= UNCAPPED) return null;
  if (maxDeposit === 0n) {
    const capUsedUp = capRaw != null && capRaw > 0n && committed != null && committed >= capRaw;
    return capUsedUp ? 0n : undefined;
  }
  return maxDeposit;
}

const minOf = (xs: Array<bigint | null | undefined>): bigint | null => {
  let m: bigint | null = null;
  for (const x of xs) if (x !== null && x !== undefined && (m === null || x < m)) m = x;
  return m;
};

// ------------------------------------------------------------------ amount checks

export interface DepositCheckInput {
  tranche: TrancheId;
  /** Wallet USDC balance (undefined while loading, null when unreadable). */
  balance: bigint | null | undefined;
  /** Room under the per-wallet cap (null: no cap; undefined: unknown). */
  walletRoom: bigint | null | undefined;
  /** Top-up capacity left this round (null: no top-up capacity applies, e.g. a subscription window). */
  capacityRemaining: bigint | null;
  /** Estimated Senior room under the Senior cap (Senior only; null: not binding or unknown). */
  seniorRoom?: bigint | null;
  /** The charter's Senior cap, for the message. */
  seniorCapBps?: number | null;
}

export interface DepositCheck {
  raw: bigint | null;
  issue: AmountIssue | null;
  /** Blocking problem, in plain words (null when the amount can be deposited or nothing is typed). */
  error: string | null;
  /** Non-blocking notes (oversubscription, Senior cap). */
  warnings: string[];
  /** What the Max button fills: min(balance, wallet room, capacity left when there is some). */
  max: bigint | null;
}

const usdc = (raw: bigint) => `${formatAmountDisplay(raw, USDC_DECIMALS)} USDC`;

/** Validates a typed deposit amount. Wallet cap and balance block; capacity limits only warn. */
export function checkDeposit(value: string, i: DepositCheckInput): DepositCheck {
  const walletRoom = i.walletRoom ?? null;
  const issue = amountIssue(value, { decimals: USDC_DECIMALS, balance: i.balance ?? null, max: walletRoom });
  const raw = issue === null ? parseAmount(value, USDC_DECIMALS) : null;
  let error: string | null = null;
  if (issue === "above-max" && walletRoom !== null) {
    error = walletRoom === 0n ? "You have reached the per-wallet cap for this round." : `Above the per-wallet cap: you can add at most ${usdc(walletRoom)} in this round.`;
  } else error = amountIssueText(issue, "USDC");

  const warnings: string[] = [];
  if (raw !== null && i.capacityRemaining !== null && raw > i.capacityRemaining) {
    warnings.push(
      i.capacityRemaining === 0n
        ? "This round's capacity is already fully committed. If it ends that way, every deposit is scaled down pro-rata and the rest is refunded at settlement."
        : `More than the ${usdc(i.capacityRemaining)} of capacity left. If the round ends oversubscribed, every deposit is scaled down pro-rata and the rest is refunded at settlement.`,
    );
  }
  if (raw !== null && i.tranche === "senior" && i.seniorRoom != null && raw > i.seniorRoom) {
    warnings.push(
      `Senior can only grow by about ${usdc(i.seniorRoom)} before it reaches ${i.seniorCapBps != null ? `${pctOfBps(i.seniorCapBps)} of the book` : "its cap"} (estimate from the last mark). Senior above that room is refunded at settlement, unless more Junior comes in.`,
    );
  }
  const capLeft = i.capacityRemaining !== null && i.capacityRemaining > 0n ? i.capacityRemaining : null;
  const max = i.balance == null ? null : minOf([i.balance, walletRoom, capLeft]);
  return { raw, issue, error, warnings, max };
}

// ------------------------------------------------------------------ shares

/** Share price string ("1.000258004163265306") -> WAD (null when missing / not positive). */
export function priceWad(sharePrice: string | null | undefined): bigint | null {
  if (!sharePrice) return null;
  try {
    const w = parseFixed(sharePrice, 18);
    return w > 0n ? w : null;
  } catch {
    return null;
  }
}

/** Shares a deposit would get at `sharePrice` (6 decimals, floored). Indicative only. */
export function indicativeShares(amountRaw: bigint, sharePrice: string | null | undefined): bigint | null {
  const p = priceWad(sharePrice);
  return p === null ? null : (amountRaw * WAD) / p;
}

/** USDC value of shares at `sharePrice` (6 decimals, floored). Indicative only. */
export function sharesValue(sharesRaw: bigint, sharePrice: string | null | undefined): bigint | null {
  const p = priceWad(sharePrice);
  return p === null ? null : (sharesRaw * p) / WAD;
}

// ------------------------------------------------------------------ positions

export interface TranchePositionLike {
  tranche: TrancheId;
  shares: string | null;
  committedUsd: string | null;
  claimableAllocation: { shares: string; refundUsd: string } | null;
  claimableRedemptionUsd: string | null;
  redemptions: Array<{ status: string }>;
}

const positive = (v: string | null | undefined): boolean => {
  if (!v) return false;
  try {
    return parseFixed(v, USDC_DECIMALS) > 0n;
  } catch {
    return false;
  }
};

export interface PositionFlags {
  hasShares: boolean;
  /** USDC committed to the current round, waiting for settlement. */
  hasCommitted: boolean;
  /** Settled allocation (shares and/or refund) waiting to be claimed. */
  allocationToClaim: boolean;
  /** Settled withdrawals (USDC) waiting to be claimed. */
  redemptionToClaim: boolean;
  pendingRequests: number;
  anything: boolean;
}

/** What a wallet holds in one book, summarised for badges and the Withdraw tab. */
export function positionFlags(tranches: TranchePositionLike[]): PositionFlags {
  const hasShares = tranches.some((t) => positive(t.shares));
  const hasCommitted = tranches.some((t) => positive(t.committedUsd));
  const allocationToClaim = tranches.some((t) => !!t.claimableAllocation && (positive(t.claimableAllocation.shares) || positive(t.claimableAllocation.refundUsd)));
  const redemptionToClaim = tranches.some((t) => positive(t.claimableRedemptionUsd));
  const pendingRequests = tranches.reduce((n, t) => n + t.redemptions.filter((r) => r.status === "pending").length, 0);
  return {
    hasShares,
    hasCommitted,
    allocationToClaim,
    redemptionToClaim,
    pendingRequests,
    anything: hasShares || hasCommitted || allocationToClaim || redemptionToClaim || pendingRequests > 0,
  };
}

// ------------------------------------------------------------------ wallet prompts

const PROMPT_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "requestRedeem",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "controller", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  { type: "function", name: "claimAllocation", stateMutability: "nonpayable", inputs: [{ name: "wallet", type: "address" }], outputs: [{ name: "shares", type: "uint256" }, { name: "refund", type: "uint256" }] },
  { type: "function", name: "claimRedemption", stateMutability: "nonpayable", inputs: [{ name: "controller", type: "address" }, { name: "receiver", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "claimCancelledRefund", stateMutability: "nonpayable", inputs: [{ name: "wallet", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

export interface PromptContext {
  /** Display ticker of the book ("NVDA"). */
  book: string;
  /** Tranche addresses of the book, to name the tranche a call goes to. */
  tranches: { senior: Address; junior: Address };
  /** When the round settles (deposits), already formatted. */
  settlesText?: string | null;
  /** When a withdrawal request becomes payable, already formatted. */
  eligibleText?: string | null;
}

function trancheOf(addr: Address, ctx: PromptContext): string {
  if (isAddressEqual(addr, ctx.tranches.senior)) return `${ctx.book} Senior`;
  if (isAddressEqual(addr, ctx.tranches.junior)) return `${ctx.book} Junior`;
  return `${ctx.book} tranche`;
}

const shares = (raw: bigint) => formatAmountDisplay(raw, USDC_DECIMALS, 2);

/**
 * The plain-language sentence for one prepared transaction, decoded from its calldata. Falls back
 * to the API's own description for any call it does not recognise.
 */
function decodePrompt(data: string) {
  try {
    return decodeFunctionData({ abi: PROMPT_ABI, data: data as Hex });
  } catch {
    return null;
  }
}

export function promptText(tx: { to: string; data: string; description: string }, ctx: PromptContext): string {
  const decoded = decodePrompt(tx.data);
  if (!decoded) return tx.description;
  const to = tx.to as Address;
  switch (decoded.functionName) {
    case "approve": {
      const [spender, amount] = decoded.args;
      return `Allow ${trancheOf(spender, ctx)} to move up to ${usdc(amount)} from your wallet. This only sets a spending limit: no USDC moves yet.`;
    }
    case "deposit": {
      const [assets] = decoded.args;
      const when = ctx.settlesText ? ` It waits there until the round settles (${ctx.settlesText}).` : " It waits there until the round settles.";
      return `Deposit ${usdc(assets)} into ${trancheOf(to, ctx)}.${when}`;
    }
    case "requestRedeem": {
      const [n] = decoded.args;
      const when = ctx.eligibleText ? ` at the first mark on or after ${ctx.eligibleText}` : " at the first mark after the notice period";
      return `Ask to withdraw ${shares(n)} ${trancheOf(to, ctx)} shares. They wait in the withdrawal queue and are paid${when}, at that mark's share price.`;
    }
    case "claimAllocation":
      return `Collect your ${trancheOf(to, ctx)} shares from the settled round, plus any USDC refund.`;
    case "claimRedemption":
      return `Collect the USDC from your settled ${trancheOf(to, ctx)} withdrawals.`;
    case "claimCancelledRefund":
      return `Take back your full ${trancheOf(to, ctx)} deposit: the round was cancelled.`;
    default:
      return tx.description;
  }
}

/** Prepared transactions with plain-language descriptions (what each wallet prompt does). */
export function withPlainPrompts<T extends { to: string; data: string; description: string }>(txs: T[], ctx: PromptContext): T[] {
  return txs.map((t) => ({ ...t, description: promptText(t, ctx) }));
}

// ------------------------------------------------------------------ terms

/** Senior's and Junior's share of each distribution after expenses and carry (bps). */
export function distributionShares(seniorHurdleBps: number): { senior: number; junior: number } {
  const s = Math.max(0, Math.min(BPS, Math.round(seniorHurdleBps)));
  return { senior: s, junior: BPS - s };
}

/** "60%" / "12.5%" from basis points. */
export function pctOfBps(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return "—";
  const v = bps / 100;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "")}%`;
}
