// When to push a price on-chain: first observation, every `intervalMs`, immediately on a move larger
// than `deviationBps`, or when the held flag flips.
import { exceedsBps } from "./aggregate";

export interface PushedState {
  price: number;
  held: boolean;
  /** wall time of the push attempt, unix ms */
  atMs: number;
}

export type PushReason = "first" | "interval" | "deviation" | "held-change";

export function pushReason(
  last: PushedState | undefined,
  next: { price: number; held: boolean },
  nowMs: number,
  o: { intervalMs: number; deviationBps: number },
): PushReason | null {
  if (!last) return "first";
  if (last.held !== next.held) return "held-change";
  if (last.price > 0 && exceedsBps(next.price, last.price, o.deviationBps)) return "deviation";
  if (nowMs - last.atMs >= o.intervalMs) return "interval";
  return null;
}

/**
 * publishedAt (unix s) acceptable to AttestedOracle (`publishedAt <= block.timestamp + 5`): wall
 * clock, but never behind the chain head (a time-warped devnet would otherwise see stale prices)
 * and never more than `maxFutureSec` ahead of it.
 */
export function publishTimestamp(wallSec: number, chainHeadSec: number | null, maxFutureSec = 4): number {
  const wall = Math.floor(wallSec);
  if (chainHeadSec === null) return wall;
  return Math.min(Math.max(wall, chainHeadSec), chainHeadSec + maxFutureSec);
}
