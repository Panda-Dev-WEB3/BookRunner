// Split window (audit M-2; review I-1 / I-4), shared by the mark and risk services. A per-share oracle price is
// quoted in the share count of the moment it was observed; after a split (or any multiplier change) it may only
// meet the multiplier of that moment. The on-chain guard (StockTokenRegistry.valueUsd) refuses such a price;
// off-chain valuations through the pure valueUsdAt apply the same rule here and value the position at the
// multiplier in force at the price's basis (economically right: a split does not change a token's value), or at
// 0 when that multiplier cannot be established. Never at the new multiplier.
import type { Address, PublicClient } from "viem";

/** Share basis of a price: its publishedAt when live, AttestedOracle.lastLiveAt when held (a held price re-signs
 *  the last open-session print under a fresh timestamp). */
export function priceBasisAt(p: { held: boolean; publishedAt: bigint; lastLiveAt: bigint }): bigint {
  return p.held ? p.lastLiveAt : p.publishedAt;
}

/** The registry's split condition: the multiplier changed after the price's basis. */
export function inSplitWindow(p: { multiplierChangedAt: bigint; priceBasisAt: bigint }): boolean {
  return p.multiplierChangedAt > p.priceBasisAt;
}

/** StockTokenRegistry's valuation at an explicit multiplier: floor(qty * mult * price / (10^dec * 1e30)). */
export function valueAtMultiplier(qtyRaw: bigint, multiplierWad: bigint, priceWad: bigint, decimals: number): bigint {
  if (qtyRaw === 0n || multiplierWad === 0n || priceWad === 0n) return 0n;
  return (qtyRaw * multiplierWad * priceWad) / (10n ** BigInt(decimals) * 10n ** 30n);
}

/** ERC-8056 / Robinhood `UIMultiplierUpdated(oldMultiplier, newMultiplier, effectiveAtTimestamp)` (VERIFY T2). */
export const uiMultiplierUpdatedEvent = {
  type: "event",
  name: "UIMultiplierUpdated",
  inputs: [
    { name: "oldMultiplier", type: "uint256", indexed: false },
    { name: "newMultiplier", type: "uint256", indexed: false },
    { name: "effectiveAtTimestamp", type: "uint256", indexed: false },
  ],
} as const;

export interface MultiplierUpdate {
  oldMultiplier: bigint;
  newMultiplier: bigint;
  effectiveAt: bigint;
}

/**
 * Multiplier in force at `basisAt` from the token's update events (log order), or null when it cannot be
 * established. An update ACTIVATED when the next one was staged from its new value (next.old == this.new), or,
 * for the last one, when its effectiveAt has passed; an update overwritten before it took effect (next.old ==
 * this.old) never activated. The multiplier at the basis is the old value of the first activation after it.
 * `firstChangeAt` = that activation's time (the start of the window).
 */
export function multiplierAtBasis(events: readonly MultiplierUpdate[], basisAt: bigint, nowSec: bigint): { multiplierWad: bigint; firstChangeAt: bigint } | null {
  const activated: MultiplierUpdate[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const next = events[i + 1];
    if (next ? next.oldMultiplier === e.newMultiplier && next.oldMultiplier !== e.oldMultiplier : e.effectiveAt <= nowSec) activated.push(e);
  }
  const after = activated.filter((e) => e.effectiveAt > basisAt && e.effectiveAt <= nowSec).sort((a, b) => (a.effectiveAt < b.effectiveAt ? -1 : a.effectiveAt > b.effectiveAt ? 1 : 0));
  const first = after[0];
  if (!first || first.oldMultiplier === 0n) return null;
  return { multiplierWad: first.oldMultiplier, firstChangeAt: first.effectiveAt };
}

export const DEFAULT_SPLIT_LOG_LOOKBACK_BLOCKS = 200_000n;
/** Per-request block range (providers cap getLogs ranges; the indexer pages at 2,000 too). */
export const DEFAULT_SPLIT_LOG_CHUNK_BLOCKS = 2_000n;

/**
 * Fallback after the on-chain StockTokenRegistry.basisMultiplier (fix round 2, N-I1): reads the token's update
 * events over the last `lookbackBlocks` blocks before `blockNumber`, in `chunkBlocks` pages, and returns
 * {@link multiplierAtBasis}. null on any read failure.
 */
export async function readMultiplierAtBasis(
  pub: Pick<PublicClient, "getLogs">,
  token: Address,
  o: { basisAt: bigint; nowSec: bigint; blockNumber: bigint; lookbackBlocks?: bigint; chunkBlocks?: bigint },
): Promise<{ multiplierWad: bigint; firstChangeAt: bigint } | null> {
  const lookback = o.lookbackBlocks ?? DEFAULT_SPLIT_LOG_LOOKBACK_BLOCKS;
  const chunk = o.chunkBlocks && o.chunkBlocks > 0n ? o.chunkBlocks : DEFAULT_SPLIT_LOG_CHUNK_BLOCKS;
  const start = o.blockNumber > lookback ? o.blockNumber - lookback : 0n;
  try {
    const events: MultiplierUpdate[] = [];
    for (let from = start; from <= o.blockNumber; from += chunk) {
      const to = from + chunk - 1n < o.blockNumber ? from + chunk - 1n : o.blockNumber;
      const logs = await pub.getLogs({ address: token, event: uiMultiplierUpdatedEvent, fromBlock: from, toBlock: to });
      for (const l of logs) {
        const a = (l as { args?: { oldMultiplier?: bigint; newMultiplier?: bigint; effectiveAtTimestamp?: bigint } }).args;
        if (a?.oldMultiplier === undefined || a.newMultiplier === undefined || a.effectiveAtTimestamp === undefined) continue;
        events.push({ oldMultiplier: a.oldMultiplier, newMultiplier: a.newMultiplier, effectiveAt: a.effectiveAtTimestamp });
      }
    }
    return multiplierAtBasis(events, o.basisAt, o.nowSec);
  } catch {
    return null;
  }
}
