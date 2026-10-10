// Session-aware publication: in session the aggregated price is published live; off-hours the feed
// HOLDS at the last open-session price (held = true) so the engine and mandates go reduce-only while
// liquidations keep a fresh (re-stamped) held price.
import { SESSIONS_24X5, SESSIONS_24X7, SESSIONS_NYSE_RTH, decodeSessions, encodeSessions, isOpen, type Sessions } from "@bookrunner/shared";
import type { Hex } from "viem";
import { type AggregateResult, median, sourceCountOf } from "./aggregate";
import type { SourceQuote } from "./types";

export interface LastOpen {
  price: number;
  sources: SourceQuote[];
  sourceCount: number;
  /** unix ms of the open-session observation */
  ts: number;
}

export type Decision =
  | { kind: "publish"; price: number; held: boolean; sources: SourceQuote[]; sourceCount: number; lastOpen: LastOpen; seeded?: boolean }
  | { kind: "skip"; reason: string; lastOpen: LastOpen | null };

export const DEFAULT_SESSIONS: Record<"24x7" | "24x5" | "nyse", Hex> = {
  "24x7": encodeSessions(SESSIONS_24X7),
  "24x5": encodeSessions(SESSIONS_24X5),
  nyse: encodeSessions(SESSIONS_NYSE_RTH),
};

/**
 * Feed open iff every governing charter session is open (conservative: one closed session holds the
 * shared on-chain key). SESSIONS_MODE=24x7 overrides for demos.
 */
export function marketOpen(sessions: readonly Hex[], at: Date, mode: string | undefined): boolean {
  if (mode === "24x7") return true;
  if (sessions.length === 0) return true;
  return sessions.every((s) => isOpen(decodeSafe(s), at));
}

function decodeSafe(s: Hex): Sessions {
  try {
    return decodeSessions(s);
  } catch {
    return SESSIONS_24X7;
  }
}

/**
 * `minSeedSources` (default 1): sources needed to seed an off-hours hold without history. Mainnet passes
 * the full minimum (a held price is never signed from fewer sources there, production.ts).
 */
export function decide(p: { open: boolean; agg: AggregateResult; lastOpen: LastOpen | null; nowMs: number; minSeedSources?: number }): Decision {
  const { open, agg, lastOpen } = p;
  if (open) {
    if (agg.ok && agg.price !== null) {
      const sourceCount = sourceCountOf(agg);
      const lo: LastOpen = { price: agg.price, sources: agg.accepted, sourceCount, ts: p.nowMs };
      return { kind: "publish", price: agg.price, held: false, sources: agg.accepted, sourceCount, lastOpen: lo };
    }
    return { kind: "skip", reason: agg.reason ?? "aggregation failed", lastOpen };
  }
  if (lastOpen) {
    return { kind: "publish", price: lastOpen.price, held: true, sources: lastOpen.sources, sourceCount: lastOpen.sourceCount, lastOpen };
  }
  // Started off-hours with no history: seed the hold from whatever is observable now (>= 1 source).
  const seedMin = Math.max(1, p.minSeedSources ?? 1);
  if (agg.accepted.length > 0 && sourceCountOf(agg) >= seedMin) {
    // an index level is a weighted sum, not a median of its components
    const price = agg.sourceCount !== undefined && agg.price !== null ? agg.price : median(agg.accepted.map((s) => s.price));
    const sourceCount = sourceCountOf(agg);
    const lo: LastOpen = { price, sources: agg.accepted, sourceCount, ts: p.nowMs };
    return { kind: "publish", price, held: true, sources: agg.accepted, sourceCount, lastOpen: lo, seeded: true };
  }
  const seen = agg.accepted.length > 0 ? ` (${sourceCountOf(agg)} of ${seedMin} sources needed to seed a hold)` : "";
  return { kind: "skip", reason: `off-hours with no price history${seen}`, lastOpen: null };
}
