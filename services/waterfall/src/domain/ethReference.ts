// ETH reference duty decisions and buyback sizing from the BuybackGuard (pure; tech update #9, contracts/src/BuybackGuard.sol).
//
// The guard stores an ETH/USDG reference read on chain from the WETH / USDG Uniswap v3 pool's TWAP. Anyone may poke it; the
// keeper does, every few minutes, so the stored value stays inside its `ethMaxAge` and the buyback and the liquidation gas
// policy read a live number instead of an env value. The contract decides what is accepted (liquidity floor, spot-vs-mean
// deviation, per-update clamp, minimum interval): this only decides WHEN to try.
import type { Address } from "viem";

/** BuybackGuard.ethReference() source: 0 none, 1 the on-chain TWAP (fresh), 2 the unexpired governance fallback. */
export type EthRefSource = 0 | 1 | 2;

export interface EthRefState {
  guard: Address;
  /** the TWAP pool is configured (ethPool != 0): without it there is nothing to poke */
  configured: boolean;
  /** the reference in force (WAD, USDG per ETH); 0 when none */
  valueWad: bigint;
  source: EthRefSource;
  /** BuybackGuard.ethRefAt: when the stored value was last updated (unix s; 0 = never) */
  storedAt: number;
  nowSec: number;
  /** governance fallback expiry (unix s; 0 = none) */
  fallbackExpiry: number;
}

/** BuybackGuard.MIN_POKE_INTERVAL: the contract refuses an update sooner than this after the last one. */
export const MIN_POKE_INTERVAL_SEC = 300;

export type EthPokePlan = { kind: "poke" } | { kind: "wait"; reason: "not_configured" | "recent"; untilSec: number | null };

/** Poke when the pool is configured and the stored value is at least `everySec` (>= the contract minimum) old or never set. */
export function planEthPoke(s: EthRefState, everySec: number): EthPokePlan {
  if (!s.configured) return { kind: "wait", reason: "not_configured", untilSec: null };
  const every = Math.max(everySec, MIN_POKE_INTERVAL_SEC);
  if (s.storedAt === 0 || s.nowSec - s.storedAt >= every) return { kind: "poke" };
  return { kind: "wait", reason: "recent", untilSec: s.storedAt + every };
}

/**
 * The size bound of one buyback: the router's `maxBuybackPerCall` (0 = uncapped) and the guard's depth cap
 * (BuybackGuard.maxBuyback: null = no depth source yet, 0 = the BKRN pool has no usable liquidity). `max` = the smaller
 * of the two that apply (0 = uncapped); `blocked` = the pool is empty, nothing is sent.
 */
export function sizeBound(maxPerCall: bigint, depthCap: bigint | null | undefined): { max: bigint; blocked: boolean; binding: "perCall" | "depth" | "none" } {
  if (depthCap === 0n) return { max: 0n, blocked: true, binding: "depth" };
  if (depthCap === null || depthCap === undefined) return { max: maxPerCall, blocked: false, binding: maxPerCall > 0n ? "perCall" : "none" };
  if (maxPerCall > 0n && maxPerCall <= depthCap) return { max: maxPerCall, blocked: false, binding: "perCall" };
  return { max: depthCap, blocked: false, binding: "depth" };
}

/**
 * Hold after a chunk of a larger pending amount: the next chunk waits so that arbitrage can restore the BKRN price the
 * chunk moved (the depth cap bounds ONE swap's impact, not a burst of them). 0 = no spacing (tests, devnet).
 */
export function chunkHoldMs(amountIn: bigint, pendingBefore: bigint, spacingMs: number): number {
  return amountIn < pendingBefore ? spacingMs : 0;
}
