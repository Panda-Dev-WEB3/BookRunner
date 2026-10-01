// Pure assembly of the published universe from discovered equities, indexes and books.
import { VENUE, bytes32ToStr, priceId as priceIdOf } from "@bookrunner/shared";
import type { Hex } from "viem";
import type { IndexComponent, UniverseEntry } from "./types";

export interface BookInfo {
  bookId: number;
  venue: number;
  /** venue symbol (Orderly symbol for Orderly books) */
  symbol: string;
  /** price id label the book quotes on */
  oracleKey: string;
  /** encoded charter sessions, null when unknown */
  sessions: Hex | null;
}

export interface UniverseInput {
  equities: Array<{ priceId: string; underlying: Hex }>;
  indexes: Array<{ priceId: string; underlying: Hex; components: IndexComponent[] }>;
  books: BookInfo[];
  defaultSessions: Hex;
}

export interface BuiltUniverse {
  entries: UniverseEntry[];
  warnings: string[];
}

/** Printable label for a bytes32 price id ("NVDA"), else the fallback / hex. */
export function priceIdLabel(id: Hex, fallback?: string): string {
  try {
    const s = bytes32ToStr(id);
    if (s.length > 0 && /^[\x21-\x7e]+$/.test(s)) return s;
  } catch {
    // not a right-padded ASCII bytes32
  }
  return fallback ?? id.toLowerCase();
}

export function buildUniverse(input: UniverseInput): BuiltUniverse {
  const warnings: string[] = [];
  const entries = new Map<string, UniverseEntry>();
  const add = (priceId: string, underlying: Hex, kind: UniverseEntry["kind"], components: IndexComponent[] = []) => {
    const existing = entries.get(priceId);
    if (existing) {
      if (kind === "index" && existing.kind === "index" && existing.components.length === 0) existing.components = components;
      return existing;
    }
    const e: UniverseEntry = { priceId, underlying: underlying.toLowerCase() as Hex, kind, components, sessions: [], venueSymbols: [], bookIds: [] };
    entries.set(priceId, e);
    return e;
  };

  for (const eq of input.equities) add(eq.priceId, eq.underlying, "equity");
  for (const ix of input.indexes) {
    const weight = ix.components.reduce((s, c) => s + c.weightBps, 0);
    if (weight !== 10_000) warnings.push(`index ${ix.priceId}: component weights sum to ${weight} bps (expected 10000)`);
    for (const c of ix.components) if (!entries.has(c.priceId)) add(c.priceId, priceIdOf(c.priceId), "equity");
  }
  for (const ix of input.indexes) add(ix.priceId, ix.underlying, "index", ix.components);

  for (const b of input.books) {
    const e = entries.get(b.oracleKey);
    if (!e) {
      warnings.push(`book ${b.bookId}: oracle key ${b.oracleKey} not in universe`);
      continue;
    }
    if (!e.bookIds.includes(b.bookId)) e.bookIds.push(b.bookId);
    if (b.sessions && !e.sessions.includes(b.sessions)) e.sessions.push(b.sessions);
    if (b.venue === VENUE.ORDERLY && b.symbol && !e.venueSymbols.includes(b.symbol)) e.venueSymbols.push(b.symbol);
  }

  // Components without their own book follow the sessions of the index books built on them.
  for (const ix of input.indexes) {
    const ie = entries.get(ix.priceId);
    if (!ie) continue;
    for (const c of ix.components) {
      const ce = entries.get(c.priceId);
      if (ce && ce.bookIds.length === 0) for (const s of ie.sessions) if (!ce.sessions.includes(s)) ce.sessions.push(s);
    }
  }
  for (const e of entries.values()) if (e.sessions.length === 0) e.sessions.push(input.defaultSessions);

  // equities first so index levels can use this tick's component prices
  const all = [...entries.values()];
  return { entries: [...all.filter((e) => e.kind === "equity"), ...all.filter((e) => e.kind === "index")], warnings };
}
