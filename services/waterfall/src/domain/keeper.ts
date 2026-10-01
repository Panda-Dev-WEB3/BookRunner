// Keeper decisions (pure). Execution lives in keeper.ts.
import type { BookState } from "@bookrunner/shared";

export function shouldCloseWindow(state: BookState, subscriptionEnds: number, nowSec: number): boolean {
  return state === "Subscription" && subscriptionEnds > 0 && nowSec >= subscriptionEnds;
}

export function shouldFundClaims(state: BookState, unfundedClaims: bigint, vaultIdle: bigint): boolean {
  return (state === "Live" || state === "Retiring" || state === "Retired") && unfundedClaims > 0n && vaultIdle > 0n;
}

export interface LastMarkInfo {
  markId: bigint;
  applied: boolean;
  deployedValueUsd: bigint;
}

/** Retiring and the last APPLIED mark carried deployedValueUsd == 0 (Book.finalizeRetirement). */
export function canFinalizeRetirement(state: BookState, last: LastMarkInfo | null): boolean {
  return state === "Retiring" && last !== null && last.markId > 0n && last.applied && last.deployedValueUsd === 0n;
}

/** Books whose fee flow is swept + distributed each period. */
export function distributes(state: BookState): boolean {
  return state === "Live" || state === "Retiring";
}

/** Simple per-key cooldown after failed/just-sent actions so the loop never hammers a reverting call. */
export class Cooldowns {
  private until = new Map<string, number>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  ready(key: string): boolean {
    return (this.until.get(key) ?? 0) <= this.now();
  }
  hold(key: string, ms: number) {
    this.until.set(key, this.now() + ms);
  }
}
