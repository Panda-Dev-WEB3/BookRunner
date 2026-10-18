// DEX TWAP confirm source (sources/dex-twap.ts): Uniswap v3 TWAP math in both orientations, decimals, negative
// ticks, per-share conversion through uiMultiplier, 2% depth floor, factory authenticity, observation history, last
// swap inside the window, block-time stamps.
import { describe, expect, test } from "bun:test";
import { MULTIPLIER_VECTOR as V, WAD, loadChainPriceConfig } from "@bookrunner/shared";
import { getAddress } from "viem";
import { loadOracleConfig, resolveDexPools } from "../src/config";
import { DexTwapSource, arithmeticMeanTick, depthQuote, perSharePrice, priceToWad, tokenPriceAtTick } from "../src/sources/dex-twap";
import { FACTORY, FakeDexReader, USDG, dexPool, sqrtPriceX96At, tickFor } from "./dex-fakes";

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
  const src = new DexTwapSource({ NVDA: dexPool(POOL_A, NVDA) }, r, { maxAgeMs: 60_000, factory: FACTORY, now: () => clock });
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
      expect(o.depthQuote).toBeCloseTo(500_000, -1);
      expect(o.lastSwapAgeSec).toBe(30);
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
    const two = new DexTwapSource({ NVDA: dexPool(POOL_A, NVDA), TSLA: dexPool(POOL_B, TSLA) }, r, { maxAgeMs: 60_000, factory: FACTORY, now: () => 5_000 });
    await Promise.all([two.fetch("NVDA"), two.fetch("TSLA")]);
    expect(r.calls.block).toBe(1);
    await src.fetch("NVDA");
    advance(1_000);
    await src.fetch("NVDA");
    expect(r.calls.poolTokens).toBe(3); // two pools in `two`, one in `src` (cached on the second fetch)
    expect(r.calls.block).toBe(3);
  });

  test("depth floor: quote needed to move the price 2% (in-range liquidity), not the pool's token balance", async () => {
    for (const tokenIsToken0 of [false, true]) {
      const { r, src } = setup({ tokenIsToken0 });
      r.pools.get(POOL_A.toLowerCase())!.depthUsd = 49_000;
      const o = await src.observe("NVDA");
      expect(o.ok).toBe(false);
      expect(!o.ok && o.reason).toMatch(/^insufficient depth: \$49,0\d\d moves the price 2% \(floor \$50,000\)$/);
      await expect(src.fetch("NVDA")).rejects.toThrow("insufficient depth");
      r.pools.get(POOL_A.toLowerCase())!.depthUsd = 51_000;
      expect((await src.observe("NVDA")).ok).toBe(true);
    }
  });

  test("depthQuote: constant-L math in both orientations; the smaller (price-down) side; scales with L", () => {
    // quote = token1: base = L * sqrtP; quote = token0: base = L / sqrtP (raw units, / 10^decimals)
    const sq = sqrtPriceX96At(-217_747); // TSLA pool: token0 TSLA, token1 USDG
    const L = 10n ** 18n;
    const sqrtP = Number(sq) / 2 ** 96;
    const r = Math.sqrt(1.02);
    expect(depthQuote(L, sq, false, 6)).toBeCloseTo((1e18 * sqrtP * (1 - 1 / r)) / 1e6, 6);
    const sq0 = sqrtPriceX96At(222_698); // NVDA pool: token0 USDG
    const sqrtP0 = Number(sq0) / 2 ** 96;
    expect(depthQuote(L, sq0, true, 6)).toBeCloseTo((1e18 / sqrtP0) * (1 - 1 / r) / 1e6, 6);
    expect(depthQuote(2n * L, sq, false, 6)).toBeCloseTo(2 * depthQuote(L, sq, false, 6), 6);
    // a wider move needs more quote; up (r - 1) > down (1 - 1/r): the returned figure is the down side
    expect(depthQuote(L, sq, false, 6, 400)).toBeGreaterThan(depthQuote(L, sq, false, 6, 200));
    expect(depthQuote(0n, sq, false, 6)).toBe(0);
  });

  test("factory check: the pool must be factory.getPool(stockToken, quoteToken, fee) (once per pool)", async () => {
    const { r, src } = setup();
    expect((await src.observe("NVDA")).ok).toBe(true);
    await src.observe("NVDA");
    expect(r.calls.getPool).toBe(1);
    const look = new FakeDexReader();
    look.addPool(POOL_A, { token0: USDG, token1: NVDA, meanTick: tickFor(213.2, false) });
    look.setToken(NVDA);
    look.factoryPools.set(`${[NVDA.toLowerCase(), USDG.toLowerCase()].sort().join("|")}|3000`, POOL_B);
    const fake = new DexTwapSource({ NVDA: dexPool(POOL_A, NVDA) }, look, { maxAgeMs: 60_000, factory: FACTORY });
    const o = await fake.observe("NVDA");
    expect(!o.ok && o.reason).toBe(`pool ${POOL_A} is not the factory's pool for (Stock Token, quote token, fee 3000): getPool returned ${POOL_B}`);
    // a wrong fee tier in the config: getPool returns the zero address
    const wrongFee = new DexTwapSource({ NVDA: dexPool(POOL_A, NVDA, { fee: 500 }) }, r, { maxAgeMs: 60_000, factory: FACTORY });
    expect((await wrongFee.observe("NVDA")).ok).toBe(false);
    // no factory known (devnet): not checked
    const unchecked = new DexTwapSource({ NVDA: dexPool(POOL_A, NVDA) }, look, { maxAgeMs: 60_000, factory: null });
    expect((await unchecked.observe("NVDA")).ok).toBe(true);
    expect(unchecked.factoryChecked()).toBe(false);
  });

  test("no swap inside the TWAP window: unavailable, never an old trade presented as fresh", async () => {
    const { r, src } = setup();
    const p = r.pools.get(POOL_A.toLowerCase())!;
    p.newestTs = r.blockNow.timestamp - 600;
    let o = await src.observe("NVDA");
    expect(!o.ok && o.reason).toBe("no swap in the 600s TWAP window (last swap 600s ago): the TWAP would be an old trade");
    expect(o).toMatchObject({ lastSwapAgeSec: 600, historySec: 86_400 });
    p.observationIndex = 20; // a new swap: new index, the cached ring is re-read
    p.newestTs = r.blockNow.timestamp - 599;
    o = await src.observe("NVDA");
    expect(o.ok).toBe(true);
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
    expect(r.calls.observation).toBe(2);
    r.pools.get(POOL_A.toLowerCase())!.observationIndex = 99;
    await src.observe("NVDA");
    expect(r.calls.observation).toBe(4);
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
    const r = new FakeDexReader();
    r.addPool(POOL_A, { token0: USDG, token1: TSLA, meanTick: tickFor(213.2, false) });
    r.setToken(NVDA);
    // not checked against the factory here (it would refuse first): the token pair check on its own
    const src = new DexTwapSource({ NVDA: dexPool(POOL_A, NVDA) }, r, { maxAgeMs: 60_000, factory: null });
    const o = await src.observe("NVDA");
    expect(!o.ok && o.reason).toContain("are not the Stock Token");
    expect(await src.observe("AAPL")).toEqual({ ok: false, reason: "no DEX confirm pool configured" });
  });

  test("an unreadable pool is a reason", async () => {
    const r = new FakeDexReader();
    r.setToken(NVDA);
    const src = new DexTwapSource({ NVDA: dexPool(POOL_A, NVDA) }, r, { maxAgeMs: 60_000, factory: null });
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
      minDepthUsd: 50_000,
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

