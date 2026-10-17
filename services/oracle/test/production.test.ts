// Mainnet production rules (production.ts): synthetic impossible on 4663; the 3-source design (Chainlink +
// Pyth Pro + one more, ORACLE_MIN_SOURCES=2, one spare); explicit feed basis; calendar holds.
import { describe, expect, test } from "bun:test";
import { loadOracleConfig } from "../src/config";
import type { PriceSource } from "../src/domain/types";
import {
  MAINNET_MIN_SOURCES_FLOOR,
  MAINNET_SPARE_SOURCES,
  liveSourceCount,
  onchainMinSourcesProblem,
  productionProblems,
  startupOnchainMinSourcesProblem,
} from "../src/production";

const src = (name: string, kind?: PriceSource["kind"]): PriceSource => ({ name, ...(kind ? { kind } : {}), fetch: async () => null });
const chainlink = src("chainlink", "chainlink");
const pyth = src("pyth", "pyth");
const third = src("vendor", "http");
const httpB = src("http-b");
const THREE = [chainlink, pyth, third];

const mainnet = (env: Record<string, string> = {}) =>
  loadOracleConfig({ CHAIN_ID: "4663", ORACLE_SYNTHETIC: "0", SESSIONS_MODE: "charter", ORACLE_MIN_SOURCES: "2", ORACLE_PYTH: "1", PYTH_API_KEY: "k", ...env });
const has = (p: string[], s: string) => p.some((x) => x.includes(s));

describe("productionProblems", () => {
  test("the mainnet design (Chainlink + Pyth Pro + a third source, ORACLE_MIN_SOURCES=2) has none", () => {
    expect(productionProblems(mainnet(), THREE)).toEqual([]);
    expect(productionProblems(mainnet(), [...THREE, httpB])).toEqual([]);
  });

  test("off mainnet nothing is enforced", () => {
    expect(productionProblems(loadOracleConfig({}), [src("synthetic-a", "synthetic")])).toEqual([]);
    expect(productionProblems(loadOracleConfig({ CHAIN_ID: "46630" }), [])).toEqual([]);
  });

  test("synthetic sources are impossible on 4663", () => {
    const p = productionProblems(mainnet({ ORACLE_SYNTHETIC: "1" }), [...THREE, src("synthetic-a", "synthetic")]);
    expect(has(p, "ORACLE_SYNTHETIC must be 0")).toBe(true);
    expect(has(p, "synthetic sources configured: synthetic-a")).toBe(true);
  });

  test("Chainlink, Pyth Pro and a third source are each required; 3 distinct live sources and one spare", () => {
    expect(productionProblems(mainnet(), [pyth, third, httpB])).toEqual(["no Chainlink feeds configured (config/chains/4663.json or ORACLE_CHAINLINK_FEEDS)"]);
    expect(productionProblems(mainnet(), [chainlink, third, httpB])).toEqual(["no Pyth Pro source (ORACLE_PYTH=1 + PYTH_API_KEY)"]);
    expect(productionProblems(mainnet(), [chainlink, pyth])).toEqual([
      "no third live source besides Chainlink and Pyth Pro (ORACLE_HTTP_SOURCES or a preset): one source outage would stop every price",
      "2 distinct live sources < 3 required on mainnet (Chainlink + Pyth Pro + >= 1 more; ORACLE_MIN_SOURCES=2 + 1 spare)",
    ]);
    // a higher minimum needs a spare beyond it
    expect(productionProblems(mainnet({ ORACLE_MIN_SOURCES: "3" }), THREE)).toEqual([
      "3 distinct live sources < 4 required on mainnet (Chainlink + Pyth Pro + >= 1 more; ORACLE_MIN_SOURCES=3 + 1 spare)",
    ]);
    expect(has(productionProblems(mainnet({ ORACLE_MIN_SOURCES: "1" }), THREE), `below the mainnet floor ${MAINNET_MIN_SOURCES_FLOOR}`)).toBe(true);
  });

  test("every HTTP source carries its own quote timestamp and a tight in-session max age; Finnhub is refused", () => {
    const spec = (over: Record<string, unknown>) =>
      mainnet({ ORACLE_HTTP_SOURCES: JSON.stringify([{ name: "vendor", url: "https://v.example/{ticker}", pricePath: "p", tsPath: "t", tsUnit: "ms", maxAgeMs: 10_000, ...over }]) });
    expect(productionProblems(spec({}), THREE)).toEqual([]);
    expect(productionProblems(spec({ maxAgeMs: 30_000 }), THREE)).toEqual([]);
    expect(productionProblems(spec({ tsPath: undefined }), THREE)).toEqual([
      "ORACLE_HTTP_SOURCES.vendor has no tsPath: on mainnet every quote must carry the vendor's own timestamp (receive time would make a stale last trade look fresh)",
    ]);
    expect(productionProblems(spec({ maxAgeMs: 30_001 }), THREE)).toEqual(["ORACLE_HTTP_SOURCES.vendor needs maxAgeMs <= 30000 on mainnet (got 30001)"]);
    expect(productionProblems(spec({ maxAgeMs: undefined }), THREE)).toEqual([
      "ORACLE_HTTP_SOURCES.vendor needs maxAgeMs <= 30000 on mainnet (got unset: the 15 s default is not pinned)",
    ]);
    expect(has(productionProblems(mainnet({ ORACLE_HTTP_FINNHUB: "1", ORACLE_FINNHUB_API_KEY: "f" }), THREE), "ORACLE_HTTP_FINNHUB is not a mainnet source")).toBe(true);
  });

  test("Pyth Pro configuration: key, feed ids per launch ticker, https, never the key in a problem", () => {
    // ORACLE_PYTH=1 without a key is named (buildSources skipped the source)
    const noKey = productionProblems(mainnet({ PYTH_API_KEY: "" }), [chainlink, third, httpB]);
    expect(has(noKey, "ORACLE_PYTH=1 but PYTH_API_KEY is not set")).toBe(true);
    const gme = mainnet({ ORACLE_TICKERS: "NVDA,GME", ORACLE_CHAINLINK_FEEDS: '{"GME":{"proxy":"0x00000000000000000000000000000000000000c1","basis":"per-share"}}' });
    expect(productionProblems(gme, THREE)).toEqual(["no Pyth Pro feed id for GME (ORACLE_PYTH_FEEDS)"]);
    const plainHttp = mainnet({ ORACLE_PYTH_URL: "http://pyth.example/v1/latest_price" });
    expect(productionProblems(plainHttp, THREE)).toEqual(["ORACLE_PYTH_URL must be https:// on mainnet (the access token travels in its Authorization header)"]);
    for (const p of productionProblems(mainnet({ PYTH_API_KEY: "secret-k", ORACLE_MIN_SOURCES: "5" }), [chainlink])) expect(p).not.toContain("secret-k");
  });

  test("on-chain minSources must leave one spare live source on mainnet", async () => {
    expect(liveSourceCount([chainlink, pyth, src("synthetic-a", "synthetic"), src("pyth", "pyth")])).toBe(2);
    expect(MAINNET_SPARE_SOURCES).toBe(1);
    expect(onchainMinSourcesProblem(2, THREE, 1)).toBeNull();
    expect(onchainMinSourcesProblem(2, [chainlink, pyth])).toBeNull(); // no spare asked (off mainnet)
    expect(onchainMinSourcesProblem(2, [chainlink, pyth], 1)).toBe(
      "AttestedOracle.minSources()=2 leaves no spare among 2 configured live sources: one source outage would stop every price (need 3; configure another source or lower it through the timelock)",
    );
    const p = onchainMinSourcesProblem(4, THREE, 1);
    expect(p).toContain("AttestedOracle.minSources()=4 > 3 configured live sources");
    expect(p).toContain("setMinSources(2)");

    expect(await startupOnchainMinSourcesProblem({ readMinSources: async () => 2, sources: THREE, spare: 1 })).toBeNull();
    expect(await startupOnchainMinSourcesProblem({ readMinSources: async () => 3, sources: THREE, spare: 1 })).toContain("leaves no spare");
    // RPC hiccups are retried; a contract that stays unreadable refuses the start
    let n = 0;
    const flaky = async () => {
      if (++n < 3) throw new Error("fetch failed");
      return 2;
    };
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    expect(await startupOnchainMinSourcesProblem({ readMinSources: flaky, sources: THREE, spare: 1, sleep, delayMs: 5 })).toBeNull();
    expect(sleeps).toEqual([5, 5]);
    const dead = await startupOnchainMinSourcesProblem({
      readMinSources: async () => {
        throw new Error(["execution reverted", "long trace"].join(String.fromCharCode(10)));
      },
      sources: THREE,
      sleep,
      attempts: 2,
    });
    expect(dead).toBe("AttestedOracle.minSources() not readable (execution reverted): cannot check it against the configured sources");
  });

  test("feed basis must be explicit; every launch ticker needs a feed; 24x7 demo sessions refused", () => {
    const legacy = mainnet({ ORACLE_CHAINLINK_FEEDS: '{"NVDA":"0x00000000000000000000000000000000000000c1"}' });
    expect(has(productionProblems(legacy, THREE), "ORACLE_CHAINLINK_FEEDS.NVDA is a plain address")).toBe(true);
    expect(has(productionProblems(mainnet({ ORACLE_TICKERS: "NVDA,GME", ORACLE_PYTH_FEEDS: '{"GME":7}' }), THREE), "no Chainlink feed for GME")).toBe(true);
    expect(has(productionProblems(mainnet({ SESSIONS_MODE: "24x7" }), THREE), "SESSIONS_MODE=24x7")).toBe(true);
  });
});
