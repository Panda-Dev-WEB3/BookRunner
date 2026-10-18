// Whether a mark is "held" (pure; audit M-1). MarkInput.held is signed into the EIP-712 Mark: Book.applyMark
// books a held mark's P&L but settles no redemption bucket and no top-up round until the first non-held mark
// (bounded on-chain by BookLogic.MAX_HELD_DEFERRAL), so nobody exits or enters at a value the reopen is about
// to reprice.
//
// FAIL CLOSED: the mark is held unless every price the NAV used is known, live and fresh. Held when ANY of:
//   - the oracle signed the underlying's price as held (session closed / feed held);
//   - the underlying's price state is unreadable (registry / oracle read failed);
//   - the underlying's price is older than config.maxPriceAge at the valuation time (the oracle stopped
//     publishing, e.g. it went down before signing Friday's held transition: the stored price stays
//     held=false at the Friday print, and without this rule the weekend marks would settle at it);
//   - a desk Stock Token position the NAV values (qty > 0) is priced held or stale.
// A normal closed session is held through the oracle's flag: it re-stamps the held price, so it never goes
// stale. The engine pool is valued at the underlying's price (covered above); an Orderly venue valuation older
// than its bound is refused outright by the pipeline (venueReportAge), never marked.
//
// Computed ONCE per mark (pipeline.compute) and passed to buildMarkPnl, so the signed flag and the published
// statement (MarkPnl.held, hashed into pnlJsonHash) can never disagree.
import type { MarkSnapshot } from "./types";

export type HeldReason = "underlying_held" | "underlying_unknown" | "underlying_stale" | `desk_held:${string}` | `desk_stale:${string}`;

export interface MarkHeldResult {
  held: boolean;
  /** every trigger that fired (for the log; empty when not held) */
  reasons: HeldReason[];
}

/** A price is stale at `refTs` when it was never published or is older than `maxPriceAgeSec` (the oracle's freshness rule). */
export function priceIsStale(publishedAt: bigint | number, refTs: bigint | number, maxPriceAgeSec: bigint | number): boolean {
  const at = BigInt(publishedAt);
  return at === 0n || BigInt(refTs) > at + BigInt(maxPriceAgeSec);
}

export function markHeld(s: Pick<MarkSnapshot, "underlyingPrice" | "desk">): MarkHeldResult {
  const reasons: HeldReason[] = [];
  const u = s.underlyingPrice;
  if (u === null) reasons.push("underlying_unknown");
  else {
    if (u.held) reasons.push("underlying_held");
    if (u.stale) reasons.push("underlying_stale");
  }
  for (const p of s.desk.positions) {
    if (p.qtyRaw === 0n) continue;
    if (p.priceHeld) reasons.push(`desk_held:${p.ticker}`);
    if (p.priceStale) reasons.push(`desk_stale:${p.ticker}`);
  }
  return { held: reasons.length > 0, reasons };
}
