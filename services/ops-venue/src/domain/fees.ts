// Builder fee settlement -> adapter -> RevenueRouter (pure planning + saga). Orderly settles the
// builder's 50% of base taker fees into the builder account. Once per mark period ops-venue runs:
//
//   planned --earmark--> earmarked --venue request--> requested --payout--> received --pay--> paid --forward--> swept
//      adapter.sweepFees(period, amount)   builder account -> ops EOA         ops EOA -> adapter    adapter.forwardPendingFees
//
// The earmark comes FIRST: the adapter attributes its USDC principal-first, then to pending (earmarked)
// fees, anything else is vault-bound, and sweepToVault is permissionless. Fee USDC that reached the adapter
// before its earmark could be swept into the vault as capital, skipping the waterfall. Earmarking first
// also means a rejected earmark moves nothing. Every tx is recorded before its receipt is awaited.
//
// Planning is cumulative so nothing is lost:
//   pending(P) = Σ settlements(symbol, period <= P) − Σ FeesSwept(adapter) − sagas not yet earmarked
//   amount(P)  = min(pending(P), adapter.maxFeeSweepPerPeriodUsd)   (excess carries to later periods)
import type { Address, Hex } from "viem";
import type { SentTx } from "../chain";

export interface SettlementRow {
  id: string;
  symbol: string;
  amountUsd: bigint;
  period: number;
  ts: number;
}

/**
 * Symbol of a broker-wide settlement row. Orderly's GET /v1/broker/daily_fee_revenue reports the builder's
 * daily revenue per broker, not per symbol (VERIFY O11): such a row can only be attributed to a book when the
 * builder runs exactly one Orderly market.
 */
export const BROKER_WIDE = "*";

/**
 * Assigns broker-wide rows to the only symbol when exactly one is live; otherwise drops them (`dropped` > 0:
 * per-symbol attribution needs a per-symbol revenue source, so nothing is swept from them).
 */
export function attributeBrokerWide(rows: SettlementRow[], symbols: readonly string[]): { rows: SettlementRow[]; dropped: number } {
  const unique = [...new Set(symbols)];
  const out: SettlementRow[] = [];
  let dropped = 0;
  for (const r of rows) {
    if (r.symbol !== BROKER_WIDE) out.push(r);
    else if (unique.length === 1) out.push({ ...r, symbol: unique[0] as string });
    else dropped++;
  }
  return { rows: out, dropped };
}

export interface FeePlanInput {
  symbol: string;
  period: number;
  settlements: SettlementRow[];
  sweptTotalUsd: bigint;
  inFlightUsd: bigint;
  capUsd: bigint;
}

export interface FeePlan {
  amount: bigint;
  settledUpTo: bigint;
  pending: bigint;
  carried: bigint; // pending beyond the cap, left for later periods
}

export function planFeeSweep(i: FeePlanInput): FeePlan {
  const settledUpTo = i.settlements.filter((s) => s.symbol === i.symbol && s.period <= i.period).reduce((x, s) => x + s.amountUsd, 0n);
  const raw = settledUpTo - i.sweptTotalUsd - i.inFlightUsd;
  const pending = raw > 0n ? raw : 0n;
  const amount = pending < i.capUsd ? pending : i.capUsd > 0n ? i.capUsd : 0n;
  return { amount, settledUpTo, pending, carried: pending - amount };
}

/** Completed mark period labels in (afterPeriod, now], newest last. */
export function completedPeriods(nowSec: number, intervalSec: number, afterPeriod: number, max = 3): number[] {
  const last = Math.floor(nowSec / intervalSec) * intervalSec;
  const out: number[] = [];
  for (let p = last; p > afterPeriod && out.length < max; p -= intervalSec) out.unshift(p);
  return out;
}

/** Sweep a completed period P once settlement rows for >= P exist, or after the grace window. */
export function periodReady(p: { period: number; nowSec: number; graceSec: number; settlements: SettlementRow[]; symbol: string }): boolean {
  if (p.nowSec < p.period) return false;
  if (p.settlements.some((s) => s.symbol === p.symbol && s.period >= p.period)) return true;
  return p.nowSec >= p.period + p.graceSec;
}

export type FeeStage = "planned" | "earmarked" | "requested" | "received" | "paid" | "swept" | "skipped" | "failed";

export type FeeTxSlot = "earmark" | "mint" | "credit" | "withdraw" | "pay" | "forward";

export interface FeeSaga {
  key: string; // `${bookId}:${period}`
  bookId: number;
  adapter: Address;
  symbol: string;
  period: number;
  amount: string; // raw 6dp
  stage: FeeStage;
  /** adapter.sweepFees(period, amount) tx (FeesSwept): the earmark. Absent on sagas from the old order. */
  earmarkTx?: Hex;
  withdrawId?: string;
  /** ms: when the (current) venue withdrawal became due: lower bound for recognising our own earlier request */
  requestSince?: number;
  /** venue withdrawal attempts that FAILED and were re-requested (client ref suffix) */
  reqSeq?: number;
  creditTx?: Hex; // mock: builder settlement materialised on MockOrderlyVault
  withdrawTx?: Hex; // mock: builder account -> ops EOA
  payTx?: Hex; // ops EOA -> adapter
  forwardTx?: Hex;
  sweepTx?: Hex; // = earmarkTx (settlements row)
  logIndex?: number;
  /** txs broadcast by this saga, recorded before their receipts were awaited */
  txs?: Partial<Record<FeeTxSlot, SentTx>>;
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export const feeSagaKey = (bookId: number, period: number) => `${bookId}:${period}`;

export const isFeeTerminal = (s: FeeSaga) => s.stage === "swept" || s.stage === "skipped" || s.stage === "failed";

/**
 * Amount of the book's open sagas whose earmark is not yet counted in Σ FeesSwept (`earmarkedPeriods` =
 * periods with a FeesSwept log). Once earmarked, a saga's amount is part of the swept total; counting it
 * here too would subtract it twice.
 */
export function feeInFlight(sagas: FeeSaga[], bookId: number, earmarkedPeriods: ReadonlySet<number>): bigint {
  return sagas.filter((s) => s.bookId === bookId && !isFeeTerminal(s) && !earmarkedPeriods.has(s.period)).reduce((x, s) => x + BigInt(s.amount), 0n);
}

/** Earmarks of the book's other open sagas whose USDC has not been paid to the adapter yet. */
export function unpaidEarmarks(sagas: FeeSaga[], bookId: number, exceptKey: string): bigint {
  return sagas
    .filter((s) => s.bookId === bookId && s.key !== exceptKey && !isFeeTerminal(s) && s.earmarkTx !== undefined && s.stage !== "paid" && !s.payTx)
    .reduce((x, s) => x + BigInt(s.amount), 0n);
}

const FEE_FROM: Record<"earmarked" | "requested" | "received" | "paid" | "swept", readonly FeeStage[]> = {
  earmarked: ["planned", "requested"], // requested -> earmarked: the venue withdrawal FAILED, request it again
  requested: ["earmarked"],
  received: ["requested"],
  paid: ["received"],
  swept: ["paid"],
};

export function advanceFee(s: FeeSaga, to: "earmarked" | "requested" | "received" | "paid" | "swept", patch: Partial<FeeSaga>, now: number): FeeSaga {
  if (!FEE_FROM[to].includes(s.stage)) throw new Error(`fee saga ${s.key}: illegal ${s.stage} -> ${to}`);
  const next: FeeSaga = { ...s, ...patch, stage: to, attempts: 0, updatedAt: now };
  delete next.lastError;
  return next;
}
