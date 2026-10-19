import { describe, expect, test } from "bun:test";
import { KEYS } from "@bookrunner/shared/queues";
import { SUPERVISOR_STATUS_KEY } from "@bookrunner/shared/supervisor";
import {
  BACKUP_STATUS_KEY,
  type ChainPort,
  type DbPort,
  collect,
  emptyMemory,
  parseBackup,
  parseOracleHealth,
  parseRisk,
  parseVenueAsOf,
  pushBuyback,
  pushSample,
} from "../src/collect";
import { NOW, supervisor } from "./fixtures";

describe("parsers", () => {
  test("risk state: nested meta (services/risk RiskStatePayload), kill journal", () => {
    const raw = JSON.stringify({
      state: "breach",
      breaches: ["DRAWDOWN"],
      meta: { ts: NOW, killed: false, killReason: null, monitor: { kill: { episodeId: "e", mode: "breach", startedAt: 100, reason: "DD", done: ["cancel_all"], failed: { flatten: 1 } } } },
    });
    expect(parseRisk(raw)).toEqual({
      state: "breach",
      breaches: ["DRAWDOWN"],
      ts: NOW,
      killed: false,
      killReason: null,
      journal: { episodeId: "e", mode: "breach", startedAt: 100, reason: "DD", done: ["cancel_all"], failed: { flatten: 1 } },
    });
    expect(parseRisk(JSON.stringify({ state: "ok", meta: { ts: NOW / 1000 } }))!.ts).toBe(NOW); // seconds tolerated
    expect(parseRisk("nope")).toBeNull();
    expect(parseRisk(JSON.stringify({ meta: {} }))).toBeNull();
    expect(parseRisk(null)).toBeNull();
  });

  test("venue report asOf (s, or ms tolerated)", () => {
    expect(parseVenueAsOf(JSON.stringify({ asOf: 1_700_000_000 }))).toBe(1_700_000_000);
    expect(parseVenueAsOf(JSON.stringify({ asOf: 1_700_000_000_000 }))).toBe(1_700_000_000);
    expect(parseVenueAsOf("{}")).toBeNull();
  });

  test("backup status", () => {
    expect(parseBackup(JSON.stringify({ v: 1, ts: NOW, ok: true, offsite: "ok", bytes: 5, dir: "/x", error: "" }))).toEqual({ ts: NOW, ok: true, offsite: "ok", bytes: 5, dir: "/x", error: "" });
    expect(parseBackup("{}")).toBeNull();
  });

  test("samples: window + buyback de-duplication", () => {
    const s = pushSample([{ ts: NOW - 10_000, value: 1 }, { ts: NOW - 1000, value: 0 }], { ts: NOW, value: 1 }, 5000);
    expect(s).toEqual([{ ts: NOW - 1000, value: 0 }, { ts: NOW, value: 1 }]);
    const b = [{ ts: NOW - 60_000, value: 10 }];
    expect(pushBuyback(b, { ts: NOW, value: 10 }, 600_000, 86_400_000)).toBe(b); // unchanged + recent: skipped
    expect(pushBuyback(b, { ts: NOW, value: 11 }, 600_000, 86_400_000)).toHaveLength(2);
  });
});

describe("collect", () => {
  const db: DbPort = {
    books: async () => [
      { id: 3, name: "NVDA", symbol: "PERP_NVDA_USDC", state: "Live", venue: 0, subscriptionEnds: new Date(NOW - 86_400_000) },
      { id: 4, name: "RHX5", symbol: "RHX5-PERP", state: "Live", venue: 1, subscriptionEnds: null },
    ],
    latestMarkPeriodEnds: async () => [{ bookId: 3, periodEnd: new Date(NOW - 600_000) }],
    killsSince: async () => [{ id: 9, bookId: 3, ts: new Date(NOW - 1000), reason: "DD", breaches: ["DRAWDOWN"] }],
    cursors: async () => [{ name: "indexer:books", block: 99, updatedAt: new Date(NOW - 1000) }],
  };
  const kvData = new Map<string, string>([
    [KEYS.riskState(3), JSON.stringify({ state: "ok", meta: { ts: NOW } })],
    [KEYS.venueReport(3), JSON.stringify({ asOf: NOW / 1000 - 30 })],
    [SUPERVISOR_STATUS_KEY, JSON.stringify(supervisor())],
    [BACKUP_STATUS_KEY, JSON.stringify({ ts: NOW, ok: true })],
    [
      KEYS.venueSymbolIssues,
      JSON.stringify({
        v: 1,
        ts: NOW,
        mode: "live",
        books: [{ bookId: 3, charterSymbol: "NVDA-PERP", error: "no market" }],
        listingMode: "manual",
        markets: [{ symbol: "PERP_NVDA_USDC_bookrunner", bookIds: [3], phase: "awaiting", venueStatus: null, openForRisk: false, everListed: false, since: NOW - 60_000, checkedAt: NOW, failures: 0, error: null }, { symbol: 7 }],
        delistWaits: [{ bookId: 3, symbol: "PERP_NVDA_USDC_bookrunner", since: NOW - 1_000 }, { bookId: "x" }],
      }),
    ],
    [
      KEYS.builderFeedStatus,
      JSON.stringify({
        v: 1,
        ts: NOW,
        intervalMs: 1000,
        maxAgeMs: 10_000,
        socket: { state: "ready", lastError: null, host: "ws-oracle.orderly.org" },
        symbols: [{ symbol: "PERP_NVDA_USDC_bookrunner", base: "NVDA", bookIds: [3], state: "stale", lastPushAt: NOW - 40_000, price: 190, failingSince: NOW - 35_000, error: "x" }],
      }),
    ],
  ]);
  const kv = { get: async (k: string) => kvData.get(k) ?? null, mget: async (ks: string[]) => ks.map((k) => kvData.get(k) ?? null) };
  const chain: ChainPort = {
    head: async () => ({ number: 100, timestamp: NOW / 1000 - 1 }),
    balance: async () => 5n,
    buybackPending: async () => 12_500_000n,
    markInterval: async () => 3600,
  };
  const okFetch = (async () => new Response(JSON.stringify({ ok: true, db: "up", redis: "ready" }))) as unknown as typeof fetch;
  const settings = { network: "testnet", chainId: 46630, apiUrl: "http://api", markIntervalSec: 300, roles: [{ role: "markSigner", address: "0x00000000000000000000000000000000000000aa" as const }], rpcWindowSec: 900 };

  test("assembles every source", async () => {
    const { snapshot: s, memory } = await collect({ db, kv, chain, fetch: okFetch, now: () => NOW }, settings, emptyMemory(), 86_400);
    expect(s.books!.map((b) => [b.bookId, b.venue, b.lastMarkPeriodEnd, b.risk?.state ?? null, b.venueReportAsOf])).toEqual([
      [3, "orderly", NOW / 1000 - 600, "ok", NOW / 1000 - 30],
      [4, "pool_engine", null, null, null],
    ]);
    expect(s.books!.map((b) => b.venueSymbolError)).toEqual(["no market", null]);
    expect(s.venueOps).toEqual({ ts: NOW, mode: "live", builderPush: false, listingMode: "manual" });
    expect(s.books!.map((b) => b.venueMarket?.phase ?? null)).toEqual(["awaiting", null]);
    expect(s.books![0]!.venueMarket).toMatchObject({ symbol: "PERP_NVDA_USDC_bookrunner", since: NOW - 60_000, failures: 0 });
    expect(s.books!.map((b) => b.delistWaitSince)).toEqual([NOW - 1_000, null]);
    expect(s.builderFeed).toEqual({
      ts: NOW,
      socket: { state: "ready", lastError: null },
      symbols: [{ symbol: "PERP_NVDA_USDC_bookrunner", bookIds: [3], state: "stale", lastPushAt: NOW - 40_000, failingSince: NOW - 35_000, error: "x", preListing: false }],
    });
    expect(s.kills).toEqual([{ id: 9, bookId: 3, ts: NOW - 1000, reason: "DD", breaches: ["DRAWDOWN"] }]);
    expect(s.supervisor?.procs[0]!.name).toBe("mark");
    expect(s.backup?.ok).toBe(true);
    expect(s.balances).toEqual([{ role: "markSigner", address: "0x00000000000000000000000000000000000000aa", wei: 5n }]);
    expect(s.rpc).toEqual({ ok: true, head: 100, headTs: NOW / 1000 - 1, error: null });
    expect(s.markIntervalSec).toBe(3600); // on-chain wins over the env value
    expect(s.buybackSamples).toEqual([{ ts: NOW, value: 12.5 }]);
    expect(s.api.ok).toBe(true);
    expect(s.infraErrors).toEqual([]);
    expect(memory.rpcSamples).toEqual([{ ts: NOW, value: 1 }]);
  });

  test("each source fails on its own", async () => {
    const badDb: DbPort = { ...db, books: async () => Promise.reject(new Error("ECONNREFUSED")) };
    const badKv = { get: async () => Promise.reject(new Error("redis down")), mget: async () => Promise.reject(new Error("redis down")) };
    const badChain: ChainPort = { ...chain, head: async () => Promise.reject(new Error("timeout")), markInterval: async () => Promise.reject(new Error("x")) };
    const badFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const { snapshot: s, memory } = await collect({ db: badDb, kv: badKv, chain: badChain, fetch: badFetch, now: () => NOW }, settings, { ...emptyMemory(), markIntervalSec: 3600 }, 86_400);
    expect(s.books).toBeNull();
    expect(s.supervisor).toBeUndefined();
    expect(s.backup).toBeUndefined();
    expect(s.infraErrors.map((e) => e.source)).toEqual(["db", "redis"]);
    expect(s.rpc.ok).toBe(false);
    expect(memory.rpcSamples).toEqual([{ ts: NOW, value: 0 }]);
    expect(s.markIntervalSec).toBe(3600); // last known kept
    expect(s.api).toMatchObject({ ok: false, error: "ECONNREFUSED" });
    expect(s.oracle).toBeNull(); // no oracle URL: not probed
  });

  test("oracle /health: per-source health and the on-chain minSources problem", async () => {
    const body = {
      status: "running",
      sources: [
        { name: "chainlink", kind: "chainlink", lastOkAt: NOW - 1000, failingSince: null, failingTickers: [], lastError: null, lastErrorAt: null },
        { name: "pyth", kind: "pyth", lastOkAt: null, failingSince: NOW - 90_000, failingTickers: ["NVDA"], lastError: "HTTP 401", lastErrorAt: NOW },
      ],
      onchain: { minSourcesProblem: null },
      unpublished: [{ priceId: "NVDA", since: NOW - 150_000, reason: "sources disagree" }, { priceId: 7 }],
    };
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(url.startsWith("http://oracle") ? body : { ok: true, db: "up", redis: "ready" }));
    }) as unknown as typeof fetch;
    const { snapshot: s } = await collect({ db, kv, chain, fetch: f, now: () => NOW }, { ...settings, oracleUrl: "http://oracle:4410" }, emptyMemory(), 86_400);
    expect(urls).toContain("http://oracle:4410/health");
    // an oracle without `policy` / `role` / `confirm` (before primary-confirm): median, role median, no confirm
    expect(s.oracle).toEqual({
      ok: true,
      error: null,
      policy: "median",
      confirmBps: null,
      primaryLagBps: null,
      minSourcesProblem: null,
      sources: [
        { name: "chainlink", kind: "chainlink", role: "median", lastOkAt: NOW - 1000, failingSince: null, failingTickers: [], lastError: null, lastErrorAt: null },
        { name: "pyth", kind: "pyth", role: "median", lastOkAt: null, failingSince: NOW - 90_000, failingTickers: ["NVDA"], lastError: "HTTP 401", lastErrorAt: NOW },
      ],
      confirm: [],
      unpublished: [{ priceId: "NVDA", since: NOW - 150_000, reason: "sources disagree", lastSeenAt: null }],
    });
    expect(parseOracleHealth(null)).toMatchObject({ ok: false, error: "unexpected body", policy: "median", confirm: [] });
    expect(parseOracleHealth({ onchain: { minSourcesProblem: "AttestedOracle.minSources()=3 > 2" } }).minSourcesProblem).toBe("AttestedOracle.minSources()=3 > 2");
    const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const r = await collect({ db, kv, chain, fetch: down, now: () => NOW }, { ...settings, oracleUrl: "http://oracle:4410" }, emptyMemory(), 86_400);
    expect(r.snapshot.oracle).toEqual({ ok: false, error: "HTTP 503", policy: "median", confirmBps: null, primaryLagBps: null, sources: [], confirm: [], minSourcesProblem: null, unpublished: [] });
  });

  test("oracle /health primary-confirm: policy, confirmBps, source roles, confirm[]", () => {
    const p = parseOracleHealth({
      policy: "primary-confirm",
      confirmBps: 200,
      primaryLagBps: 100,
      sources: [
        { name: "chainlink", kind: "chainlink", role: "primary", lastOkAt: NOW - 1000, failingSince: null, failingTickers: [], lastError: null, lastErrorAt: null },
        { name: "dex-twap", kind: "dex", role: "confirm", lastOkAt: NOW - 1000, failingSince: NOW - 5000, failingTickers: ["TSLA"], lastError: "timeout", lastErrorAt: NOW },
        { name: "odd", kind: "x", role: "boss", lastOkAt: null, failingSince: null, failingTickers: [], lastError: null },
      ],
      confirm: [
        { priceId: "NVDA", status: "diverged", diffBps: 260.4, since: NOW - 180_000, checkedAt: NOW - 1000, primaryPrice: 180, primaryTs: NOW - 900_000, lagSince: NOW - 600_000, confirmers: [{ name: "dex-twap", price: 184.7, diffBps: 260.4 }, { name: 5 }, { name: "pyth", price: "x", diffBps: 1 }] },
        { priceId: "TSLA", status: "unavailable", diffBps: null, since: NOW - 700_000, checkedAt: NOW - 1000, primaryPrice: 250, confirmers: [] },
        { priceId: "AAPL", status: "closed", diffBps: null, since: null, checkedAt: NOW - 1000, primaryPrice: null },
        { priceId: "AMZN", status: "no-primary", diffBps: null, since: NOW - 60_000, checkedAt: NOW - 1000, primaryPrice: null, confirmers: [] },
        { priceId: "MSFT", status: "weird", diffBps: 1, since: NOW, checkedAt: NOW, primaryPrice: 1, confirmers: [] },
        { status: "ok" },
        { priceId: "X".repeat(100), status: "ok", diffBps: "12", since: "nope", checkedAt: NOW, primaryPrice: 1, confirmers: "nope" },
        null,
        "NVDA",
      ],
    });
    expect(p.policy).toBe("primary-confirm");
    expect(p.confirmBps).toBe(200);
    expect(p.primaryLagBps).toBe(100);
    expect(p.sources.map((x) => [x.name, x.role])).toEqual([
      ["chainlink", "primary"],
      ["dex-twap", "confirm"],
      ["odd", "median"], // unknown role -> median
    ]);
    expect(p.confirm).toEqual([
      { priceId: "NVDA", status: "diverged", diffBps: 260.4, since: NOW - 180_000, checkedAt: NOW - 1000, primaryPrice: 180, primaryTs: NOW - 900_000, lagSince: NOW - 600_000, confirmers: [{ name: "dex-twap", price: 184.7, diffBps: 260.4 }] },
      { priceId: "TSLA", status: "unavailable", diffBps: null, since: NOW - 700_000, checkedAt: NOW - 1000, primaryPrice: 250, primaryTs: null, lagSince: null, confirmers: [] },
      { priceId: "AAPL", status: "closed", diffBps: null, since: null, checkedAt: NOW - 1000, primaryPrice: null, primaryTs: null, lagSince: null, confirmers: [] },
      { priceId: "AMZN", status: "no-primary", diffBps: null, since: NOW - 60_000, checkedAt: NOW - 1000, primaryPrice: null, primaryTs: null, lagSince: null, confirmers: [] },
      { priceId: "X".repeat(64), status: "ok", diffBps: 12, since: null, checkedAt: NOW, primaryPrice: 1, primaryTs: null, lagSince: null, confirmers: [] },
    ]);
    // unknown policy / malformed fields: median, null, []
    expect(parseOracleHealth({ policy: "vote", confirmBps: "abc", confirm: {} })).toMatchObject({ ok: true, policy: "median", confirmBps: null, confirm: [] });
  });
});
