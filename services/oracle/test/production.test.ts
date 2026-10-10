// Mainnet production rules (production.ts): synthetic impossible on 4663, Chainlink + an independent
// source, minimum sources, explicit feed basis, calendar holds.
import { describe, expect, test } from "bun:test";
import { loadOracleConfig } from "../src/config";
import type { PriceSource } from "../src/domain/types";
import { MAINNET_MIN_SOURCES_FLOOR, productionProblems } from "../src/production";

const src = (name: string, kind?: PriceSource["kind"]): PriceSource => ({ name, ...(kind ? { kind } : {}), fetch: async () => null });
const chainlink = src("chainlink", "chainlink");
const httpA = src("http-a", "http");
const httpB = src("http-b");

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

  test("feed basis must be explicit; every launch ticker needs a feed; 24x7 demo sessions refused", () => {
    const legacy = mainnet({ ORACLE_CHAINLINK_FEEDS: '{"NVDA":"0x00000000000000000000000000000000000000c1"}' });
    expect(productionProblems(legacy, [chainlink, httpA, httpB]).join("\n")).toContain("ORACLE_CHAINLINK_FEEDS.NVDA is a plain address");
    expect(productionProblems(mainnet({ ORACLE_TICKERS: "NVDA,GME" }), [chainlink, httpA, httpB]).join("\n")).toContain("no Chainlink feed for GME");
    expect(productionProblems(mainnet({ SESSIONS_MODE: "24x7" }), [chainlink, httpA, httpB]).join("\n")).toContain("SESSIONS_MODE=24x7");
  });
});
