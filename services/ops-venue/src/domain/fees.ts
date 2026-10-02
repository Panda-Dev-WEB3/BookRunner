// Builder fee settlement -> adapter.sweepFees (pure planning). Orderly settles the builder's 50% of
// base taker fees into the builder account; ops-venue withdraws it to the book's adapter and calls
// sweepFees(period, amount) once per mark period. Planning is cumulative so nothing is lost:
//   pending(P) = Σ settlements(symbol, period <= P) − Σ FeesSwept(adapter) − in-flight sagas
//   amount(P)  = min(pending(P), adapter.maxFeeSweepPerPeriodUsd)   (excess carries to later periods)
import type { Address, Hex } from "viem";

export interface SettlementRow {
  id: string;
  symbol: string;
  amountUsd: bigint;
  period: number;
  ts: number;
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

export type FeeStage = "planned" | "requested" | "paid" | "swept" | "skipped" | "failed";

export interface FeeSaga {
  key: string; // `${bookId}:${period}`
  bookId: number;
  adapter: Address;
  symbol: string;
  period: number;
  amount: string; // raw 6dp
  stage: FeeStage;
  withdrawId?: string;
  creditTx?: Hex;
  withdrawTx?: Hex; // mock: builder account -> ops EOA
  payTx?: Hex;
  sweepTx?: Hex;
  logIndex?: number;
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export const feeSagaKey = (bookId: number, period: number) => `${bookId}:${period}`;

export function feeInFlight(sagas: FeeSaga[], bookId: number): bigint {
  return sagas.filter((s) => s.bookId === bookId && (s.stage === "planned" || s.stage === "requested" || s.stage === "paid")).reduce((x, s) => x + BigInt(s.amount), 0n);
}

const FEE_NEXT: Record<"requested" | "paid" | "swept", FeeStage> = { requested: "planned", paid: "requested", swept: "paid" };

export function advanceFee(s: FeeSaga, to: "requested" | "paid" | "swept", patch: Partial<FeeSaga>, now: number): FeeSaga {
  if (s.stage !== FEE_NEXT[to]) throw new Error(`fee saga ${s.key}: illegal ${s.stage} -> ${to}`);
  const next: FeeSaga = { ...s, ...patch, stage: to, attempts: 0, updatedAt: now };
  delete next.lastError;
  return next;
}
