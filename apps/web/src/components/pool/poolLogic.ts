// Pure helpers for the Insurance Pool page (/pool): share amounts (12 decimals), the queue phase in plain words,
// request statuses and their actions, the first-loss slice against its required size, and chart series. Facts
// follow InsurancePool.sol and the API's pool router (docs/ARCHITECTURE.md §2.10). DOM-free: test/pool.test.ts.
import { type AmountIssue, amountIssue, formatAmountDisplay, formatAmountInput, parseAmount } from "../../lib/amount";
import type { PoolDepositItem, PoolPositionOut, PoolWithdrawalItem } from "../../lib/api-types";
import { DASH, bpsPct, fmtDuration, fmtWhen, isoToSec, toNum, usdRaw } from "../../lib/format";
import type { Tone } from "../../lib/limits";

/** Pool shares have 12 decimals (settlement token 6 + a virtual offset of 6). */
export const POOL_SHARE_DECIMALS = 12;
/** Protocol defaults when the live parameters are unknown (InsurancePool at deployment). */
export const DEFAULT_FIRST_LOSS_LEVEL_BPS = 1000;
export const DEFAULT_MARKET_CAP_BPS = 3000;
export const DEFAULT_PREMIUM_FLOOR_BPS = 1200;
export const DEFAULT_COOLDOWN_SEC = 7 * 86_400;
export const DEFAULT_EPOCH_SEC = 7 * 86_400;
export const DEFAULT_GRACE_SEC = 86_400;

/** "every 7 days" / "every 1 day": the live epoch length in words (review m-5: never a hard-coded "weekly"). */
export const epochEvery = (sec: number | null | undefined): string => `every ${fmtDuration(sec ?? DEFAULT_EPOCH_SEC)}`;

/** The plain-language risk box (owner's text, in the copy rules' words). */
export const POOL_RISK_LINES: readonly string[] = [
  "Each book's Junior and Senior take its losses before the pool: whatever draws a pool-funded insurance fund is first that book's loss.",
  "The pool loses only what a book cannot repay once its Junior and Senior are used up, and the treasury's first-loss slice takes that loss before depositors.",
  "Exits are queued to the next epoch and never refused, but a loss marked before your epoch is processed is shared.",
];

// ------------------------------------------------------------------ shares
/** "12.5" (API share string) -> raw shares; null when missing or malformed. */
export const sharesRaw = (s: string | null | undefined): bigint | null => (s == null ? null : parseAmount(s.trim(), POOL_SHARE_DECIMALS));

/** Grouped share amount, floored at `dp` decimals ("1,234.5678"). */
export const fmtShares = (s: string | bigint | null | undefined, dp = 4): string => {
  const raw = typeof s === "bigint" ? s : sharesRaw(s);
  return raw === null ? DASH : formatAmountDisplay(raw, POOL_SHARE_DECIMALS, dp);
};

/** Raw shares -> the decimal string pool.withdraw accepts (at most 12 decimals, no grouping). */
export const sharesInput = (raw: bigint): string => formatAmountInput(raw, POOL_SHARE_DECIMALS);

/** First problem with a typed share amount against the wallet's shares (unknown balance: not checked). */
export const withdrawSharesIssue = (value: string, held: bigint | null | undefined): AmountIssue | null =>
  amountIssue(value, { decimals: POOL_SHARE_DECIMALS, balance: held ?? null });

export function withdrawIssueText(issue: AmountIssue | null): string | null {
  if (issue === "exceeds-balance") return "This is more pool shares than the wallet holds (collect processed deposits first).";
  if (issue === "invalid") return "Enter a number of shares, for example 100 or 100.5.";
  if (issue === "zero") return "Enter a number of shares above zero.";
  return null;
}

// ------------------------------------------------------------------ queue
export type QueuePhase = "open" | "awaiting_marks" | "processable" | "idle";

export interface QueueIn {
  epoch: number;
  endsAt: string;
  ended: boolean;
  phase: QueuePhase | string;
  hasWork: boolean;
  staleBooks: number;
  graceEndsAt: string;
  nextEpochEndsAt: string;
}

export const PHASE: Record<QueuePhase, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "good" },
  awaiting_marks: { label: "Waiting for book marks", tone: "warn" },
  processable: { label: "Ready to be processed", tone: "accent" },
  idle: { label: "Nothing queued", tone: "neutral" },
};

export const phaseMeta = (p: string): { label: string; tone: Tone } => PHASE[p as QueuePhase] ?? { label: p, tone: "neutral" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The oldest unprocessed epoch in one or two plain sentences. */
export function phaseSentence(q: QueueIn, timeZone?: string): string {
  const ends = fmtWhen(isoToSec(q.endsAt), timeZone);
  switch (q.phase) {
    case "open":
      return `Epoch ${q.epoch} is open until ${ends}. A deposit or withdrawal request made now joins it, unless a cooldown pushes a withdrawal to a later epoch.`;
    case "awaiting_marks":
      return `Epoch ${q.epoch} ended on ${ends}. Its processing waits for ${plural(q.staleBooks, "pool-funded book")} to mark after that end, until ${fmtWhen(isoToSec(q.graceEndsAt), timeZone)} at the latest; then anyone can process it.`;
    case "processable":
      return `Epoch ${q.epoch} ended on ${ends} and is ready to be processed: anyone can call processEpoch, which prices its deposits and withdrawals at the share price of that moment.`;
    case "idle":
      return `Nothing is queued. The next request joins the epoch ending ${fmtWhen(isoToSec(q.nextEpochEndsAt), timeZone)}.`;
    default:
      return `Epoch ${q.epoch} ends ${ends}.`;
  }
}

// ------------------------------------------------------------------ requests
export interface RowStatus {
  label: string;
  tone: Tone;
  detail: string;
}

/** A deposit can be cancelled while queued and before its epoch ends (API flag, re-checked against the clock). */
export function canCancelDeposit(d: Pick<PoolDepositItem, "status" | "cancellable" | "epochEndsAt">, nowMs: number): boolean {
  if (d.status !== "queued" || !d.cancellable) return false;
  const end = isoToSec(d.epochEndsAt);
  return end === null || nowMs < end * 1000;
}

export const canCollectDeposit = (d: Pick<PoolDepositItem, "status" | "shares">): boolean => d.status === "ready" && (sharesRaw(d.shares) ?? 0n) > 0n;

export const canCollectWithdrawal = (w: Pick<PoolWithdrawalItem, "claimableUsd">): boolean => (usdRaw(w.claimableUsd) ?? 0n) > 0n;

export function depositStatus(d: PoolDepositItem, nowMs: number, sym: string, timeZone?: string): RowStatus {
  const when = fmtWhen(isoToSec(d.epochEndsAt), timeZone);
  switch (d.status) {
    case "queued":
      return canCancelDeposit(d, nowMs)
        ? { label: "Queued", tone: "accent", detail: `Joins epoch ${d.epoch}, ending ${when}. Cancellable until then.` }
        : { label: "Awaiting processing", tone: "warn", detail: `Epoch ${d.epoch} ended; the shares are priced when it is processed.` };
    case "ready":
      return { label: "Ready to collect", tone: "good", detail: `${fmtShares(d.shares)} shares from epoch ${d.epoch}. Collecting starts the cooldown.` };
    case "claimed":
      return { label: "Collected", tone: "neutral", detail: `Shares from epoch ${d.epoch} are in the wallet.` };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral", detail: `Refunded in ${sym}.` };
    default:
      return { label: d.status, tone: "neutral", detail: "" };
  }
}

export function withdrawalStatus(w: PoolWithdrawalItem, sym: string, timeZone?: string): RowStatus {
  const when = fmtWhen(isoToSec(w.epochEndsAt), timeZone);
  const claimable = canCollectWithdrawal(w);
  switch (w.status) {
    case "queued":
      return { label: "Queued", tone: "accent", detail: `Joins epoch ${w.epoch}, ending ${when}; priced when it is processed.` };
    case "filling":
      return {
        label: claimable ? "Partly filled" : "Filling",
        tone: claimable ? "good" : "warn",
        detail: `${fmtShares(w.filledShares)} of ${fmtShares(w.shares)} shares filled so far; the rest stays queued for the next processing and shares any loss marked before then.`,
      };
    case "filled":
      return { label: "Filled", tone: "good", detail: `Every share was filled at epoch ${w.epoch}'s processing.` };
    case "claimed":
      return { label: "Paid", tone: "neutral", detail: `Paid out in ${sym}.` };
    default:
      return { label: w.status, tone: "neutral", detail: "" };
  }
}

/** Requests that need the wallet's action now (collect shares, collect a fill). */
export function actionableCount(p: Pick<PoolPositionOut, "deposits" | "withdrawals"> | undefined | null): number {
  if (!p) return 0;
  return p.deposits.filter(canCollectDeposit).length + p.withdrawals.filter(canCollectWithdrawal).length;
}

/** Requests still in flight (queued, filling, or waiting to be collected). */
export function openRequests(p: Pick<PoolPositionOut, "deposits" | "withdrawals"> | undefined | null): { deposits: PoolDepositItem[]; withdrawals: PoolWithdrawalItem[] } {
  if (!p) return { deposits: [], withdrawals: [] };
  return {
    deposits: p.deposits.filter((d) => d.status === "queued" || d.status === "ready"),
    withdrawals: p.withdrawals.filter((w) => w.status !== "claimed" || canCollectWithdrawal(w)),
  };
}

/** The cooldown line for a wallet ("" when none is running). */
export function cooldownLine(p: Pick<PoolPositionOut, "cooldownEnds" | "inCooldown"> | undefined | null, nowMs: number, timeZone?: string): string {
  const end = isoToSec(p?.cooldownEnds);
  if (end === null || end * 1000 <= nowMs) return "";
  return `Cooldown until ${fmtWhen(end, timeZone)}: these shares cannot be transferred, and a withdrawal request made now joins the first epoch ending after that.`;
}

// ------------------------------------------------------------------ first-loss slice
export interface FirstLossView {
  /** the slice as a share of the pool (bps) */
  bps: number;
  /** the required size (bps of the pool) */
  levelBps: number;
  /** slice / required size, 0..1+ */
  fill: number;
  below: boolean;
  text: string;
}

export function firstLossView(firstLossBps: number, levelBps: number | null | undefined): FirstLossView {
  const level = levelBps && levelBps > 0 ? levelBps : DEFAULT_FIRST_LOSS_LEVEL_BPS;
  const below = firstLossBps < level;
  return {
    bps: firstLossBps,
    levelBps: level,
    fill: firstLossBps / level,
    below,
    text: below
      ? `${bpsPct(firstLossBps, 1)} of the pool, below the ${bpsPct(level)} level: new books cannot draw on the pool until the treasury tops it up`
      : `${bpsPct(firstLossBps, 1)} of the pool, at or above the ${bpsPct(level)} level`,
  };
}

// ------------------------------------------------------------------ history
export interface PricePoint {
  t: number;
  v: number;
}

export function sharePriceSeries(points: ReadonlyArray<{ ts: string; sharePriceUsd: string }>): PricePoint[] {
  return points
    .map((p) => ({ t: Date.parse(p.ts), v: toNum(p.sharePriceUsd) ?? Number.NaN }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
}

export interface FlowBar {
  day: string;
  t: number;
  premium: number;
  /** drawn below zero */
  loss: number;
  recovery: number;
}

export function flowBars(flows: ReadonlyArray<{ day: string; premiumUsd: string; lossUsd: string; recoveryUsd: string }>): FlowBar[] {
  return flows
    .map((f) => ({ day: f.day, t: Date.parse(`${f.day}T00:00:00Z`), premium: toNum(f.premiumUsd) ?? 0, loss: -(toNum(f.lossUsd) ?? 0), recovery: toNum(f.recoveryUsd) ?? 0 }))
    .filter((f) => Number.isFinite(f.t))
    .sort((a, b) => a.t - b.t);
}

/** Exact totals of the daily flows over the window (6-decimal bigints). */
export function flowTotals(flows: ReadonlyArray<{ premiumUsd: string; lossUsd: string; recoveryUsd: string }>): { premium: bigint; loss: bigint; recovery: bigint } {
  return flows.reduce(
    (a, f) => ({ premium: a.premium + (usdRaw(f.premiumUsd) ?? 0n), loss: a.loss + (usdRaw(f.lossUsd) ?? 0n), recovery: a.recovery + (usdRaw(f.recoveryUsd) ?? 0n) }),
    { premium: 0n, loss: 0n, recovery: 0n },
  );
}

/** Observed share-price change over the window, never a rate: "+1.23% (1.000000 to 1.012300)". */
export function priceChangeText(c: { startUsd: string; endUsd: string; changeBps: number } | null | undefined): string {
  if (!c) return DASH;
  const sign = c.changeBps > 0 ? "+" : "";
  return `${sign}${(c.changeBps / 100).toFixed(2)}% (${(toNum(c.startUsd) ?? 0).toFixed(6)} to ${(toNum(c.endUsd) ?? 0).toFixed(6)})`;
}

// ------------------------------------------------------------------ exposure
/** Share of a market's cap in use, 0..1 (null when the cap is unknown). */
export const capFill = (capUsedBps: number | null | undefined): number | null => (capUsedBps == null ? null : Math.max(0, capUsedBps / 10_000));

export function capTone(capUsedBps: number | null | undefined): Tone {
  if (capUsedBps == null) return "neutral";
  if (capUsedBps >= 10_000) return "critical";
  if (capUsedBps >= 8_000) return "warn";
  return "good";
}
