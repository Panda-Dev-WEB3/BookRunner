// Split window (pure; audit M-2, review I-1). A per-share oracle price is quoted in the share count of the moment
// it was observed. After a split (or any multiplier change) it may only meet the multiplier of that moment:
// Friday's held per-share price times a 10:1 split's new multiplier values each token at 10x. The registry's
// strict view refuses it on-chain (StockTokenRegistry.valueUsd reverts MultiplierChangedSincePrice); the mark
// service values through the pure valueUsdAt, so it applies the same rule here:
//
//   - every desk position in the window is REVALUED at the multiplier in force at its price's basis (from the
//     token's UIMultiplierUpdated events; economically right, a split does not change a token's value), or at 0
//     when that multiplier cannot be established. Never at the new multiplier;
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
}

export function resolveSplitWindow(positions: readonly DeskPosition[], o: { nowSec: bigint; maxRefuseSec: bigint }): SplitWindowResult {
  const out: DeskPosition[] = [];
  const window: string[] = [];
  const refuse: string[] = [];
  for (const p of positions) {
    const changedAt = p.multiplierChangedAt;
    const basis = p.priceBasisAt;
    if (p.qtyRaw === 0n || p.priceWad === 0n || changedAt === undefined || basis === undefined || changedAt <= basis) {
      out.push(p);
      continue;
    }
    const m = p.basisMultiplierWad ?? null;
    const valueUsd = m === null ? 0n : valueAtMultiplier(p.qtyRaw, m, p.priceWad, p.decimals);
    out.push({ ...p, valueUsd, multiplierWad: m ?? 0n, splitWindow: true });
    const since = p.splitWindowSince ?? changedAt;
    const line = `${p.ticker}: price basis ${basis} predates the multiplier change at ${changedAt}; valued at ${m === null ? "0 (multiplier at the basis unknown)" : `the basis multiplier ${m}`}`;
    window.push(line);
    if (!p.priceStale && o.nowSec - since < o.maxRefuseSec) refuse.push(line);
  }
  return { positions: out, window, refuse };
}
