// Split window (pure; audit M-2, review I-1, fix round 2 N-I1). A per-share oracle price is quoted in the share
// count of the moment it was observed. After a split (or any multiplier change) it may only meet the multiplier
// of that moment: Friday's held per-share price times a 10:1 split's new multiplier values each token at 10x. The
// registry's strict view refuses it on-chain (StockTokenRegistry.valueUsd reverts MultiplierChangedSincePrice);
// the mark service values through the pure valueUsdAt, so it applies the same rule here:
//
//   - every desk position in the window is REVALUED at the multiplier in force at its price's basis
//     (StockTokenRegistry.basisMultiplier on-chain first, then the token's update events; economically right,
//     a split does not change a token's value). Never at the new multiplier;
//   - when that multiplier is unknown, the valuation is UNAVAILABLE: the position keeps the value of the previous
//     mark (pro rata to its quantity), so the mark books no P&L for it. A held mark still runs the waterfall,
//     backstop and drawdown kill on-chain, so a 0 would book a false loss, pull backstop USDC and could kill
//     the book. Only with no previous value at all is it 0;
//   - while the window is young (less than `maxRefuseSec` since the change, default one mark interval) and the
//     price is still fresh, the mark is REFUSED (retryable): the oracle normally reprices at the open;
//   - after that, or at once when the price is stale (the oracle is not publishing: no reprice is coming), the
//     mark is committed HELD (M-1: P&L only, no settlement), so M-1's 30-day bound and the desk flow gate keep
//     running for a token that never reprices (corporate-action halt, delisting).
//
// One mark interval keeps a refused period inside the alerts' mark_overdue warning (critical needs two missed
// intervals): a weekend dividend update is an expected warning, not a page.
import { valueAtMultiplier } from "@bookrunner/shared";
import type { DeskPosition } from "./types";

export { priceBasisAt } from "@bookrunner/shared";

export interface SplitWindowResult {
  /** positions with every split-window position revalued (splitWindow: true) */
  positions: DeskPosition[];
  /** one line per position in the window */
  window: string[];
  /** the lines of positions whose window is still young (the mark is refused while non-empty) */
  refuse: string[];
  /** positions valued at 0: no basis multiplier and no previous value (logged as an error) */
  zeroed: string[];
}

/** Positions of the previous mark, by lowercase token address. */
export type PrevPositions = ReadonlyMap<string, { qtyRaw: bigint; valueUsd: bigint }>;

/** True when some valued desk position is in the split window with no known basis multiplier. */
export function needsPrevPositions(positions: readonly DeskPosition[]): boolean {
  return positions.some((p) => inWindow(p) && (p.basisMultiplierWad ?? null) === null);
}

function inWindow(p: DeskPosition): boolean {
  return p.qtyRaw > 0n && p.priceWad > 0n && p.multiplierChangedAt !== undefined && p.priceBasisAt !== undefined && p.multiplierChangedAt > p.priceBasisAt;
}

export function resolveSplitWindow(positions: readonly DeskPosition[], o: { nowSec: bigint; maxRefuseSec: bigint; prev?: PrevPositions }): SplitWindowResult {
  const out: DeskPosition[] = [];
  const window: string[] = [];
  const refuse: string[] = [];
  const zeroed: string[] = [];
  for (const p of positions) {
    if (!inWindow(p)) {
      out.push(p);
      continue;
    }
    const m = p.basisMultiplierWad ?? null;
    let valueUsd: bigint;
    let how: string;
    if (m !== null) {
      valueUsd = valueAtMultiplier(p.qtyRaw, m, p.priceWad, p.decimals);
      how = `the basis multiplier ${m}`;
    } else {
      const prev = o.prev?.get(p.token.toLowerCase());
      if (prev && prev.qtyRaw > 0n) {
        valueUsd = (prev.valueUsd * p.qtyRaw) / prev.qtyRaw;
        how = "the previous mark's value (basis multiplier unknown: no P&L booked for it)";
      } else {
        valueUsd = 0n;
        how = "0 (basis multiplier and previous value unknown)";
      }
    }
    out.push({ ...p, valueUsd, multiplierWad: m ?? 0n, splitWindow: true });
    const line = `${p.ticker}: price basis ${p.priceBasisAt} predates the multiplier change at ${p.multiplierChangedAt}; valued at ${how}`;
    window.push(line);
    if (valueUsd === 0n && m === null) zeroed.push(line);
    const since = p.splitWindowSince ?? p.multiplierChangedAt!;
    if (!p.priceStale && o.nowSec - since < o.maxRefuseSec) refuse.push(line);
  }
  return { positions: out, window, refuse, zeroed };
}
