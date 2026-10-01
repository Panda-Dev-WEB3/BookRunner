import { describe, expect, test } from "bun:test";
import {
  type Deployment,
  SESSIONS_24X5,
  SESSIONS_24X7,
  SESSIONS_NYSE_RTH,
  VENUE,
  encodeSessions,
  indexUnderlying,
  priceId,
  strToBytes32,
  tokenUnderlying,
} from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import { type ChainReader, type DbReader, discoverUniverse } from "../src/discovery";
import { buildUniverse, priceIdLabel } from "../src/domain/universe";

const RTH = encodeSessions(SESSIONS_NYSE_RTH);
const H24X5 = encodeSessions(SESSIONS_24X5);
const ALWAYS = encodeSessions(SESSIONS_24X7);
const TICKERS = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"];
const tokenOf = (t: string) => `0x${(TICKERS.indexOf(t) + 1).toString(16).padStart(40, "0")}` as Address;
const bookAddr = (i: number) => `0x${(0xb00 + i).toString(16).padStart(40, "0")}` as Address;
const zero = "0x0000000000000000000000000000000000000000" as Address;

function deployment(): Deployment {
  const comps = (i: number) => ({ book: bookAddr(i), senior: zero, junior: zero, vault: zero, mandate: zero, router: zero, desk: zero, adapter: zero });
  return {
    chainId: 31337,
    startBlock: 0,
    contracts: { stockRegistry: "0x00000000000000000000000000000000000000ee" } as unknown as Deployment["contracts"],
    stockTokens: Object.fromEntries(TICKERS.map((t) => [t, { token: tokenOf(t), priceId: priceId(t), multiplierWad: "1000000000000000000" }])),
    books: [
      { bookId: 1, name: "NVDA", symbol: "PERP_NVDA_USDC", venue: VENUE.ORDERLY, components: comps(1) },
      { bookId: 2, name: "TSLA", symbol: "PERP_TSLA_USDC", venue: VENUE.ORDERLY, components: comps(2) },
      { bookId: 3, name: "RHX5", symbol: "RHX5-PERP", venue: VENUE.POOL_ENGINE, components: comps(3) },
    ],
  };
}

const charters: Record<string, { underlying: Hex; venue: number; sessions: Hex; symbol: Hex }> = {
  [bookAddr(1)]: { underlying: tokenUnderlying(tokenOf("NVDA")), venue: VENUE.ORDERLY, sessions: H24X5, symbol: strToBytes32("PERP_NVDA_USDC") },
  [bookAddr(2)]: { underlying: tokenUnderlying(tokenOf("TSLA")), venue: VENUE.ORDERLY, sessions: ALWAYS, symbol: strToBytes32("PERP_TSLA_USDC") },
  [bookAddr(3)]: { underlying: indexUnderlying("RHX5"), venue: VENUE.POOL_ENGINE, sessions: RTH, symbol: strToBytes32("RHX5-PERP") },
};

const chainOk: ChainReader = {
  async charterOf(book) {
    const c = charters[book];
    if (!c) throw new Error("no book");
    return c;
  },
  async indexOf(u) {
    if (u !== indexUnderlying("RHX5")) throw new Error("not an index");
    return { priceId: priceId("RHX5"), components: TICKERS.map((t) => ({ token: tokenOf(t), weightBps: 2000n })) };
  },
  async tokenPriceId(token) {
    const t = TICKERS.find((x) => tokenOf(x).toLowerCase() === token.toLowerCase());
    if (!t) throw new Error("unknown token");
    return priceId(t);
  },
};

const chainDown: ChainReader = {
  charterOf: async () => {
    throw new Error("connection refused");
  },
  indexOf: async () => {
    throw new Error("connection refused");
  },
  tokenPriceId: async () => {
    throw new Error("connection refused");
  },
};

const cfg = { tickers: TICKERS, indexes: { RHX5: Object.fromEntries(TICKERS.map((t) => [t, 2000])) }, defaultSessions: ALWAYS };

describe("discoverUniverse", () => {
  test("from chain: equities, index components, sessions, venue symbols", async () => {
    const r = await discoverUniverse({ deployment: deployment(), chain: chainOk, db: null, cfg });
    expect(r.source).toBe("chain");
    expect(r.warnings).toEqual([]);
    expect(r.entries.map((e) => `${e.kind}:${e.priceId}`)).toEqual([...TICKERS.map((t) => `equity:${t}`), "index:RHX5"]);
    const byId = Object.fromEntries(r.entries.map((e) => [e.priceId, e]));
    expect(byId.NVDA!.venueSymbols).toEqual(["PERP_NVDA_USDC"]);
    expect(byId.NVDA!.sessions).toEqual([H24X5]);
    expect(byId.NVDA!.underlying).toBe(priceId("NVDA"));
    expect(byId.TSLA!.sessions).toEqual([ALWAYS]);
    expect(byId.RHX5!.venueSymbols).toEqual([]); // engine book: no builder price
    expect(byId.RHX5!.underlying).toBe(priceId("RHX5"));
    expect(byId.RHX5!.components).toEqual(TICKERS.map((t) => ({ priceId: t, weightBps: 2000 })));
    expect(byId.RHX5!.sessions).toEqual([RTH]);
    // components without their own book follow the index book's sessions
    expect(byId.AAPL!.sessions).toEqual([RTH]);
    expect(byId.AAPL!.bookIds).toEqual([]);
    expect(byId.RHX5!.bookIds).toEqual([3]);
  });

  test("chain down: config fallback by name + DB sessions", async () => {
    const db: DbReader = {
      charterSessions: async (id) => (id === 1 ? RTH : null),
      books: async () => [],
    };
    const r = await discoverUniverse({ deployment: deployment(), chain: chainDown, db, cfg });
    expect(r.source).toBe("config");
    expect(r.warnings.some((w) => w.includes("getCharter failed"))).toBe(true);
    const byId = Object.fromEntries(r.entries.map((e) => [e.priceId, e]));
    expect(Object.keys(byId).sort()).toEqual([...TICKERS, "RHX5"].sort());
    expect(byId.NVDA!.sessions).toEqual([RTH]); // from charters.struct_json
    expect(byId.TSLA!.sessions).toEqual([ALWAYS]); // unknown -> default
    expect(byId.NVDA!.venueSymbols).toEqual(["PERP_NVDA_USDC"]);
    expect(byId.RHX5!.bookIds).toEqual([3]);
  });

  test("books created after launch come from the DB books table", async () => {
    const db: DbReader = {
      charterSessions: async () => null,
      books: async () => [
        { bookId: 9, bookAddr: bookAddr(9), underlying: tokenUnderlying(tokenOf("AAPL")), venue: VENUE.ORDERLY, symbol: "PERP_AAPL_USDC", name: "AAPL" },
      ],
    };
    charters[bookAddr(9)] = { underlying: tokenUnderlying(tokenOf("AAPL")), venue: VENUE.ORDERLY, sessions: H24X5, symbol: strToBytes32("PERP_AAPL_USDC") };
    const r = await discoverUniverse({ deployment: deployment(), chain: chainOk, db, cfg });
    const aapl = r.entries.find((e) => e.priceId === "AAPL")!;
    expect(aapl.bookIds).toEqual([9]);
    expect(aapl.venueSymbols).toEqual(["PERP_AAPL_USDC"]);
    expect(aapl.sessions).toEqual([H24X5]); // own book wins over the index inheritance
    delete charters[bookAddr(9)];
  });

  test("empty deployment: config tickers + config indexes", async () => {
    const dep = { ...deployment(), stockTokens: {}, books: [] };
    const r = await discoverUniverse({ deployment: dep, chain: null, db: null, cfg });
    expect(r.source).toBe("config");
    expect(r.entries.map((e) => e.priceId)).toEqual([...TICKERS, "RHX5"]);
  });

  test("unresolvable book is skipped with a warning", async () => {
    const dep = deployment();
    dep.books.push({ ...dep.books[0]!, bookId: 7, name: "ZZZ", symbol: "PERP_ZZZ_USDC", components: { ...dep.books[0]!.components, book: bookAddr(7) } });
    const r = await discoverUniverse({ deployment: dep, chain: chainOk, db: null, cfg });
    expect(r.warnings.some((w) => w.includes("book 7"))).toBe(true);
    expect(r.source).toBe("partial");
  });
});

describe("buildUniverse", () => {
  test("warns on index weights that do not sum to 1e4 and on unknown book keys", () => {
    const r = buildUniverse({
      equities: [{ priceId: "NVDA", underlying: priceId("NVDA") }],
      indexes: [{ priceId: "IX", underlying: priceId("IX"), components: [{ priceId: "NVDA", weightBps: 9000 }] }],
      books: [{ bookId: 5, venue: 0, symbol: "S", oracleKey: "NOPE", sessions: null }],
      defaultSessions: ALWAYS,
    });
    expect(r.warnings).toHaveLength(2);
    expect(r.entries.map((e) => e.priceId)).toEqual(["NVDA", "IX"]);
    expect(r.entries[0]!.sessions).toEqual([ALWAYS]);
  });

  test("priceIdLabel decodes ASCII bytes32, falls back for hashes", () => {
    expect(priceIdLabel(priceId("NVDA"))).toBe("NVDA");
    const h = indexUnderlying("RHX5");
    expect(priceIdLabel(h, "fallback")).toBe("fallback");
    expect(priceIdLabel(h)).toBe(h.toLowerCase());
  });
});
