// DEX TWAP confirm source (sources/dex-twap.ts): Uniswap v3 TWAP math in both orientations, decimals, negative
// ticks, per-share conversion through uiMultiplier, liquidity floor, observation history, block-time stamps.
import { describe, expect, test } from "bun:test";
import { MULTIPLIER_VECTOR as V, WAD, loadChainPriceConfig } from "@bookrunner/shared";
import { getAddress } from "viem";
import { loadOracleConfig, resolveDexPools } from "../src/config";
import { DexTwapSource, arithmeticMeanTick, perSharePrice, priceToWad, tokenPriceAtTick } from "../src/sources/dex-twap";
import { FakeDexReader, USDG, dexPool, tickFor } from "./dex-fakes";

const NVDA = getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
const TSLA = getAddress("0x322F0929c4625eD5bAd873c95208D54E1c003b2d");
const POOL_A = getAddress("0x00000000000000000000000000000000000a0001");
const POOL_B = getAddress("0x00000000000000000000000000000000000a0002");
const bps = (a: number, b: number) => (Math.abs(a - b) / b) * 1e4;

describe("TWAP math", () => {
  test("arithmetic-mean tick rounds toward negative infinity (OracleLibrary.consult)", () => {
    expect(arithmeticMeanTick(0n, 6000n, 600)).toBe(10);
    expect(arithmeticMeanTick(0n, 6001n, 600)).toBe(10); // positive: truncation
    expect(arithmeticMeanTick(0n, -6000n, 600)).toBe(-10);
    expect(arithmeticMeanTick(0n, -6001n, 600)).toBe(-11); // negative, inexact: one lower
    expect(arithmeticMeanTick(1_000n, 1_000n - 7n, 2)).toBe(-4);
    // large cumulatives (int56 range) keep exact integer arithmetic
    expect(arithmeticMeanTick(-36_028_797_018_963_968n, -36_028_797_018_963_968n + 222_698n * 600n, 600)).toBe(222_698);
    expect(() => arithmeticMeanTick(0n, 1n, 0)).toThrow("positive integer");
  });

  test("both orientations against the live 2026-10-17 pools (USDG 6 decimals, Stock Token 18)", () => {
    // NVDA pool: token0 = USDG, token1 = NVDA, tick 222698 -> ~$213.18 per NVDA token
    const nvda = tokenPriceAtTick(222_698, false, 18, 6);
    expect(nvda).toBeCloseTo(1 / (1.0001 ** 222_698 * 1e-12), 6);
    expect(nvda).toBeGreaterThan(213);
    expect(nvda).toBeLessThan(213.4);
    // TSLA pool: token0 = TSLA, token1 = USDG, negative tick -217747 -> ~$349.8 per TSLA token
    const tsla = tokenPriceAtTick(-217_747, true, 18, 6);
    expect(tsla).toBeCloseTo(1.0001 ** -217_747 * 1e12, 6);
    expect(tsla).toBeGreaterThan(349.5);
    expect(tsla).toBeLessThan(350.1);
  });

  test("tickFor round-trips within half a tick (<= 0.5 bps) in both orientations and for other decimals", () => {
    for (const price of [0.37, 213.2, 349.8, 5_123.45]) {
      for (const t0 of [true, false]) {
        for (const [td, qd] of [
          [18, 6],
          [18, 18],
          [8, 6],
        ] as const) {
          const p = tokenPriceAtTick(tickFor(price, t0, td, qd), t0, td, qd);
          expect(bps(p, price)).toBeLessThanOrEqual(0.51);
        }
      }
    }
    // same tick, quote decimals 18 instead of 6: the price scales by 1e12
    expect(tokenPriceAtTick(-217_747, true, 18, 18) * 1e12).toBeCloseTo(tokenPriceAtTick(-217_747, true, 18, 6), 3);
  });

  test("per share = token price / uiMultiplier through the shared WAD conversion", () => {
    expect(priceToWad(185.12345678)).toBe(185_123_456_780_000_000_000n);
    expect(perSharePrice(185.12345678, V.uiMultiplierWad)).toBeCloseTo(V.perSharePrice, 7);
    expect(perSharePrice(200, WAD)).toBe(200);
    expect(perSharePrice(200, 2n * WAD)).toBe(100);
  });
});

function setup(o: { tokenIsToken0?: boolean; tokenPrice?: number; multiplier?: bigint } = {}) {
  const r = new FakeDexReader();
  const t0 = o.tokenIsToken0 ?? false;
  const price = o.tokenPrice ?? 213.2;
  r.addPool(POOL_A, { token0: t0 ? NVDA : USDG, token1: t0 ? USDG : NVDA, meanTick: tickFor(price, t0) });
  r.setToken(NVDA, { uiMultiplier: o.multiplier ?? WAD });
  let clock = r.blockNow.timestamp * 1000 + 800;
  const src = new DexTwapSource({ NVDA: dexPool(POOL_A, NVDA) }, r, { maxAgeMs: 60_000, now: () => clock });
  return { r, src, advance: (ms: number) => (clock += ms) };
}

describe("DexTwapSource", () => {
  test("TWAP per share, both orientations; ts = block time; every read pinned to the tick's block", async () => {
    for (const tokenIsToken0 of [false, true]) {
      const { r, src } = setup({ tokenIsToken0, multiplier: V.uiMultiplierWad });
      const o = await src.observe("NVDA");
      if (!o.ok) throw new Error(o.reason);
      expect(bps(o.tokenPrice, 213.2)).toBeLessThan(0.51);
      expect(o.price).toBeCloseTo(o.tokenPrice / (Number(V.uiMultiplierWad) / 1e18), 6);
      expect(o.ts).toBe(r.blockNow.timestamp * 1000);
      expect(o.twapSec).toBe(600);
      expect(o.quoteLiquidity).toBe(500_000);
      expect(o.cardinality).toBe(7200);
      expect(o.historySec).toBe(86_400);
      expect([...r.pinned]).toEqual([r.blockNow.number]);
      const f = await src.fetch("NVDA");
      expect(f).toEqual({ price: o.price, ts: o.ts, maxAgeMs: 60_000 });
    }
  });

  test("one block read shared by the tickers of a tick; pool tokens cached", async () => {
    const { r, src, advance } = setup();
    r.addPool(POOL_B, { token0: TSLA, token1: USDG, meanTick: tickFor(349.8, true) });
    r.setToken(TSLA);
    const two = new DexTwapSource({ NVDA: dexPool(POOL_A, NVDA), TSLA: dexPool(POOL_B, TSLA) }, r, { maxAgeMs: 60_000, now: () => 5_000 });
    await Promise.all([two.fetch("NVDA"), two.fetch("TSLA")]);
    expect(r.calls.block).toBe(1);
    await src.fetch("NVDA");
    advance(1_000);
    await src.fetch("NVDA");
    expect(r.calls.poolTokens).toBe(3); // two pools in `two`, one in `src` (cached on the second fetch)
    expect(r.calls.block).toBe(3);
  });

  test("liquidity floor: a pool with less quote token than minQuoteLiquidity confirms nothing", async () => {
    const { r, src } = setup();
    r.pools.get(POOL_A.toLowerCase())!.quoteBalance = 49_999n * 10n ** 6n;
    const o = await src.observe("NVDA");
    expect(o).toMatchObject({ ok: false, quoteLiquidity: 49_999 });
    expect(!o.ok && o.reason).toBe("insufficient liquidity: $49,999 quote tokens in the pool < floor $50,000");
    await expect(src.fetch("NVDA")).rejects.toThrow("insufficient liquidity");
    r.pools.get(POOL_A.toLowerCase())!.quoteBalance = 50_000n * 10n ** 6n;
    expect((await src.observe("NVDA")).ok).toBe(true);
  });

  test("observation history must cover the window (oldest slot; slot 0 when the ring is not full)", async () => {
    const { r, src } = setup();
    const p = r.pools.get(POOL_A.toLowerCase())!;
    p.oldestTs = r.blockNow.timestamp - 599;
    let o = await src.observe("NVDA");
    expect(!o.ok && o.reason).toBe("observation history 599s < TWAP window 600s (cardinality 7200: increaseObservationCardinalityNext)");
    // the next slot is not initialized yet: the oldest is slot 0
    p.observationIndex = 11; // new index: the cached oldest is re-read
    p.oldestInitialized = false;
    p.slot0Ts = r.blockNow.timestamp - 600;
    o = await src.observe("NVDA");
    expect(o.ok).toBe(true);
    p.observationIndex = 12;
    p.slot0Ts = r.blockNow.timestamp - 30;
    o = await src.observe("NVDA");
    expect(!o.ok && o.reason).toContain("observation history 30s < TWAP window 600s");
  });

  test("the oldest observation is read once per observation index", async () => {
    const { r, src } = setup();
    await src.observe("NVDA");
    await src.observe("NVDA");
    expect(r.calls.observation).toBe(1);
    r.pools.get(POOL_A.toLowerCase())!.observationIndex = 99;
    await src.observe("NVDA");
    expect(r.calls.observation).toBe(2);
  });

  test("observe() reverting (OLD) is a reason, never a throw out of observe()", async () => {
    const { r, src } = setup();
    r.pools.get(POOL_A.toLowerCase())!.observeError = new Error("execution reverted: OLD\nlong trace");
    const o = await src.observe("NVDA");
    expect(!o.ok && o.reason).toBe("observe([600, 0]) failed: execution reverted: OLD");
  });

  test("Stock Token state: paused, zero multiplier, multiplier changed inside the window", async () => {
    const { r, src } = setup();
    r.setToken(NVDA, { oraclePaused: true });
    expect(await src.observe("NVDA")).toMatchObject({ ok: false, reason: "token oraclePaused() (corporate action in progress)" });
    r.setToken(NVDA, { uiMultiplier: 0n });
    expect(await src.observe("NVDA")).toMatchObject({ ok: false, reason: "uiMultiplier() = 0" });
    const now = r.blockNow.timestamp;
    r.setToken(NVDA, { uiMultiplier: 2n * WAD, newUIMultiplier: 2n * WAD, effectiveAt: BigInt(now - 300) });
    expect(await src.observe("NVDA")).toMatchObject({ ok: false, reason: `uiMultiplier changed at ${now - 300}, inside the 600s TWAP window` });
    // the change is older than the window: the TWAP is entirely post-change, divided by the new multiplier
    r.setToken(NVDA, { uiMultiplier: 2n * WAD, newUIMultiplier: 2n * WAD, effectiveAt: BigInt(now - 601) });
    const o = await src.observe("NVDA");
    if (!o.ok) throw new Error(o.reason);
    expect(o.price).toBeCloseTo(o.tokenPrice / 2, 6);
  });

  test("a pool whose tokens are not the Stock Token and the quote token is refused", async () => {
    const { r, src } = setup();
    r.pools.get(POOL_A.toLowerCase())!.token1 = TSLA;
    const o = await src.observe("NVDA");
    expect(!o.ok && o.reason).toContain("are not the Stock Token");
    expect(await src.observe("AAPL")).toEqual({ ok: false, reason: "no DEX confirm pool configured" });
  });

  test("an unreadable pool is a reason", async () => {
    const r = new FakeDexReader();
    r.setToken(NVDA);
    const src = new DexTwapSource({ NVDA: dexPool(POOL_A, NVDA) }, r, { maxAgeMs: 60_000 });
    const o = await src.observe("NVDA");
    expect(!o.ok && o.reason).toBe("pool not readable: execution reverted (no pool)");
  });
});

describe("dexConfirm config", () => {
  test("config/chains/4663.json lists one USDG pool per launch ticker; resolved with the Stock Token", () => {
    const cfg = loadChainPriceConfig(4663)!;
    const pools = resolveDexPools(cfg);
    expect(Object.keys(pools).sort()).toEqual(["AAPL", "AMZN", "MSFT", "NVDA", "TSLA"]);
    expect(pools.NVDA).toEqual({
      pool: getAddress("0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3"),
      token: NVDA,
      tokenDecimals: 18,
      quoteToken: USDG,
      twapSec: 600,
      minQuoteLiquidity: 50_000,
      fee: 500,
    });
    expect(cfg.dexConfirm?.readAt).toBe("2026-10-17");
    expect(resolveDexPools(cfg, 1_800).TSLA!.twapSec).toBe(1_800);
    expect(resolveDexPools(null)).toEqual({});
  });

  test("oracle config: pools on by default, ORACLE_DEX_CONFIRM=0 drops them, ORACLE_DEX_TWAP_SEC overrides", () => {
    expect(Object.keys(loadOracleConfig({ CHAIN_ID: "4663" }).dexPools)).toHaveLength(5);
    expect(loadOracleConfig({ CHAIN_ID: "4663", ORACLE_DEX_CONFIRM: "0" }).dexPools).toEqual({});
    expect(loadOracleConfig({ CHAIN_ID: "4663", ORACLE_DEX_TWAP_SEC: "900" }).dexPools.AAPL!.twapSec).toBe(900);
    expect(() => loadOracleConfig({ CHAIN_ID: "4663", ORACLE_DEX_TWAP_SEC: "30" })).toThrow("ORACLE_DEX_TWAP_SEC");
    // no chain config on devnet: no pools
    expect(loadOracleConfig({}).dexPools).toEqual({});
  });

  test("ORACLE_POLICY defaults: primary-confirm with minimum 1 on mainnet, median with minimum 3 elsewhere", () => {
    const m = loadOracleConfig({ CHAIN_ID: "4663" });
    expect([m.ORACLE_POLICY, m.ORACLE_MIN_SOURCES, m.ORACLE_CONFIRM_BPS]).toEqual(["primary-confirm", 1, 200]);
    const d = loadOracleConfig({});
    expect([d.ORACLE_POLICY, d.ORACLE_MIN_SOURCES]).toEqual(["median", 3]);
    expect(loadOracleConfig({ ORACLE_POLICY: "primary-confirm" }).ORACLE_MIN_SOURCES).toBe(1);
    expect(loadOracleConfig({ CHAIN_ID: "4663", ORACLE_MIN_SOURCES: "2" }).ORACLE_MIN_SOURCES).toBe(2);
    expect(() => loadOracleConfig({ ORACLE_POLICY: "mean" })).toThrow("ORACLE_POLICY");
  });

  test("dex-twap is a reserved source name", () => {
    expect(() => loadOracleConfig({ ORACLE_HTTP_SOURCES: JSON.stringify([{ name: "dex-twap", url: "https://x/{ticker}", pricePath: "p" }]) })).toThrow("reserved source name");
  });
});

