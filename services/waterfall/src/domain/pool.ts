// Insurance pool epoch processing decision (pure; 2026-10, docs/ARCHITECTURE.md §2.10). Mirrors the gate of
// InsurancePool.processEpoch: the oldest unprocessed epoch must have ended; when it prices something (its queued
// deposits / escrowed withdrawals, or older processed epochs with unfilled withdrawals) every active pool-funded book
// must have marked with periodEnd >= its end, or `processGrace` must have passed (EpochProcessedStale). An idle queue
// (nothing escrowed, nothing queued) skips ended epochs by itself: nothing to send.

export interface PoolQueueSnapshot {
  nowSec: number;
  procEpoch: number;
  procEndsAt: number;
  fillEpoch: number;
  /** withdrawal shares escrowed, not yet filled (all epochs) */
  pendingShares: bigint;
  /** queued deposits not processed yet (all epochs) */
  depositsPending: bigint;
  /** the oldest unprocessed epoch's own queue */
  epochDepositAssets: bigint;
  epochWithdrawShares: bigint;
  /** active books not marked since procEndsAt, and which */
  staleBooks: number;
  staleBookIds: number[];
  processGrace: number;
}

export type EpochPlan =
  | { kind: "process"; epoch: number; stale: boolean }
  | { kind: "wait"; reason: "idle" | "open" | "awaiting_marks"; epoch: number; until: number | null };

export function planEpoch(s: PoolQueueSnapshot): EpochPlan {
  const epoch = s.procEpoch;
  if (s.pendingShares === 0n && s.depositsPending === 0n) return { kind: "wait", reason: "idle", epoch, until: null };
  if (s.procEndsAt > s.nowSec) return { kind: "wait", reason: "open", epoch, until: s.procEndsAt };
  const gated = s.epochDepositAssets > 0n || s.epochWithdrawShares > 0n || s.fillEpoch < s.procEpoch;
  if (!gated || s.staleBooks === 0) return { kind: "process", epoch, stale: false };
  const graceEnds = s.procEndsAt + s.processGrace;
  if (s.nowSec < graceEnds) return { kind: "wait", reason: "awaiting_marks", epoch, until: graceEnds };
  return { kind: "process", epoch, stale: true };
}
