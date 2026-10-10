import { describe, expect, test } from "bun:test";
import { KEYS } from "@bookrunner/shared/queues";
import { SUPERVISOR_STATUS_KEY } from "@bookrunner/shared/supervisor";
import { BACKUP_STATUS_KEY, type ChainPort, type DbPort, collect, emptyMemory, parseBackup, parseRisk, parseVenueAsOf, pushBuyback, pushSample } from "../src/collect";
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
  });
});
