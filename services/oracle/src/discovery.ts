// Universe discovery: deployment.stockTokens + books (deployment and DB), charters read from chain
// (IBook.getCharter) with DB (charters.struct_json) fallback, index definitions from
// StockTokenRegistry.getIndex, and config fallbacks when the chain cannot be read.
import { type Deployment, indexUnderlying, isTokenUnderlying, priceId as priceIdOf, underlyingToToken } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import type { IndexComponent } from "./domain/types";
import { type BookInfo, type BuiltUniverse, buildUniverse, priceIdLabel } from "./domain/universe";

export interface CharterView {
  underlying: Hex;
  venue: number;
  sessions: Hex;
  symbol: Hex;
}

export interface ChainReader {
  charterOf(book: Address): Promise<CharterView>;
  indexOf(underlying: Hex): Promise<{ priceId: Hex; components: Array<{ token: Address; weightBps: bigint }> }>;
  tokenPriceId(token: Address): Promise<Hex>;
}

export interface DbBook {
  bookId: number;
  bookAddr: string;
  underlying: string;
  venue: number;
  symbol: string;
  name: string | null;
}

export interface DbReader {
  charterSessions(bookId: number): Promise<Hex | null>;
  books(): Promise<DbBook[]>;
}

export interface DiscoveryConfig {
  tickers: string[];
  indexes: Record<string, Record<string, number>>;
  defaultSessions: Hex;
}

export interface DiscoveryResult extends BuiltUniverse {
  /** "chain" when every book's charter came from the chain, else "partial" / "config" */
  source: "chain" | "partial" | "config";
}

interface BookRef {
  bookId: number;
  name: string;
  symbol: string;
  venue: number;
  bookAddr: Address | null;
  underlying: Hex | null;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

export async function discoverUniverse(p: {
  deployment: Deployment;
  chain: ChainReader | null;
  db: DbReader | null;
  cfg: DiscoveryConfig;
}): Promise<DiscoveryResult> {
  const { deployment, chain, db, cfg } = p;
  const warnings: string[] = [];
  let chainReads = 0;
  let chainFailures = 0;

  // ---- equities ----
  const equities: Array<{ priceId: string; underlying: Hex }> = [];
  const tokenLabel = new Map<string, string>();
  for (const [key, st] of Object.entries(deployment.stockTokens ?? {})) {
    const label = priceIdLabel(st.priceId, key);
    equities.push({ priceId: label, underlying: st.priceId });
    tokenLabel.set(st.token.toLowerCase(), label);
  }
  if (equities.length === 0) for (const t of cfg.tickers) equities.push({ priceId: t, underlying: priceIdOf(t) });

  const labelForToken = async (token: Address): Promise<string | null> => {
    const known = tokenLabel.get(token.toLowerCase());
    if (known) return known;
    if (!chain) return null;
    try {
      const id = await chain.tokenPriceId(token);
      const label = priceIdLabel(id);
      tokenLabel.set(token.toLowerCase(), label);
      return label;
    } catch (e) {
      warnings.push(`registry.getToken(${token}) failed: ${errMsg(e)}`);
      return null;
    }
  };

  // ---- books (deployment first, DB adds books created after launch) ----
  const refs = new Map<number, BookRef>();
  for (const b of deployment.books ?? []) {
    refs.set(b.bookId, { bookId: b.bookId, name: b.name, symbol: b.symbol, venue: b.venue, bookAddr: b.components.book, underlying: null });
  }
  let dbBooks: DbBook[] = [];
  if (db) {
    try {
      dbBooks = await db.books();
    } catch (e) {
      warnings.push(`db books read failed: ${errMsg(e)}`);
    }
  }
  for (const b of dbBooks) {
    const existing = refs.get(b.bookId);
    const underlying = /^0x[0-9a-fA-F]{64}$/.test(b.underlying) ? (b.underlying.toLowerCase() as Hex) : null;
    if (existing) existing.underlying ??= underlying;
    else
      refs.set(b.bookId, {
        bookId: b.bookId,
        name: b.name ?? b.symbol,
        symbol: b.symbol,
        venue: b.venue,
        bookAddr: /^0x[0-9a-fA-F]{40}$/.test(b.bookAddr) ? (b.bookAddr as Address) : null,
        underlying,
      });
  }

  const indexes = new Map<string, { priceId: string; underlying: Hex; components: IndexComponent[] }>();
  const books: BookInfo[] = [];

  for (const ref of refs.values()) {
    let charter: CharterView | null = null;
    if (chain && ref.bookAddr) {
      chainReads++;
      try {
        charter = await chain.charterOf(ref.bookAddr);
      } catch (e) {
        chainFailures++;
        warnings.push(`book ${ref.bookId}: getCharter failed: ${errMsg(e)}`);
      }
    }
    let sessions: Hex | null = charter?.sessions ?? null;
    if (!sessions && db) {
      try {
        sessions = await db.charterSessions(ref.bookId);
      } catch (e) {
        warnings.push(`book ${ref.bookId}: db charter read failed: ${errMsg(e)}`);
      }
    }
    const underlying = charter?.underlying ?? ref.underlying;
    const venue = charter?.venue ?? ref.venue;

    let oracleKey: string | null = null;
    if (underlying && isTokenUnderlying(underlying)) {
      oracleKey = await labelForToken(underlyingToToken(underlying));
    } else if (underlying && chain) {
      try {
        const ix = await chain.indexOf(underlying);
        const comps: IndexComponent[] = [];
        let complete = true;
        for (const c of ix.components) {
          const label = await labelForToken(c.token);
          if (!label) complete = false;
          else comps.push({ priceId: label, weightBps: Number(c.weightBps) });
        }
        const label = priceIdLabel(ix.priceId);
        if (complete && comps.length > 0) {
          indexes.set(label, { priceId: label, underlying: ix.priceId, components: comps });
          oracleKey = label;
        } else warnings.push(`book ${ref.bookId}: index ${label} has unresolved components`);
      } catch (e) {
        warnings.push(`book ${ref.bookId}: registry.getIndex failed: ${errMsg(e)}`);
      }
    }
    if (!oracleKey) oracleKey = matchByName(ref, equities, cfg, underlying, indexes);
    if (!oracleKey) {
      warnings.push(`book ${ref.bookId} (${ref.name}): cannot resolve its oracle key; skipped`);
      continue;
    }
    books.push({ bookId: ref.bookId, venue, symbol: ref.symbol, oracleKey, sessions });
  }

  // Config indexes when the chain yielded none (pre-launch devnet, unreadable registry).
  if (indexes.size === 0) {
    for (const [name, weights] of Object.entries(cfg.indexes)) {
      indexes.set(name, {
        priceId: name,
        underlying: priceIdOf(name),
        components: Object.entries(weights).map(([priceId, weightBps]) => ({ priceId, weightBps })),
      });
    }
  }

  const built = buildUniverse({ equities, indexes: [...indexes.values()], books, defaultSessions: cfg.defaultSessions });
  const source = !chain || (chainReads > 0 && chainFailures === chainReads) ? "config" : chainFailures > 0 ? "partial" : "chain";
  return { entries: built.entries, warnings: [...warnings, ...built.warnings], source };
}

/** Fallback when the chain is unavailable: match a book to a ticker / config index by name or symbol. */
function matchByName(
  ref: BookRef,
  equities: Array<{ priceId: string }>,
  cfg: DiscoveryConfig,
  underlying: Hex | null,
  indexes: Map<string, { priceId: string; underlying: Hex; components: IndexComponent[] }>,
): string | null {
  const parts = new Set([ref.name, ...ref.symbol.split(/[_\-\s/]+/)].map((s) => s.toUpperCase()));
  for (const [name, weights] of Object.entries(cfg.indexes)) {
    const isThis = (underlying && underlying.toLowerCase() === indexUnderlying(name).toLowerCase()) || parts.has(name.toUpperCase());
    if (isThis) {
      if (!indexes.has(name)) {
        indexes.set(name, {
          priceId: name,
          underlying: priceIdOf(name),
          components: Object.entries(weights).map(([priceId, weightBps]) => ({ priceId, weightBps })),
        });
      }
      return name;
    }
  }
  for (const e of equities) if (parts.has(e.priceId.toUpperCase())) return e.priceId;
  return null;
}
