// Tech update #9 BuybackGuard alert rules (rules-guard.ts) and the collector's wiring of the guard reads.
import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { type ChainPort, type DbPort, collect, emptyMemory } from "../src/collect";
import { loadConfig } from "../src/config";
import { evaluate } from "../src/rules";
import { BUYBACK_GUARD_RULES, buybackDepthZero, ethReferenceFallbackExpiring, ethReferenceStale } from "../src/rules-guard";
import type { EthRefSnap } from "../src/types";
import { NOW, NOW_S, rules, snap } from "./fixtures";

const GUARD = "0x00000000000000000000000000000000000000e1";
const ref = (o: Partial<EthRefSnap> = {}): EthRefSnap => ({ address: GUARD, configured: true, source: 1, valueWad: 2000n * 10n ** 18n, storedAt: NOW_S - 120, fallbackExpiry: NOW_S + 20 * 86_400, maxAgeSec: 3600, ...o });
const keys = (s: ReturnType<typeof snap>) => evaluate(s, rules()).filter((c) => ["eth_reference_stale", "eth_reference_fallback_expiring", "buyback_depth_zero"].includes(c.rule)).map((c) => [c.key, c.severity]);

describe("absent / healthy", () => {
  test("a fresh on-chain TWAP, no guard (null) or a failed read (undefined): quiet", () => {
    for (const rule of Object.values(BUYBACK_GUARD_RULES)) expect(rule(snap({ ethReference: ref() }), rules())).toEqual([]);
    expect(keys(snap({ ethReference: null }))).toEqual([]);
    expect(keys(snap({ ethReference: undefined }))).toEqual([]);
    expect(keys(snap({ ethReference: ref({ source: 2 }) }))).not.toEqual([]); // fires when the data says so
  });
});

describe("eth_reference_stale", () => {
  test("fallback in force: warning (forSec 900, naming the age); nothing in force: critical; no pool configured: quiet", () => {
    const fb = ethReferenceStale(snap({ ethReference: ref({ source: 2, storedAt: NOW_S - 7200, valueWad: 1900n * 10n ** 18n }) }), rules());
    expect(fb.map((c) => [c.key, c.severity, c.forSec])).toEqual([["eth_reference_stale", "warning", 900]]);
    expect(fb[0]!.summary).toContain("FALLBACK");
    expect(fb[0]!.summary).toContain("1900.00 USDG/ETH");
    const none = ethReferenceStale(snap({ ethReference: ref({ source: 0, valueWad: 0n, storedAt: 0 }) }), rules());
    expect(none.map((c) => c.severity)).toEqual(["critical"]);
    expect(none[0]!.summary).toContain("via-ETH buybacks revert");
    expect(ethReferenceStale(snap({ ethReference: ref({ configured: false, source: 0 }) }), rules())).toEqual([]);
  });
});

describe("eth_reference_fallback_expiring", () => {
  test("only while the fallback is the reference in force: warning under 3 days, critical under 6 hours", () => {
    const at = (left: number, source = 2) => ethReferenceFallbackExpiring(snap({ ethReference: ref({ source, fallbackExpiry: NOW_S + left }) }), rules());
    expect(at(3 * 86_400)).toEqual([]);
    expect(at(3 * 86_400 - 1).map((c) => c.severity)).toEqual(["warning"]);
    expect(at(6 * 3600 - 1).map((c) => c.severity)).toEqual(["critical"]);
    expect(at(3600, 1)).toEqual([]); // a fresh TWAP is in force: the fallback expiring does not matter
    expect(ethReferenceFallbackExpiring(snap({ ethReference: ref({ source: 2, fallbackExpiry: 0 }) }), rules())).toEqual([]);
  });
});

describe("buyback_depth_zero", () => {
  test("a zero depth cap with buybackPending above the floor: warning (forSec 900); a positive / unknown cap or a small pending amount: quiet", () => {
    const samples = [{ ts: NOW - 60_000, value: 500 }];
    const c = buybackDepthZero(snap({ buybackDepthCapUsd: 0, buybackSamples: samples }), rules());
    expect(c.map((x) => [x.key, x.severity, x.forSec])).toEqual([["buyback_depth_zero", "warning", 900]]);
    expect(buybackDepthZero(snap({ buybackDepthCapUsd: 25, buybackSamples: samples }), rules())).toEqual([]);
    expect(buybackDepthZero(snap({ buybackDepthCapUsd: null, buybackSamples: samples }), rules())).toEqual([]);
    expect(buybackDepthZero(snap({ buybackDepthCapUsd: 0, buybackSamples: [{ ts: NOW, value: 1 }] }), rules())).toEqual([]);
  });
});

describe("collect: the guard reads", () => {
  const db: DbPort = {
    books: async () => [],
    recentKills: async () => [],
    indexerCursors: async () => [],
    charters: async () => [],
  } as unknown as DbPort;
  const baseChain = (over: Partial<ChainPort>): ChainPort => ({
    head: async () => ({ number: 1, timestamp: NOW_S }),
    balance: async () => parseEther("1"),
    buybackPending: async () => 0n,
    markInterval: async () => 3600,
    ...over,
  });
  const cfg = loadConfig({ NETWORK: "testnet", CHAIN_ID: "46630" });
  const run = async (chain: ChainPort) => {
    const deps = { db, kv: { get: async () => null, mget: async (k: string[]) => k.map(() => null) }, chain, fetch: (async () => new Response("{}")) as unknown as typeof fetch, now: () => NOW };
    const st = { network: cfg.network, chainId: cfg.chainId, apiUrl: cfg.apiUrl, oracleUrl: cfg.oracleUrl, markIntervalSec: 3600, roles: [], rpcWindowSec: 900, sessionsMode: cfg.sessionsMode };
    return (await collect(deps as never, st as never, emptyMemory(), 3600)).snapshot;
  };

  test("the depth cap in USD (max uint256 = no depth source), the ETH reference; a failed ethReference read is undefined, a failed cap null", async () => {
    const s1 = await run(baseChain({ buybackDepthCap: async () => 25_000_000n, ethReference: async () => ref() }));
    expect(s1.buybackDepthCapUsd).toBe(25);
    expect(s1.ethReference).toMatchObject({ source: 1 });
    const s2 = await run(baseChain({ buybackDepthCap: async () => 2n ** 256n - 1n, ethReference: async () => null }));
    expect(s2.buybackDepthCapUsd).toBeNull();
    expect(s2.ethReference).toBeNull();
    const s3 = await run(
      baseChain({
        buybackDepthCap: async () => {
          throw new Error("EthReferenceUnavailable");
        },
        ethReference: async () => {
          throw new Error("rpc");
        },
      }),
    );
    expect(s3.buybackDepthCapUsd).toBeNull();
    expect(s3.ethReference).toBeUndefined();
    const s4 = await run(baseChain({}));
    expect(s4.ethReference).toBeNull(); // no port
  });
});
