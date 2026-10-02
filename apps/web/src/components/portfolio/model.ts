// Portfolio maths. Pure and DOM-free (test/portfolio.test.ts): turns the API's tranche.position answer
// for every book into per-book holdings and wallet-wide totals, and wallet events into an activity
// list. Every amount is an exact bigint in base units (USDC and tranche shares both use 6 decimals).
// Nothing here estimates what the wallet paid: the API does not track a cost basis, so the page shows
// value, never profit or loss.
import { WAD, parseFixed } from "@bookrunner/shared/units";
import type { BookListItem, PositionOut } from "../../lib/api-types";
import { usdRaw } from "../../lib/format";
import { type TopUpRound, firstMarkAtOrAfter } from "../../lib/topup";

export type TrancheName = "senior" | "junior";
export const TRANCHE_ORDER: readonly TrancheName[] = ["senior", "junior"];

type PositionTranche = PositionOut["tranches"][number];

/** Redemption request status as the API reports it (anything unknown is treated as pending). */
export type RedemptionStatus = "pending" | "claimable" | "settled" | "claimed";
const STATUSES: readonly string[] = ["pending", "claimable", "settled", "claimed"];
const isStatus = (s: string): s is RedemptionStatus => STATUSES.includes(s);
export const redemptionStatus = (s: string): RedemptionStatus => (isStatus(s) ? s : "pending");

export interface RedemptionRow {
  bookId: number;
  tranche: TrancheName;
  requestId: string;
  shares: bigint;
  requestedAt: string;
  eligibleAt: string;
  /** End of the mark period that settles the request. */
  settlesAtPeriodEnd: string;
  status: RedemptionStatus;
  /** USDC the request settled for (known once a mark settled it). */
  assets: bigint | null;
  requestTx: string | null;
}

export interface TrancheHolding {
  tranche: TrancheName;
  address: string;
  /** Shares in the wallet. null: the chain read failed. */
  shares: bigint | null;
  /** Share price at the latest mark (decimal string, as the API sends it). */
  sharePrice: string;
  /** Share price as an 18-decimal integer (null when malformed). */
  sharePriceWad: bigint | null;
  /**
   * Value at the latest mark of every share the wallet owns in this tranche: shares in the wallet plus
   * allocated shares still waiting in escrow to be claimed. null: unknown.
   */
  value: bigint | null;
  /** Value of the shares in the wallet only (the API's navValueUsd). */
  heldValue: bigint | null;
  /** Value of the claimable allocation shares at the latest mark. */
  claimableSharesValue: bigint;
  /** USDC committed to a round that has not settled yet. */
  pendingDeposit: bigint;
  /** Settled allocation waiting to be claimed: shares and refunded USDC. */
  claimableShares: bigint;
  claimableRefund: bigint;
  /** USDC from settled redemptions waiting to be claimed. */
  claimableRedemption: bigint;
  /** Shares queued for redemption that no mark has settled yet. */
  queuedShares: bigint;
  redemptions: RedemptionRow[];
  depositsOpen: boolean | null;
}

export interface BookHolding {
  bookId: number;
  tranches: TrancheHolding[];
  /** Marked value of the shares the wallet owns (held and waiting to be claimed), both tranches. */
  value: bigint | null;
  pendingDeposit: bigint;
  /** Refunds plus settled redemptions, in USDC. */
  claimableUsd: bigint;
  claimableShares: bigint;
  queuedShares: bigint;
  /** Something can be claimed now (shares, refund or redemption USDC). */
  canClaim: boolean;
  /** The wallet holds shares in this book. */
  holdsShares: boolean;
  /** Anything at all: shares, a deposit, a claim or a redemption request. */
  hasPosition: boolean;
  /** "db": the chain read failed and only indexed data is shown. */
  source: "chain" | "db";
}

const big = (v: string | null | undefined): bigint => (v == null ? 0n : (usdRaw(v) ?? 0n));
const bigOrNull = (v: string | null | undefined): bigint | null => (v == null ? null : usdRaw(v));

function wadOf(price: string): bigint | null {
  try {
    return parseFixed(price, 18);
  } catch {
    return null;
  }
}

/** Value of `shares` at an 18-decimal share price (floored, like the tranche contract). */
export function sharesValue(shares: bigint, priceWad: bigint | null): bigint | null {
  return priceWad === null ? null : (shares * priceWad) / WAD;
}

function trancheHolding(bookId: number, t: PositionTranche): TrancheHolding {
  const shares = bigOrNull(t.shares);
  const claimableShares = big(t.claimableAllocation?.shares);
  const claimableRefund = big(t.claimableAllocation?.refundUsd);
  const committed = big(t.committedUsd);
  const priceWad = wadOf(t.sharePrice);
  const heldValue = bigOrNull(t.navValueUsd);
  const claimableSharesValue = sharesValue(claimableShares, priceWad) ?? 0n;
  // A commitment the round already settled shows up as a claimable allocation instead.
  const pendingDeposit = claimableShares > 0n || claimableRefund > 0n ? 0n : committed;
  const redemptions: RedemptionRow[] = t.redemptions.map((r) => ({
    bookId,
    tranche: t.tranche,
    requestId: r.requestId,
    shares: big(r.shares),
    requestedAt: r.requestedAt,
    eligibleAt: r.eligibleAt,
    settlesAtPeriodEnd: r.settlesAtPeriodEnd,
    status: redemptionStatus(r.status),
    assets: bigOrNull(r.assetsUsd),
    requestTx: r.requestTx,
  }));
  return {
    tranche: t.tranche,
    address: t.address,
    shares,
    sharePrice: t.sharePrice,
    sharePriceWad: priceWad,
    value: heldValue === null ? null : heldValue + claimableSharesValue,
    heldValue,
    claimableSharesValue,
    pendingDeposit,
    claimableShares,
    claimableRefund,
    claimableRedemption: big(t.claimableRedemptionUsd),
    queuedShares: redemptions.filter((r) => r.status === "pending").reduce((a, r) => a + r.shares, 0n),
    redemptions,
    depositsOpen: t.depositsOpen,
  };
}

/** One book's holding from its tranche.position answer (Senior first). */
export function bookHolding(p: PositionOut): BookHolding {
  const tranches = TRANCHE_ORDER.map((name) => p.tranches.find((t) => t.tranche === name))
    .filter((t): t is PositionTranche => t !== undefined)
    .map((t) => trancheHolding(p.bookId, t));
  const sum = (f: (t: TrancheHolding) => bigint) => tranches.reduce((a, t) => a + f(t), 0n);
  const value = tranches.every((t) => t.value !== null) ? sum((t) => t.value ?? 0n) : null;
  const claimableUsd = sum((t) => t.claimableRefund + t.claimableRedemption);
  const claimableShares = sum((t) => t.claimableShares);
  const pendingDeposit = sum((t) => t.pendingDeposit);
  const queuedShares = sum((t) => t.queuedShares);
  const holdsShares = tranches.some((t) => (t.shares ?? 0n) > 0n);
  const openRequests = tranches.some((t) => t.redemptions.some((r) => r.status !== "claimed"));
  const canClaim = claimableUsd > 0n || claimableShares > 0n;
  return {
    bookId: p.bookId,
    tranches,
    value,
    pendingDeposit,
    claimableUsd,
    claimableShares,
    queuedShares,
    canClaim,
    holdsShares,
    hasPosition: holdsShares || pendingDeposit > 0n || canClaim || queuedShares > 0n || openRequests,
    source: p.source,
  };
}

export interface PortfolioTotals {
  /**
   * Marked value of every share the wallet owns, including allocated shares waiting to be claimed.
   * Covers the readable tranches only: see `partial`.
   */
  value: bigint;
  senior: bigint;
  junior: bigint;
  pendingDeposit: bigint;
  claimableUsd: bigint;
  claimableShares: bigint;
  /** The part of `value` that is allocated shares still waiting to be claimed. */
  claimableSharesValue: bigint;
  queuedShares: bigint;
  /** Value of the queued shares at the latest mark (indicative: the settling mark sets the amount). */
  queuedSharesValue: bigint;
  booksWithPosition: number;
  booksClaimable: number;
  /** A tranche's balance could not be read: `value` leaves it out. */
  partial: boolean;
}

/** Wallet-wide totals over every book's holding. */
export function portfolioTotals(holdings: readonly BookHolding[]): PortfolioTotals {
  let senior = 0n;
  let junior = 0n;
  let partial = false;
  let claimableSharesValue = 0n;
  let queuedSharesValue = 0n;
  for (const h of holdings) {
    for (const t of h.tranches) {
      if (t.value === null) partial = true;
      else if (t.tranche === "senior") senior += t.value;
      else junior += t.value;
      claimableSharesValue += t.claimableSharesValue;
      queuedSharesValue += sharesValue(t.queuedShares, t.sharePriceWad) ?? 0n;
    }
  }
  const sum = (f: (h: BookHolding) => bigint) => holdings.reduce((a, h) => a + f(h), 0n);
  return {
    value: senior + junior,
    senior,
    junior,
    pendingDeposit: sum((h) => h.pendingDeposit),
    claimableUsd: sum((h) => h.claimableUsd),
    claimableShares: sum((h) => h.claimableShares),
    claimableSharesValue,
    queuedShares: sum((h) => h.queuedShares),
    queuedSharesValue,
    booksWithPosition: holdings.filter((h) => h.hasPosition).length,
    booksClaimable: holdings.filter((h) => h.canClaim).length,
    partial,
  };
}

/** Senior / Junior shares of a total, as 0..1 fractions (both 0 when there is nothing). */
export function splitFractions(senior: bigint, junior: bigint): { senior: number; junior: number } {
  const total = senior + junior;
  if (total <= 0n) return { senior: 0, junior: 0 };
  // basis-point precision is plenty for a bar
  const s = Number((senior * 10_000n) / total) / 10_000;
  return { senior: s, junior: 1 - s };
}

export interface MarkTimes {
  /** Newest and oldest mark period end (unix seconds) over the books asked for. */
  newest: number | null;
  oldest: number | null;
  /** Every book with a mark shares one period end. */
  same: boolean;
  /** Books asked for that have no mark yet. */
  unmarked: number[];
}

/** The latest mark period of the given books (the time their marked values refer to). */
export function markTimes(books: readonly Pick<BookListItem, "bookId" | "lastMark">[], bookIds: readonly number[]): MarkTimes {
  const ids = new Set(bookIds);
  const ends: number[] = [];
  const unmarked: number[] = [];
  for (const b of books) {
    if (!ids.has(b.bookId)) continue;
    if (b.lastMark) ends.push(b.lastMark.periodEnd);
    else unmarked.push(b.bookId);
  }
  if (ends.length === 0) return { newest: null, oldest: null, same: true, unmarked };
  const newest = Math.max(...ends);
  const oldest = Math.min(...ends);
  return { newest, oldest, same: newest === oldest, unmarked };
}

export type DepositSettlement =
  /** First deposit period: allocated when the subscription window closes. */
  | { kind: "window"; at: number | null }
  /** Top-up round still open: accepted at the first mark after it ends (`settlesAt`). */
  | { kind: "round"; endsAt: number; settlesAt: number }
  /**
   * The round has ended: accepted at the first mark whose period ends at or after the round end
   * (`settlesAt`; null when the round could not be read).
   */
  | { kind: "ended"; settlesAt: number | null }
  /** The round is not known yet (still loading or unreadable). */
  | { kind: "unknown" };

/** When a pending deposit in a book settles (all times unix seconds). */
export function depositSettlement(
  book: Pick<BookListItem, "state" | "subscriptionEnds" | "markSchedule">,
  round: TopUpRound | null | undefined,
  nowSec: number,
): DepositSettlement {
  if (book.state === "Subscription") {
    const at = book.subscriptionEnds ? Math.floor(Date.parse(book.subscriptionEnds) / 1000) : null;
    return { kind: "window", at: at !== null && Number.isFinite(at) ? at : null };
  }
  if (!round) return { kind: "unknown" };
  const interval = book.markSchedule?.intervalSeconds ?? null;
  const settlesAt = round.endsAt > 0 && interval ? firstMarkAtOrAfter(round.endsAt, interval) : null;
  if (round.open && round.endsAt > nowSec && settlesAt !== null) return { kind: "round", endsAt: round.endsAt, settlesAt };
  // Never "the next mark": a mark whose period closed before the round end does not settle it.
  return { kind: "ended", settlesAt: round.open ? settlesAt : null };
}

export type RedemptionStage = "notice" | "queued" | "claimable" | "settled" | "claimed";

/**
 * Where a redemption request stands. "notice": a Junior request still inside its notice period;
 * "queued": eligible, waiting for the mark that settles it; then claimable, settled or claimed.
 */
export function redemptionStage(r: Pick<RedemptionRow, "status" | "eligibleAt">, nowMs: number): RedemptionStage {
  if (r.status !== "pending") return r.status;
  const eligible = Date.parse(r.eligibleAt);
  return Number.isFinite(eligible) && nowMs < eligible ? "notice" : "queued";
}

// ------------------------------------------------------------------ activity
export type ActivityKind = "deposit" | "allocation" | "redeemRequest" | "redemptionClaim" | "refund";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  bookId: number;
  tranche: TrancheName;
  /** USDC (deposit, refund, redemption claim) or shares (allocation, redemption request), 6 decimals. */
  amount: bigint;
  unit: "USDC" | "shares";
  /** Allocation claims also return any refunded USDC. */
  refund: bigint | null;
  txHash: string | null;
  blockNumber: bigint | null;
  logIndex: number;
  /** Unix seconds (null until the block time is known). */
  timestamp: number | null;
}

/** A decoded log from one of the books' tranche contracts. */
export interface TrancheLog {
  address: string;
  eventName: string;
  args: Readonly<Record<string, unknown>>;
  transactionHash: string | null;
  blockNumber: bigint | null;
  logIndex: number | null;
}

export interface TrancheRef {
  bookId: number;
  tranche: TrancheName;
}

/** Lower-cased tranche address -> its book and tranche. */
export function trancheIndex(books: readonly { bookId: number; senior: string; junior: string }[]): Map<string, TrancheRef> {
  const m = new Map<string, TrancheRef>();
  for (const b of books) {
    m.set(b.senior.toLowerCase(), { bookId: b.bookId, tranche: "senior" });
    m.set(b.junior.toLowerCase(), { bookId: b.bookId, tranche: "junior" });
  }
  return m;
}

const asBig = (v: unknown): bigint => (typeof v === "bigint" ? v : 0n);

function logToActivity(l: TrancheLog, ref: TrancheRef): ActivityItem | null {
  const base = {
    id: `${l.transactionHash ?? "tx"}:${l.logIndex ?? 0}`,
    bookId: ref.bookId,
    tranche: ref.tranche,
    txHash: l.transactionHash,
    blockNumber: l.blockNumber,
    logIndex: l.logIndex ?? 0,
    timestamp: null,
    refund: null,
  };
  switch (l.eventName) {
    case "Committed":
      return { ...base, kind: "deposit", amount: asBig(l.args.assets), unit: "USDC" };
    case "AllocationClaimed": {
      const shares = asBig(l.args.shares);
      const refund = asBig(l.args.refund);
      // a claim with no shares is a pure refund
      // (a cancelled-round refund emits AllocationClaimed too, so CancelledRefundClaimed is not needed)
      return shares > 0n ? { ...base, kind: "allocation", amount: shares, unit: "shares", refund } : { ...base, kind: "refund", amount: refund, unit: "USDC" };
    }
    case "RedeemRequest":
      return { ...base, kind: "redeemRequest", amount: asBig(l.args.shares), unit: "shares" };
    case "RedemptionClaimed":
      return { ...base, kind: "redemptionClaim", amount: asBig(l.args.assets), unit: "USDC" };
    default:
      return null;
  }
}

const newestFirst = (a: ActivityItem, b: ActivityItem): number => {
  const ab = a.blockNumber ?? -1n;
  const bb = b.blockNumber ?? -1n;
  if (ab !== bb) return ab > bb ? -1 : 1;
  if (a.timestamp !== b.timestamp) return (b.timestamp ?? 0) - (a.timestamp ?? 0);
  return b.logIndex - a.logIndex;
};

/** Wallet activity from tranche logs: known tranches only, de-duplicated, newest first. */
export function activityFromLogs(logs: readonly TrancheLog[], index: ReadonlyMap<string, TrancheRef>, limit = 20): ActivityItem[] {
  const seen = new Set<string>();
  const out: ActivityItem[] = [];
  for (const l of logs) {
    const ref = index.get(l.address.toLowerCase());
    if (!ref) continue;
    const item = logToActivity(l, ref);
    if (!item || item.amount <= 0n || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out.sort(newestFirst).slice(0, limit);
}

/** Fallback activity from the API alone: the wallet's redemption requests (with their tx hashes). */
export function activityFromRedemptions(holdings: readonly BookHolding[], limit = 20): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const h of holdings) {
    for (const t of h.tranches) {
      for (const r of t.redemptions) {
        const ts = Date.parse(r.requestedAt);
        out.push({
          id: `req:${h.bookId}:${t.tranche}:${r.requestId}:${r.requestTx ?? r.requestedAt}`,
          kind: "redeemRequest",
          bookId: h.bookId,
          tranche: t.tranche,
          amount: r.shares,
          unit: "shares",
          refund: null,
          txHash: r.requestTx,
          blockNumber: null,
          logIndex: 0,
          timestamp: Number.isFinite(ts) ? Math.floor(ts / 1000) : null,
        });
      }
    }
  }
  return out.sort(newestFirst).slice(0, limit);
}

// ------------------------------------------------------------------ staking
export interface StakingRaw {
  staked: bigint;
  locked: bigint;
  available: bigint;
  pendingUnstake: bigint;
  /** Unix seconds when the pending unstake can be withdrawn (0 when none). */
  unstakeAvailableAt: number;
  earned: bigint;
}

export interface StakingView extends StakingRaw {
  hasStake: boolean;
  /** A cooldown is running or finished: "cooling" until availableAt, then "ready". */
  unstake: "none" | "cooling" | "ready";
}

export function stakingView(r: StakingRaw, nowSec: number): StakingView {
  const unstake = r.pendingUnstake === 0n ? "none" : nowSec >= r.unstakeAvailableAt ? "ready" : "cooling";
  return { ...r, hasStake: r.staked > 0n || r.earned > 0n, unstake };
}
