// Whether a mark is "held" (pure; audit M-1). MarkInput.held is signed into the EIP-712 Mark: Book.applyMark
// books a held mark's P&L but settles no redemption bucket and no top-up round until the first non-held mark
// (bounded on-chain by BookLogic.MAX_HELD_DEFERRAL), so nobody exits or enters at a value the reopen is about
// to reprice. The flag comes from the oracle's SIGNED price state (PriceUpdate.held: session closed / feed
// held) of every price the valuation used: the book's underlying (the engine pool and the venue's market) and
// each desk Stock Token position actually held.
import type { MarkSnapshot } from "./types";

export interface MarkHeldResult {
  held: boolean;
  /** what was held ("underlying", or the desk token tickers) — for the log */
  reasons: string[];
  /** the underlying's price state could not be read (valued without it; not treated as held) */
  underlyingUnknown: boolean;
}

export function markHeld(s: Pick<MarkSnapshot, "underlyingPrice" | "desk">): MarkHeldResult {
  const reasons: string[] = [];
  if (s.underlyingPrice?.held) reasons.push("underlying");
  for (const p of s.desk.positions) if (p.qtyRaw > 0n && p.priceHeld) reasons.push(p.ticker);
  return { held: reasons.length > 0, reasons, underlyingUnknown: s.underlyingPrice === null };
}
