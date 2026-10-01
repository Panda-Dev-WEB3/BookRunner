// sourcesHash = keccak256(canonicalJson(sources)) over the canonical source list: entries reduced
// to {name, price, ts} and sorted by (name, ts, price), so fetch order never changes the hash.
// Verifiers recompute it from OraclePriceMsg.sources (which is already in canonical order).
import { canonicalJson } from "@bookrunner/shared";
import { type Hex, keccak256, stringToHex } from "viem";
import type { SourceQuote } from "./types";

export function canonicalSources(sources: readonly SourceQuote[]): SourceQuote[] {
  return sources
    .map((s) => ({ name: s.name, price: s.price, ts: s.ts }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.ts - b.ts || a.price - b.price));
}

export function sourcesHash(sources: readonly SourceQuote[]): Hex {
  return keccak256(stringToHex(canonicalJson(canonicalSources(sources))));
}
