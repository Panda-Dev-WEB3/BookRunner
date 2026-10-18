// Split window (pure; audit M-2). A per-share oracle price is quoted in the share count of the moment it was
// observed. After a split (or any multiplier change) it may only meet the multiplier of that moment: Friday's
// held per-share price times a 10:1 split's new multiplier values each token at 10x. The registry's strict
// view refuses it on-chain (StockTokenRegistry.valueUsd reverts MultiplierChangedSincePrice); the mark service
// values through the pure valueUsdAt, so it applies the same rule here and REFUSES the mark (retryable) rather
// than signing it held: a held mark still books its P&L into the share prices (and the drawdown kill), and the
// reopen would then book the 90% correction. No mark in the window means nothing settles in it either; the
// first mark after the oracle signs a live post-change price values the position normally.
//
// The basis of a price (mirrors the registry): its publishedAt when live, AttestedOracle.lastLiveAt when held
// (a held price re-signs the last open-session print under a fresh timestamp). The change time is
// StockTokenRegistry.multiplierChangedAt (the token's effectiveAt in live mode, the governance change in
// stored mode).
import type { DeskPosition } from "./types";

export function priceBasisAt(p: { held: boolean; publishedAt: bigint; lastLiveAt: bigint }): bigint {
  return p.held ? p.lastLiveAt : p.publishedAt;
}

/** One line per valued desk position (qty > 0, value > 0) whose price basis predates its multiplier change. */
export function multiplierBasisProblems(positions: readonly DeskPosition[]): string[] {
  const out: string[] = [];
  for (const p of positions) {
    if (p.qtyRaw === 0n || p.valueUsd === 0n) continue;
    if (p.multiplierChangedAt === undefined || p.priceBasisAt === undefined) continue;
    if (p.multiplierChangedAt > p.priceBasisAt) {
      out.push(`${p.ticker}: price basis ${p.priceBasisAt} predates the multiplier change at ${p.multiplierChangedAt}`);
    }
  }
  return out;
}
