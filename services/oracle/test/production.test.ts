// Mainnet production rules (production.ts): synthetic impossible on 4663, Chainlink + an independent
// source, minimum sources, explicit feed basis, calendar holds.
import { describe, expect, test } from "bun:test";
import { loadOracleConfig } from "../src/config";
import type { PriceSource } from "../src/domain/types";
import {
  MAINNET_MIN_SOURCES_FLOOR,
  liveSourceCount,
  onchainMinSourcesProblem,
  productionProblems,
  startupOnchainMinSourcesProblem,
} from "../src/production";

const src = (name: string, kind?: PriceSource["kind"]): PriceSource => ({ name, ...(kind ? { kind } : {}), fetch: async () => null });
const chainlink = src("chainlink", "chainlink");
const httpA = src("http-a", "http");
const httpB = src("http-b");
const pyth = src("pyth", "pyth");

const mainnet = (env: Record<string, string> = {}) =>
  loadOracleConfig({ CHAIN_ID: "4663", ORACLE_SYNTHETIC: "0", SESSIONS_MODE: "charter", ORACLE_MIN_SOURCES: "3", ...env });

describe("productionProblems", () => {
  test("a production-ready mainnet config has none", () => {
    expect(productionProblems(mainnet(), [chainlink, httpA, httpB])).toEqual([]);
  });

  test("off mainnet nothing is enforced", () => {
    expect(productionProblems(loadOracleConfig({}), [src("synthetic-a", "synthetic")])).toEqual([]);
    expect(productionProblems(loadOracleConfig({ CHAIN_ID: "46630" }), [])).toEqual([]);
  });

  test("synthetic sources are impossible on 4663", () => {
    const p = productionProblems(mainnet({ ORACLE_SYNTHETIC: "1" }), [chainlink, httpA, httpB, src("synthetic-a", "synthetic")]);
    expect(p.some((x) => x.includes("ORACLE_SYNTHETIC must be 0"))).toBe(true);
    expect(p.some((x) => x.includes("synthetic sources configured: synthetic-a"))).toBe(true);
  });

  test("Chainlink + an independent source, and enough distinct sources for the minimum", () => {
    expect(productionProblems(mainnet(), [httpA, httpB, src("http-c")]).join("\n")).toContain("no Chainlink feeds");
    expect(productionProblems(mainnet({ ORACLE_MIN_SOURCES: "1" }), [chainlink]).join("\n")).toContain("no live source besides Chainlink");
    expect(productionProblems(mainnet(), [chainlink, httpA]).join("\n")).toContain("2 distinct live sources < ORACLE_MIN_SOURCES=3");
    expect(productionProblems(mainnet({ ORACLE_MIN_SOURCES: "1" }), [chainlink, httpA]).join("\n")).toContain(
      `below the mainnet floor ${MAINNET_MIN_SOURCES_FLOOR}`,
    );
  });

  test("the mainnet design: Chainlink + Pyth Pro with ORACLE_MIN_SOURCES=2", () => {
    const two = mainnet({ ORACLE_MIN_SOURCES: "2", ORACLE_PYTH: "1", PYTH_API_KEY: "k" });
    expect(productionProblems(two, [chainlink, pyth])).toEqual([]);
    // Pyth is an independent live source; Chainlink alone is still refused
    const has = (p: string[], s: string) => p.some((x) => x.includes(s));
    expect(has(productionProblems(mainnet({ ORACLE_MIN_SOURCES: "2" }), [chainlink]), "no live source besides Chainlink (ORACLE_PYTH=1 + PYTH_API_KEY")).toBe(true);
    expect(has(productionProblems(mainnet({ ORACLE_MIN_SOURCES: "2" }), [pyth]), "no Chainlink feeds")).toBe(true);
    // the default minimum (3) is not reachable with two sources
    expect(has(productionProblems(mainnet({ ORACLE_PYTH: "1", PYTH_API_KEY: "k" }), [chainlink, pyth]), "2 distinct live sources < ORACLE_MIN_SOURCES=3")).toBe(true);
    // ORACLE_PYTH=1 without a key is named (buildSources skipped the source)
    expect(has(productionProblems(mainnet({ ORACLE_MIN_SOURCES: "2", ORACLE_PYTH: "1" }), [chainlink]), "ORACLE_PYTH=1 but PYTH_API_KEY is not set")).toBe(true);
    // every launch ticker needs a Pyth feed id
    const gme = mainnet({ ORACLE_MIN_SOURCES: "2", ORACLE_PYTH: "1", PYTH_API_KEY: "k", ORACLE_TICKERS: "NVDA,GME", ORACLE_CHAINLINK_FEEDS: '{"GME":{"proxy":"0x00000000000000000000000000000000000000c1","basis":"per-share"}}' });
    expect(productionProblems(gme, [chainlink, pyth])).toEqual(["no Pyth Pro feed id for GME (ORACLE_PYTH_FEEDS)"]);
    // and no problem text ever carries the key
    for (const p of productionProblems(mainnet({ ORACLE_PYTH: "1", PYTH_API_KEY: "secret-k" }), [chainlink])) expect(p).not.toContain("secret-k");
  });

  test("on-chain minSources must be reachable by the configured live sources", async () => {
    expect(liveSourceCount([chainlink, pyth, src("synthetic-a", "synthetic"), src("pyth", "pyth")])).toBe(2);
    expect(onchainMinSourcesProblem(2, [chainlink, pyth])).toBeNull();
    expect(onchainMinSourcesProblem(1, [chainlink, pyth])).toBeNull();
    const p = onchainMinSourcesProblem(3, [chainlink, pyth]);
    expect(p).toContain("AttestedOracle.minSources()=3 > 2 configured live sources");
    expect(p).toContain("setMinSources(2)");

    expect(await startupOnchainMinSourcesProblem({ readMinSources: async () => 2, sources: [chainlink, pyth] })).toBeNull();
    expect(await startupOnchainMinSourcesProblem({ readMinSources: async () => 3, sources: [chainlink, pyth] })).toContain("minSources()=3 > 2");
    // RPC hiccups are retried; a contract that stays unreadable refuses the start
    let n = 0;
    const flaky = async () => {
      if (++n < 3) throw new Error("fetch failed");
      return 2;
    };
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    expect(await startupOnchainMinSourcesProblem({ readMinSources: flaky, sources: [chainlink, pyth], sleep, delayMs: 5 })).toBeNull();
    expect(sleeps).toEqual([5, 5]);
    const dead = await startupOnchainMinSourcesProblem({
      readMinSources: async () => {
        throw new Error(["execution reverted", "long trace"].join(String.fromCharCode(10)));
      },
      sources: [chainlink, pyth],
      sleep,
      attempts: 2,
    });
    expect(dead).toBe("AttestedOracle.minSources() not readable (execution reverted): cannot check it against the configured sources");
  });

  test("feed basis must be explicit; every launch ticker needs a feed; 24x7 demo sessions refused", () => {
    const legacy = mainnet({ ORACLE_CHAINLINK_FEEDS: '{"NVDA":"0x00000000000000000000000000000000000000c1"}' });
    expect(productionProblems(legacy, [chainlink, httpA, httpB]).join("\n")).toContain("ORACLE_CHAINLINK_FEEDS.NVDA is a plain address");
    expect(productionProblems(mainnet({ ORACLE_TICKERS: "NVDA,GME" }), [chainlink, httpA, httpB]).join("\n")).toContain("no Chainlink feed for GME");
    expect(productionProblems(mainnet({ SESSIONS_MODE: "24x7" }), [chainlink, httpA, httpB]).join("\n")).toContain("SESSIONS_MODE=24x7");
  });
});
