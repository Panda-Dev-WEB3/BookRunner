// Insurance pool (2026-10, docs/ARCHITECTURE.md §2.10): pure helpers for the pool router. The epoch grid, the
// queue's processing status and the per-request status follow InsurancePool.sol (_openEpoch, _skipIdleEpochs,
// processEpoch's gate, _entitled, claimDeposit's pro-rata shares).
import { formatUnits, parseUnits } from "viem";
import type { PoolChainState } from "../chain/gateway";

/** Pool shares have 12 decimals (settlement token 6 + virtual offset 6). */
export const POOL_SHARE_DECIMALS = 12;

export const sharesStr = (raw: bigint): string => {
  const s = formatUnits(raw, POOL_SHARE_DECIMALS);
  return s.includes(".") ? s : `${s}.0`;
};

/** "12.5" -> raw shares (at most 12 decimals); null when malformed or not positive. */
export function parseShares(v: string): bigint | null {
  const t = v.trim();
  if (!/^\d+(\.\d{1,12})?$/.test(t)) return null;
  const raw = parseUnits(t, POOL_SHARE_DECIMALS);
  return raw > 0n ? raw : null;
}

type Queue = Pick<PoolChainState, "queue" | "params" | "depositsPending">;

/**
 * The queue as the contract sees it at `nowSec`: an idle queue (nothing escrowed, nothing queued) whose oldest epoch
 * has ended jumps to the current epoch on the grid (_skipIdleEpochs); otherwise it stays where it is.
 */
export function effectiveQueue(s: Queue, nowSec: number): { procEpoch: number; procEndsAt: number; len: number } {
  const len = s.params.epochLength;
  const { procEpoch, procEndsAt } = s.queue;
  const idle = s.queue.pendingShares === 0n && s.depositsPending === 0n;
  if (!idle || procEndsAt > nowSec || len <= 0) return { procEpoch, procEndsAt, len };
  // a pending epoch length applies on a fresh grid when the queue is idle
  const l = s.params.pendingEpochLength > 0 ? s.params.pendingEpochLength : len;
  const next = (Math.floor(nowSec / l) + 1) * l;
  const k = Math.ceil((next - procEndsAt) / l);
  return { procEpoch: procEpoch + k, procEndsAt: next, len: l };
}

/** End of `epoch` (>= the queue's oldest unprocessed epoch) on the current grid. */
export function projectedEpochEnd(q: { procEpoch: number; procEndsAt: number; len: number }, epoch: number): number {
  return q.procEndsAt + Math.max(0, epoch - q.procEpoch) * q.len;
}

/** The first unprocessed epoch ending at or after `notBeforeSec` (_openEpoch) and its end. */
export function openEpochFor(s: Queue, nowSec: number, notBeforeSec: number): { epoch: number; endsAt: number } {
  const q = effectiveQueue(s, nowSec);
  const k = q.procEndsAt >= notBeforeSec || q.len <= 0 ? 0 : Math.ceil((notBeforeSec - q.procEndsAt) / q.len);
  return { epoch: q.procEpoch + k, endsAt: q.procEndsAt + k * q.len };
}

export type QueuePhase = "open" | "awaiting_marks" | "processable" | "idle";

export interface QueueStatus {
  /** the oldest unprocessed epoch */
  epoch: number;
  endsAt: number;
  ended: boolean;
  /** something is queued in it, or older processed epochs still have unfilled withdrawals */
  hasWork: boolean;
  /** active pool-funded books not marked since its end (the epoch waits for them, up to the grace) */
  staleBooks: number;
  /** when processing no longer waits for marks */
  graceEndsAt: number;
  /** open: not ended yet; awaiting_marks: ended, waiting for books' marks (in grace); processable: anyone may process */
  phase: QueuePhase;
  /** queued deposits (USDC 6dp) and escrowed withdrawal shares of that epoch */
  depositAssets: bigint;
  withdrawShares: bigint;
}

/** processEpoch's gate: ended, and (when the epoch prices something) every active book marked after its end or grace over. */
export function queueStatus(s: PoolChainState): QueueStatus {
  const now = s.nowSec;
  const q = effectiveQueue(s, now);
  const skipped = q.procEpoch !== s.queue.procEpoch;
  const depositAssets = skipped ? 0n : s.openEpoch.depositAssets;
  const withdrawShares = skipped ? 0n : s.openEpoch.withdrawShares;
  const hasWork = !skipped && (depositAssets > 0n || withdrawShares > 0n || s.queue.fillEpoch < s.queue.procEpoch);
  const ended = q.procEndsAt <= now;
  const graceEndsAt = q.procEndsAt + s.params.processGrace;
  const stale = skipped ? 0 : s.staleBooks;
  let phase: QueuePhase;
  if (!ended) phase = "open";
  else if (!hasWork && s.queue.pendingShares === 0n && s.depositsPending === 0n) phase = "idle";
  else if (hasWork && stale > 0 && now < graceEndsAt) phase = "awaiting_marks";
  else phase = "processable";
  return { epoch: q.procEpoch, endsAt: q.procEndsAt, ended, hasWork, staleBooks: stale, graceEndsAt, phase, depositAssets, withdrawShares };
}

export interface ChainEpoch {
  shares: bigint;
  filledShares: bigint;
  assets: bigint;
  depositAssets: bigint;
  depositShares: bigint;
  endsAt: number;
  processed: boolean;
}

export type DepositStatus = "queued" | "ready" | "claimed" | "cancelled";

/** A deposit request: queued until its epoch is processed, then its shares are ready to collect. */
export function depositStatus(d: { done: boolean; dbStatus: string; assets: bigint }, ep: ChainEpoch | null): { status: DepositStatus; shares: bigint | null } {
  if (d.dbStatus === "cancelled") return { status: "cancelled", shares: null };
  if (d.done || d.dbStatus === "claimed") return { status: "claimed", shares: null };
  if (!ep?.processed) return { status: "queued", shares: null };
  const shares = ep.depositAssets === 0n ? 0n : (d.assets * ep.depositShares) / ep.depositAssets;
  return { status: "ready", shares };
}

export type WithdrawalStatus = "queued" | "filling" | "filled" | "claimed";

/** A withdrawal request: pro-rata share of what its epoch has filled (_entitled), minus what it claimed. */
export function withdrawalStatus(shares: bigint, claimed: bigint, ep: ChainEpoch | null): { status: WithdrawalStatus; entitled: bigint; filledShares: bigint } {
  if (!ep?.processed || ep.shares === 0n) return { status: "queued", entitled: 0n, filledShares: 0n };
  const entitled = (shares * ep.assets) / ep.shares;
  const filledShares = (shares * ep.filledShares) / ep.shares;
  const complete = ep.filledShares >= ep.shares;
  if (complete && claimed >= entitled) return { status: "claimed", entitled, filledShares };
  return { status: complete ? "filled" : "filling", entitled, filledShares };
}
