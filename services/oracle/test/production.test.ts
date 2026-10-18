// Mainnet production rules (production.ts): synthetic impossible on 4663; primary-confirm (Chainlink signs with
// sourceCount 1, a DEX confirm pool per ticker, ORACLE_MIN_SOURCES=1, on-chain minSources() == 1); Pyth optional;
// explicit feed basis; calendar holds.
import { describe, expect, test } from "bun:test";
import { loadOracleConfig } from "../src/config";
import type { PriceSource } from "../src/domain/types";
import {
  MAINNET_DEX_MIN_FLOOR_USD,
  chainlinkAgeProblems,
  PRIMARY_CONFIRM_SOURCE_COUNT,
  liveSourceCount,
  onchainMinSourcesProblem,
  productionProblems,
  startupOnchainMinSourcesProblem,
} from "../src/production";

const src = (name: string, kind?: PriceSource["kind"]): PriceSource => ({ name, ...(kind ? { kind } : {}), fetch: async () => null });
const chainlink = src("chainlink", "chainlink");
const dex = src("dex-twap", "dex");
const pyth = src("pyth", "pyth");
const vendor = src("vendor", "http");
const BASE = [chainlink, dex];

const mainnet = (env: Record<string, string> = {}) => loadOracleConfig({ CHAIN_ID: "4663", ORACLE_SYNTHETIC: "0", SESSIONS_MODE: "charter", ...env });
const has = (p: string[], s: string) => p.some((x) => x.includes(s));

describe("productionProblems", () => {
  test("the mainnet design (Chainlink + the DEX TWAP confirm, defaults) has none; Pyth / HTTP confirmers are optional", () => {
    expect(productionProblems(mainnet(), BASE)).toEqual([]);
    expect(productionProblems(mainnet({ ORACLE_PYTH: "1", PYTH_API_KEY: "k" }), [...BASE, pyth])).toEqual([]);
    expect(productionProblems(mainnet({ ORACLE_POLICY: "primary-confirm", ORACLE_MIN_SOURCES: "1" }), BASE)).toEqual([]);
  });

  test("off mainnet nothing is enforced", () => {
    expect(productionProblems(loadOracleConfig({}), [src("synthetic-a", "synthetic")])).toEqual([]);
    expect(productionProblems(loadOracleConfig({ CHAIN_ID: "46630" }), [])).toEqual([]);
  });

  test("synthetic sources are impossible on 4663", () => {
    const p = productionProblems(mainnet({ ORACLE_SYNTHETIC: "1" }), [...BASE, src("synthetic-a", "synthetic")]);
    expect(has(p, "ORACLE_SYNTHETIC must be 0")).toBe(true);
    expect(has(p, "synthetic sources configured: synthetic-a")).toBe(true);
  });

  test("primary-confirm only: ORACLE_POLICY=median and any minimum other than 1 are refused", () => {
    expect(productionProblems(mainnet({ ORACLE_POLICY: "median" }), BASE)).toEqual([
      "ORACLE_POLICY=median on mainnet: set ORACLE_POLICY=primary-confirm (Chainlink signs, the DEX TWAP / Pyth only confirm)",
      "ORACLE_MIN_SOURCES=3 on mainnet: must be 1 (primary-confirm signs every price with sourceCount 1)",
    ]);
    expect(productionProblems(mainnet({ ORACLE_MIN_SOURCES: "2" }), BASE)).toEqual([
      "ORACLE_MIN_SOURCES=2 on mainnet: must be 1 (primary-confirm signs every price with sourceCount 1)",
    ]);
    expect(productionProblems(mainnet({ ORACLE_CONFIRM_BPS: "501" }), BASE)).toEqual([
      "ORACLE_CONFIRM_BPS=501 > 500 on mainnet (a wider band would hide a lagging Chainlink feed)",
    ]);
    expect(productionProblems(mainnet({ ORACLE_CONFIRM_BPS: "500" }), BASE)).toEqual([]);
  });

  test("Chainlink is required (the only signing source), with a feed for every ticker", () => {
    expect(productionProblems(mainnet(), [dex, pyth])).toEqual([
      "no Chainlink feeds configured (config/chains/4663.json or ORACLE_CHAINLINK_FEEDS): Chainlink is the only signing source",
    ]);
    const gme = mainnet({ ORACLE_TICKERS: "NVDA,GME" });
    expect(productionProblems(gme, BASE)).toEqual(["no Chainlink feed for GME", "no DEX confirm pool for GME (dexConfirm.pools in the chain config)"]);
  });

  test("a DEX confirm pool per ticker, with a real liquidity floor; ORACLE_DEX_CONFIRM=0 refused", () => {
    expect(productionProblems(mainnet(), [chainlink])).toEqual(["no DEX confirm source (config/chains/4663.json dexConfirm.pools)"]);
    expect(productionProblems(mainnet({ ORACLE_DEX_CONFIRM: "0" }), [chainlink])).toEqual([
      "ORACLE_DEX_CONFIRM=0 on mainnet: the Uniswap v3 TWAP confirm source is required (a DEX confirm pool per ticker)",
    ]);
    const cfg = mainnet();
    const { AMZN: _amzn, ...four } = cfg.dexPools;
    expect(productionProblems({ ...cfg, dexPools: four }, BASE)).toEqual(["no DEX confirm pool for AMZN (dexConfirm.pools in the chain config)"]);
    const shallow = { ...cfg.dexPools, TSLA: { ...cfg.dexPools.TSLA!, minDepthUsd: MAINNET_DEX_MIN_FLOOR_USD - 1 } };
    expect(productionProblems({ ...cfg, dexPools: shallow }, BASE)).toEqual([
      `dexConfirm.pools.TSLA.minDepthUsd=${MAINNET_DEX_MIN_FLOOR_USD - 1} < ${MAINNET_DEX_MIN_FLOOR_USD} on mainnet (a shallow pool is cheap to move)`,
    ]);
  });

  test("HTTP confirm sources carry their own quote timestamp and a tight max age; Finnhub is refused", () => {
    const spec = (over: Record<string, unknown>) =>
      mainnet({ ORACLE_HTTP_SOURCES: JSON.stringify([{ name: "vendor", url: "https://v.example/{ticker}", pricePath: "p", tsPath: "t", tsUnit: "ms", maxAgeMs: 10_000, ...over }]) });
    expect(productionProblems(spec({}), [...BASE, vendor])).toEqual([]);
    expect(productionProblems(spec({ tsPath: undefined }), [...BASE, vendor])).toEqual([
      "ORACLE_HTTP_SOURCES.vendor has no tsPath: on mainnet every quote must carry the vendor's own timestamp (receive time would make a stale last trade look fresh)",
    ]);
    expect(productionProblems(spec({ maxAgeMs: 30_001 }), [...BASE, vendor])).toEqual(["ORACLE_HTTP_SOURCES.vendor needs maxAgeMs <= 30000 on mainnet (got 30001)"]);
    expect(has(productionProblems(mainnet({ ORACLE_HTTP_FINNHUB: "1", ORACLE_FINNHUB_API_KEY: "f" }), BASE), "ORACLE_HTTP_FINNHUB is not a mainnet source")).toBe(true);
  });

  test("optional Pyth Pro: when on it needs its key, https and feed ids; never the key in a problem", () => {
    expect(has(productionProblems(mainnet({ ORACLE_PYTH: "1" }), BASE), "ORACLE_PYTH=1 but PYTH_API_KEY is not set")).toBe(true);
    const plainHttp = mainnet({ ORACLE_PYTH: "1", PYTH_API_KEY: "k", ORACLE_PYTH_URL: "http://pyth.example/v1/latest_price" });
    expect(productionProblems(plainHttp, [...BASE, pyth])).toEqual(["ORACLE_PYTH_URL must be https:// on mainnet (the access token travels in its Authorization header)"]);
    const gme = mainnet({ ORACLE_PYTH: "1", PYTH_API_KEY: "k", ORACLE_TICKERS: "NVDA,GME" });
    expect(has(productionProblems(gme, [...BASE, pyth]), "no Pyth Pro feed id for GME")).toBe(true);
    for (const p of productionProblems(mainnet({ ORACLE_PYTH: "1", PYTH_API_KEY: "secret-k", ORACLE_MIN_SOURCES: "5" }), [chainlink])) expect(p).not.toContain("secret-k");
  });

  test("Chainlink freshness bound: heartbeat + 1 h at most (grace, default max age, per-feed maxAgeSec)", () => {
    expect(chainlinkAgeProblems(mainnet())).toEqual([]);
    expect(productionProblems(mainnet({ ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS: "3600000" }), BASE)).toEqual([]);
    expect(productionProblems(mainnet({ ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS: "172800000" }), BASE)).toEqual([
      "ORACLE_CHAINLINK_HEARTBEAT_GRACE_MS=172800000 > 3600000 on mainnet: a wider grace signs an old Chainlink round as a fresh price",
      ...["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"].map(
        (t) => `chainlink feed ${t}: in-session max age 259200000 ms > heartbeat + 1 h (90000000 ms) on mainnet: an old round would be signed as fresh`,
      ),
    ]);
    // a per-feed maxAgeSec (env overlay) beyond heartbeat + 1 h
    const wide = mainnet({ ORACLE_CHAINLINK_FEEDS: JSON.stringify({ NVDA: { proxy: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", basis: "per-token", heartbeatSec: 86_400, maxAgeSec: 172_800 } }) });
    expect(productionProblems(wide, BASE)).toEqual([
      "chainlink feed NVDA: in-session max age 172800000 ms > heartbeat + 1 h (90000000 ms) on mainnet: an old round would be signed as fresh",
    ]);
    // a feed without heartbeatSec falls back to ORACLE_CHAINLINK_MAX_AGE_MS, itself bounded by 24 h + 1 h
    const noHb = mainnet({ ORACLE_CHAINLINK_FEEDS: JSON.stringify({ NVDA: { proxy: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", basis: "per-token" } }), ORACLE_CHAINLINK_MAX_AGE_MS: "100000000" });
    expect(productionProblems(noHb, BASE)).toEqual([
      "ORACLE_CHAINLINK_MAX_AGE_MS=100000000 > 90000000 on mainnet (24 h heartbeat + 1 h)",
      "chainlink feed NVDA: in-session max age 100000000 ms > heartbeat + 1 h (90000000 ms) on mainnet: an old round would be signed as fresh",
    ]);
  });

  test("DEX knobs: TWAP window 300-3600 s, observation max age <= 120 s, lag threshold below the confirm band", () => {
    expect(productionProblems(mainnet({ ORACLE_DEX_TWAP_SEC: "300" }), BASE)).toEqual([]);
    expect(productionProblems(mainnet({ ORACLE_DEX_TWAP_SEC: "120" }), BASE)).toEqual(
      ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"].map((t) => `dexConfirm.pools.${t} TWAP window 120s outside 300-3600s on mainnet (twapSec / ORACLE_DEX_TWAP_SEC)`),
    );
    expect(productionProblems(mainnet({ ORACLE_DEX_TWAP_SEC: "7200" }), BASE)).toHaveLength(5);
    expect(productionProblems(mainnet({ ORACLE_DEX_MAX_AGE_MS: "120000" }), BASE)).toEqual([]);
    expect(productionProblems(mainnet({ ORACLE_DEX_MAX_AGE_MS: "120001" }), BASE)).toEqual([
      "ORACLE_DEX_MAX_AGE_MS=120001 > 120000 on mainnet (an RPC stall would confirm with an old block)",
    ]);
    expect(productionProblems(mainnet({ ORACLE_PRIMARY_LAG_BPS: "200" }), BASE)).toEqual([
      "ORACLE_PRIMARY_LAG_BPS=200 must be below ORACLE_CONFIRM_BPS=200 (the stalled-feed signal precedes divergence)",
    ]);
  });

  test("feed basis must be explicit; 24x7 demo sessions refused", () => {
    const legacy = mainnet({ ORACLE_CHAINLINK_FEEDS: '{"NVDA":"0x00000000000000000000000000000000000000c1"}' });
    expect(has(productionProblems(legacy, BASE), "ORACLE_CHAINLINK_FEEDS.NVDA is a plain address")).toBe(true);
    expect(has(productionProblems(mainnet({ SESSIONS_MODE: "24x7" }), BASE), "SESSIONS_MODE=24x7")).toBe(true);
  });
});

describe("on-chain minSources", () => {
  test("primary-confirm: exactly 1 (anything above refuses every price on-chain)", () => {
    expect(PRIMARY_CONFIRM_SOURCE_COUNT).toBe(1);
    expect(onchainMinSourcesProblem(1, "primary-confirm", BASE)).toBeNull();
    expect(onchainMinSourcesProblem(2, "primary-confirm", [...BASE, pyth])).toBe(
      "AttestedOracle.minSources()=2 but primary-confirm signs every price with sourceCount 1 (Chainlink only): every price would be refused on-chain (setMinSources(1) through the timelock)",
    );
    expect(onchainMinSourcesProblem(3, "primary-confirm", BASE)).toContain("every price would be refused on-chain");
  });

  test("median: reachable by the live sources", () => {
    expect(liveSourceCount([chainlink, pyth, src("synthetic-a", "synthetic"), src("pyth", "pyth")])).toBe(2);
    expect(onchainMinSourcesProblem(2, "median", [chainlink, pyth])).toBeNull();
    const p = onchainMinSourcesProblem(4, "median", [chainlink, pyth, vendor]);
    expect(p).toContain("AttestedOracle.minSources()=4 > 3 configured live sources");
    expect(p).toContain("setMinSources(3)");
  });

  test("startup gate: retried reads, an unreadable contract refuses the start", async () => {
    expect(await startupOnchainMinSourcesProblem({ readMinSources: async () => 1, policy: "primary-confirm", sources: BASE })).toBeNull();
    expect(await startupOnchainMinSourcesProblem({ readMinSources: async () => 3, policy: "primary-confirm", sources: BASE })).toContain("every price would be refused");
    let n = 0;
    const flaky = async () => {
      if (++n < 3) throw new Error("fetch failed");
      return 1;
    };
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    expect(await startupOnchainMinSourcesProblem({ readMinSources: flaky, policy: "primary-confirm", sources: BASE, sleep, delayMs: 5 })).toBeNull();
    expect(sleeps).toEqual([5, 5]);
    const dead = await startupOnchainMinSourcesProblem({
      readMinSources: async () => {
        throw new Error(["execution reverted", "long trace"].join(String.fromCharCode(10)));
      },
      policy: "primary-confirm",
      sources: BASE,
      sleep,
      attempts: 2,
    });
    expect(dead).toBe("AttestedOracle.minSources() not readable (execution reverted): cannot check it against the configured sources");
  });
});
