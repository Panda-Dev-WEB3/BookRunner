// Several confirm pools per ticker (sources/dex-twap.ts): Stock-Token / WETH pools priced through the WETH / USDG
// leg (TWAP x TWAP over the same window, decimals, token0 / token1 both ways, the multiplier, each pool its own
// window's leg price), the time-averaged depth floor (harmonic-mean liquidity) and the min(now, averaged) weight,
// the shared-leg cap, the weighted median, and the any-pool divergence rule of domain/confirm.ts.
import { describe, expect, test } from "bun:test";
import { MULTIPLIER_VECTOR as V, WAD } from "@bookrunner/shared";
import { type Address, getAddress } from "viem";
import { primaryConfirm } from "../src/domain/confirm";
import type { ObservationPart } from "../src/domain/types";
import {
  type DexPoolObservation,
  DexTwapSource,
  type ResolvedEthUsdLeg,
  capSharedLeg,
  combineDexPools,
  dexPoolLabel,
  ethLegLabel,
  harmonicMeanLiquidity,
  weightedMedian,
} from "../src/sources/dex-twap";
import { FACTORY, FakeDexReader, USDG, WETH, dexPool, tickFor } from "./dex-fakes";

const NVDA = getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
const USDG_POOL = getAddress("0x00000000000000000000000000000000000b0001");
const WETH_POOL = getAddress("0x00000000000000000000000000000000000b0002");
const WETH_POOL_2 = getAddress("0x00000000000000000000000000000000000b0003");
const LEG = getAddress("0x00000000000000000000000000000000000b00e1");
const bps = (a: number, b: number) => (Math.abs(a - b) / b) * 1e4;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ETH_USD = 1_946;
/** per-token USD price of NVDA in the fixtures */
const TOKEN_USD = 162.7;

const leg = (over: Partial<ResolvedEthUsdLeg> = {}): ResolvedEthUsdLeg => ({ pool: LEG, weth: WETH, quoteToken: USDG, fee: 100, minDepthUsd: 50_000, ...over });

interface Setup {
  /** NVDA / WETH: NVDA is token0 (true) or WETH is token0 (false, as on chain 4663) */
  stockIsToken0?: boolean;
  /** WETH / USDG: WETH is token0 (true, as on chain 4663) or USDG is token0 */
  wethIsToken0?: boolean;
  multiplier?: bigint;
  /** USD per NVDA token in the WETH pool and in the USDG pool */
  wethPoolUsd?: number;
  usdgPoolUsd?: number;
  /** 2% depth: WETH (WETH pool), USD (USDG pool, leg) */
  wethDepth?: number;
  usdgDepth?: number;
  legDepth?: number;
  ethUsd?: number;
  stockDecimals?: number;
  withUsdgPool?: boolean;
}

function setup(o: Setup = {}) {
  const r = new FakeDexReader();
  const s0 = o.stockIsToken0 ?? false;
  const w0 = o.wethIsToken0 ?? true;
  const eth = o.ethUsd ?? ETH_USD;
  const dec = o.stockDecimals ?? 18;
  r.addPool(WETH_POOL, {
    token0: s0 ? NVDA : WETH,
    token1: s0 ? WETH : NVDA,
    quote: WETH,
    fee: 500,
    meanTick: tickFor((o.wethPoolUsd ?? TOKEN_USD) / eth, s0, dec, 18),
    depthUsd: o.wethDepth ?? 60, // ~$117k
  });
  r.addPool(LEG, { token0: w0 ? WETH : USDG, token1: w0 ? USDG : WETH, quote: USDG, fee: 100, meanTick: tickFor(eth, w0, 18, 6), depthUsd: o.legDepth ?? 264_000 });
  if (o.withUsdgPool !== false) {
    r.addPool(USDG_POOL, { token0: USDG, token1: NVDA, quote: USDG, fee: 500, meanTick: tickFor(o.usdgPoolUsd ?? TOKEN_USD, false, dec, 6), depthUsd: o.usdgDepth ?? 227_000 });
  }
  r.setToken(NVDA, { uiMultiplier: o.multiplier ?? WAD });
  const pools = [
    ...(o.withUsdgPool !== false ? [dexPool(USDG_POOL, NVDA, { fee: 500, minDepthUsd: 15_000, tokenDecimals: dec })] : []),
    dexPool(WETH_POOL, NVDA, { fee: 500, quoteToken: WETH, quote: "eth", minDepthUsd: 25_000, tokenDecimals: dec }),
  ];
  const src = new DexTwapSource({ NVDA: pools }, r, { maxAgeMs: 120_000, factory: FACTORY, ethUsd: leg() });
  return { r, src, pool: (a: Address) => r.pools.get(a.toLowerCase())! };
}

const okPool = (o: DexPoolObservation | undefined) => {
  if (!o?.ok) throw new Error(o ? o.reason : "no observation");
  return o;
};

/** primary-confirm of Chainlink at `chainlink` against one dex-twap observation (price + parts) */
const confirmOf = (dex: { price: number; parts?: ObservationPart[] } | null, chainlink = TOKEN_USD) =>
  primaryConfirm([{ name: "chainlink", price: chainlink, ts: 1_000 }, ...(dex === null ? [] : [{ name: "dex-twap", price: dex.price, ts: 1_000, ...(dex.parts ? { parts: dex.parts } : {}) }])], {
    nowMs: 1_000,
    primary: "chainlink",
    confirmBps: 200,
    maxAgeMs: 60_000,
  }).confirm;

describe("ETH-leg math", () => {
  test("per-token USD = TWAP(stock/WETH) x TWAP(WETH/USDG); every token0 / token1 ordering; per share through uiMultiplier", async () => {
    for (const stockIsToken0 of [false, true]) {
      for (const wethIsToken0 of [true, false]) {
        const { src } = setup({ stockIsToken0, wethIsToken0, multiplier: V.uiMultiplierWad, withUsdgPool: false });
        const o = await src.observe("NVDA");
        if (!o.ok) throw new Error(o.reason);
        // two ticks of rounding (half a tick each, ~0.5 bps)
        expect(bps(o.tokenPrice, TOKEN_USD)).toBeLessThan(1.1);
        // the multiplier is divided out after the USD conversion, exactly as on the USDG path
        expect(o.price).toBeCloseTo(o.tokenPrice / (Number(V.uiMultiplierWad) / 1e18), 6);
        expect(o.quote).toBe("eth");
        expect(o.label).toBe(`NVDA/WETH 500 ${WETH_POOL.slice(0, 6)}..${WETH_POOL.slice(-4)}`);
        // the 2% depth in WETH, valued in USD at the leg's TWAP; time-averaged = now here
        expect(o.depthQuote).toBeCloseTo(60, 3);
        expect(bps(o.depthUsd, 60 * ETH_USD)).toBeLessThan(1);
        expect(bps(o.twapDepthUsd, 60 * ETH_USD)).toBeLessThan(2);
      }
    }
  });

  test("decimals: a Stock Token with 8 decimals and a 6-decimal USD quote give the same USD price", async () => {
    const { src } = setup({ stockDecimals: 8 });
    const o = await src.observe("NVDA");
    if (!o.ok) throw new Error(o.reason);
    for (const p of o.pools) expect(bps(okPool(p).tokenPrice, TOKEN_USD)).toBeLessThan(1.1);
  });

  test("each WETH pool gets the leg price of its own window (one observe per window, same read)", async () => {
    const r = new FakeDexReader();
    const wethPer = TOKEN_USD / 1_950;
    r.addPool(WETH_POOL, { token0: WETH, token1: NVDA, quote: WETH, fee: 500, meanTick: tickFor(wethPer, false, 18, 18), depthUsd: 60 });
    r.addPool(WETH_POOL_2, { token0: WETH, token1: NVDA, quote: WETH, fee: 3000, meanTick: tickFor(wethPer, false, 18, 18), depthUsd: 40 });
    // ETH averaged $1,900 over 900 s and $2,000 over 1800 s
    r.addPool(LEG, { token0: WETH, token1: USDG, quote: USDG, fee: 100, meanTick: tickFor(1_950, true, 18, 6), meanTickByWindow: { 900: tickFor(1_900, true, 18, 6), 1800: tickFor(2_000, true, 18, 6) }, depthUsd: 264_000 });
    r.setToken(NVDA);
    const two = new DexTwapSource(
      { NVDA: [dexPool(WETH_POOL, NVDA, { fee: 500, quoteToken: WETH, quote: "eth", twapSec: 1800 }), dexPool(WETH_POOL_2, NVDA, { fee: 3000, quoteToken: WETH, quote: "eth", twapSec: 900 })] },
      r,
      { maxAgeMs: 120_000, factory: FACTORY, ethUsd: leg() },
    );
    const o = await two.observe("NVDA");
    if (!o.ok) throw new Error(o.reason);
    const [p1800, p900] = o.pools.map(okPool);
    expect(bps(p1800!.tokenPrice, wethPer * 2_000)).toBeLessThan(1.1);
    expect(bps(p900!.tokenPrice, wethPer * 1_900)).toBeLessThan(1.1);
    // one observe([w, 0]) per window on the leg, in the same pass
    expect(r.observed.filter((x) => x.pool === LEG.toLowerCase()).map((x) => x.secondsAgos)).toEqual([
      [900, 0],
      [1800, 0],
    ]);
  });

  test("a USDG-only pass does not read the leg", async () => {
    const r3 = new FakeDexReader();
    r3.addPool(USDG_POOL, { token0: USDG, token1: NVDA, meanTick: tickFor(TOKEN_USD, false), depthUsd: 100_000 });
    r3.addPool(LEG, { token0: WETH, token1: USDG, quote: USDG, fee: 100, meanTick: tickFor(ETH_USD, true, 18, 6) });
    r3.setToken(NVDA);
    const usdOnly = new DexTwapSource({ NVDA: [dexPool(USDG_POOL, NVDA)] }, r3, { maxAgeMs: 120_000, factory: FACTORY, ethUsd: leg() });
    expect((await usdOnly.observe("NVDA")).ok).toBe(true);
    expect(r3.observed.some((x) => x.pool === LEG.toLowerCase())).toBe(false);
  });

  test("the depth floor is in USD through the leg: 12 WETH at $1,946 is below a $25,000 floor, 13 WETH above", async () => {
    const thin = setup({ wethDepth: 12, withUsdgPool: false });
    const o = await thin.src.observe("NVDA");
    expect(!o.ok && o.reason).toMatch(/^insufficient depth: \$23,3\d\d moves the price 2% \(time-averaged over 600s; now \$23,3\d\d; floor \$25,000; 12\.0 WETH at \$1,94\d\)$/);
    const ok = setup({ wethDepth: 13, withUsdgPool: false });
    expect((await ok.src.observe("NVDA")).ok).toBe(true);
  });

  test("the leg's own checks: time-averaged depth floor, swap inside the window, history, factory pool; failing, every WETH pool confirms nothing", async () => {
    const shallow = setup({ legDepth: 40_000 });
    let o = await shallow.src.observe("NVDA");
    // the USDG pool still confirms; the WETH pool names the leg
    expect(o.ok && o.pools.map((p) => [p.quote, p.ok])).toEqual([
      ["usd", true],
      ["eth", false],
    ]);
    const weth = o.pools?.[1];
    expect(weth && !weth.ok && weth.reason).toMatch(
      new RegExp(`^ETH/USD leg ${esc(ethLegLabel(leg()))}: insufficient depth: \\$(39,9\\d\\d|40,0\\d\\d) moves the price 2% \\(time-averaged over 600s; now \\$\\d+,\\d{3}; floor \\$50,000\\)$`),
    );
    expect(shallow.src.legObservation()).toMatchObject({ ok: false, label: ethLegLabel(leg()) });

    const quiet = setup({ withUsdgPool: false });
    quiet.pool(LEG).newestTs = quiet.r.blockNow.timestamp - 600;
    o = await quiet.src.observe("NVDA");
    expect(!o.ok && o.reason).toBe(`ETH/USD leg ${ethLegLabel(leg())}: no swap in the 600s TWAP window (last swap 600s ago)`);
    // M4: every window failed "no swap": the leg is reported failing (source-check shows it), never OK
    expect(quiet.src.legObservation()).toMatchObject({ ok: false, reason: "no swap in the 600s TWAP window (last swap 600s ago)" });

    const young = setup({ withUsdgPool: false });
    young.pool(LEG).oldestTs = young.r.blockNow.timestamp - 300;
    o = await young.src.observe("NVDA");
    expect(!o.ok && o.reason).toBe(`ETH/USD leg ${ethLegLabel(leg())}: observation history 300s < TWAP window 600s`);

    // a leg that is not the factory's getPool(WETH, USDG, fee)
    const wrong = setup({ withUsdgPool: false });
    const fake = new DexTwapSource({ NVDA: [dexPool(WETH_POOL, NVDA, { fee: 500, quoteToken: WETH, quote: "eth", minDepthUsd: 25_000 })] }, wrong.r, {
      maxAgeMs: 120_000,
      factory: FACTORY,
      ethUsd: leg({ fee: 500 }),
    });
    o = await fake.observe("NVDA");
    expect(!o.ok && o.reason).toContain(`pool ${LEG} is not the factory's pool for (WETH, quote token, fee 500)`);
  });

  test("M4: the leg's history is checked per window: a short window stays usable when only the long one is not covered", async () => {
    const r = new FakeDexReader();
    r.addPool(WETH_POOL, { token0: WETH, token1: NVDA, quote: WETH, fee: 500, meanTick: tickFor(TOKEN_USD / ETH_USD, false, 18, 18), depthUsd: 60 });
    r.addPool(WETH_POOL_2, { token0: WETH, token1: NVDA, quote: WETH, fee: 3000, meanTick: tickFor(TOKEN_USD / ETH_USD, false, 18, 18), depthUsd: 40 });
    r.addPool(LEG, { token0: WETH, token1: USDG, quote: USDG, fee: 100, meanTick: tickFor(ETH_USD, true, 18, 6), depthUsd: 264_000, oldestTs: r.blockNow.timestamp - 1_000 });
    r.setToken(NVDA);
    const src = new DexTwapSource(
      { NVDA: [dexPool(WETH_POOL, NVDA, { fee: 500, quoteToken: WETH, quote: "eth", twapSec: 1800 }), dexPool(WETH_POOL_2, NVDA, { fee: 3000, quoteToken: WETH, quote: "eth", twapSec: 900 })] },
      r,
      { maxAgeMs: 120_000, factory: FACTORY, ethUsd: leg() },
    );
    const o = await src.observe("NVDA");
    expect(o.ok && o.pools.map((p) => (p.ok ? "ok" : p.reason))).toEqual([`ETH/USD leg ${ethLegLabel(leg())}: observation history 1000s < TWAP window 1800s`, "ok"]);
    expect(src.legObservation()?.ok).toBe(true);
  });

  test("a WETH pool's own checks (factory, tokens) and a missing leg are refused", async () => {
    const { r } = setup();
    // getPool(NVDA, WETH, 3000) is not this pool
    const wrongFee = new DexTwapSource({ NVDA: [dexPool(WETH_POOL, NVDA, { fee: 3000, quoteToken: WETH, quote: "eth" })] }, r, { maxAgeMs: 120_000, factory: FACTORY, ethUsd: leg() });
    const o = await wrongFee.observe("NVDA");
    expect(!o.ok && o.reason).toContain("is not the factory's pool for (Stock Token, quote token, fee 3000)");
    // next to a good USDG pool: the ticker still confirms, every pool reported in the configured order
    const mixed = new DexTwapSource(
      { NVDA: [dexPool(USDG_POOL, NVDA, { fee: 500, minDepthUsd: 15_000 }), dexPool(WETH_POOL, NVDA, { fee: 3000, quoteToken: WETH, quote: "eth" })] },
      r,
      { maxAgeMs: 120_000, factory: FACTORY, ethUsd: leg() },
    );
    const m = await mixed.observe("NVDA");
    expect(m.ok && m.pools.map((p) => [p.pool, p.ok])).toEqual([
      [USDG_POOL, true],
      [WETH_POOL, false],
    ]);
    expect(() => new DexTwapSource({ NVDA: [dexPool(WETH_POOL, NVDA, { quoteToken: WETH, quote: "eth" })] }, r, { maxAgeMs: 120_000, factory: FACTORY })).toThrow(
      "WETH-quoted confirm pools without an ETH/USD leg",
    );
  });
});

describe("I1: time-averaged depth (floor) and min(now, averaged) weight", () => {
  test("harmonic-mean liquidity (OracleLibrary.consult): secs x 2^160 / (delta << 32); no increase = 0", () => {
    const L = 123_456_789_000_000_000n;
    const delta = (1800n << 128n) / L;
    const h = harmonicMeanLiquidity(10n ** 40n - delta, 10n ** 40n, 1800);
    expect(Number(h) / Number(L)).toBeCloseTo(1, 9);
    expect(harmonicMeanLiquidity(5n, 5n, 1800)).toBe(0n);
    expect(() => harmonicMeanLiquidity(0n, 1n, 0)).toThrow("positive integer");
  });

  test("a narrow-range spike at the read block does not take the weight (or the reference)", async () => {
    // WETH pool: a one-tick-spacing position makes it look 6,000 WETH (~$11.7M) deep now, but its window average is
    // 15 WETH (~$29k); it is also manipulated to +20%
    const { src, pool } = setup({ wethPoolUsd: TOKEN_USD * 1.2, usdgDepth: 100_000 });
    pool(WETH_POOL).depthUsd = 6_000;
    pool(WETH_POOL).twapDepthUsd = 15;
    const o = await src.observe("NVDA");
    if (!o.ok) throw new Error(o.reason);
    const weth = okPool(o.pools[1]);
    expect(weth.depthUsd).toBeGreaterThan(11_000_000);
    expect(bps(weth.weightUsd, 15 * ETH_USD)).toBeLessThan(2); // min(now, averaged)
    // the USDG pool stays the reference (reported value)...
    expect(o.quote).toBe("usd");
    expect(bps(o.price, TOKEN_USD)).toBeLessThan(1);
    // ...and the manipulated pool still pages, named (I1 b: any usable pool beyond the band)
    const c = confirmOf((await src.fetch("NVDA"))!);
    expect(c.status).toBe("diverged");
    expect(c.confirmers[0]!.diverged?.map((p) => p.label)).toEqual([dexPoolLabel("NVDA", { pool: WETH_POOL, fee: 500, quote: "eth" })]);
    expect(c.diffBps!).toBeLessThan(1); // the reported (median) gap stays the reference's
  });

  test("a one-block spot push into a sparse range does not drop a pool below its floor", async () => {
    const { src, pool } = setup();
    // the USDG pool's spot pushed ~40% away, where only ~$900 of liquidity sits; its window average is still $227k
    const p = pool(USDG_POOL);
    p.spotTick = p.meanTick + 5_000;
    p.depthUsd = 900;
    p.twapDepthUsd = 227_000;
    const o = await src.observe("NVDA");
    if (!o.ok) throw new Error(o.reason);
    const usdg = okPool(o.pools[0]);
    expect(usdg.depthUsd).toBeLessThan(1_000);
    expect(bps(usdg.twapDepthUsd, 227_000)).toBeLessThan(2);
    expect(usdg.weightUsd).toBe(usdg.depthUsd);
    // the same pool with a thin window average is below its floor
    p.twapDepthUsd = 14_000;
    p.observationIndex = 11;
    const thin = await src.observe("NVDA");
    expect(thin.ok && thin.pools[0]!.ok).toBe(false);
  });
});

describe("I1 b: any usable pool beyond the band is a divergence; the weighted median is the reported value", () => {
  const parts = (...prices: number[]) => prices.map((price, i) => ({ label: `pool${i}`, price }));

  test("confirmed only when every usable pool agrees; one diverging pool alerts, named; all failing is unavailable", () => {
    expect(confirmOf({ price: 100.3, parts: parts(100.3, 100.1) }, 100).status).toBe("ok");
    const one = confirmOf({ price: 100.3, parts: parts(100.3, 120) }, 100);
    expect(one.status).toBe("diverged");
    expect(one.confirmers[0]!.diverged).toEqual([{ label: "pool1", price: 120, diffBps: 2_000 }]);
    // a thin pool agreeing cannot hide the deep pool's divergence
    expect(confirmOf({ price: 105, parts: parts(105, 100.1) }, 100).status).toBe("diverged");
    expect(confirmOf(null, 100).status).toBe("unavailable");
  });

  test("through the source: the deeper pool is the reported value, the other pool's divergence still alerts", async () => {
    const { src } = setup({ wethPoolUsd: TOKEN_USD * 1.2 });
    const o = await src.observe("NVDA");
    if (!o.ok) throw new Error(o.reason);
    expect(o.quote).toBe("usd");
    const f = (await src.fetch("NVDA"))!;
    expect(f.price).toBe(o.price);
    expect(f.parts?.map((p) => Math.round(p.price))).toEqual([Math.round(TOKEN_USD), Math.round(TOKEN_USD * 1.2)]);
    expect(confirmOf(f).status).toBe("diverged");
    // every pool agreeing: confirmed
    const calm = setup();
    expect(confirmOf((await calm.src.fetch("NVDA"))!).status).toBe("ok");
  });
});

describe("combining several pools", () => {
  const P = (price: number, weightUsd: number, label = `p${price}`, quote: "usd" | "eth" = "usd"): Extract<DexPoolObservation, { ok: true }> => ({
    ok: true,
    pool: getAddress(`0x${(Math.round(price * 100) + weightUsd).toString(16).padStart(40, "0")}`) as Address,
    label,
    quote,
    price,
    tokenPrice: price,
    spotTokenPrice: price,
    meanTick: 0,
    twapSec: 1800,
    ts: 1,
    uiMultiplier: WAD,
    depthQuote: weightUsd,
    depthUsd: weightUsd,
    twapDepthUsd: weightUsd,
    weightUsd,
    cardinality: 7200,
    historySec: 86_400,
    lastSwapAgeSec: 30,
  });
  const F = (reason: string, label = "failed"): DexPoolObservation => ({ ok: false, pool: USDG_POOL, label, quote: "usd", reason });

  test("weighted median: the heavier of two decides; three pools: one outlier never moves it outside the others", () => {
    expect(weightedMedian([P(100, 20_000), P(110, 200_000)]).value).toBe(110);
    expect(weightedMedian([P(100, 200_000), P(110, 20_000)]).value).toBe(100);
    for (const outlier of [1, 99, 150, 10_000]) {
      const m = weightedMedian([P(100, 100_000), P(101, 90_000), P(outlier, 80_000)]).value;
      expect(m === 100 || m === 101).toBe(true);
    }
    expect(() => weightedMedian([])).toThrow("no pools");
  });

  test("M3: a 50/50 split reports the mean of the two middle values (neither side favoured)", () => {
    expect(weightedMedian([P(110, 50_000), P(100, 50_000)]).value).toBe(105);
    expect(weightedMedian([P(100, 30_000), P(104, 20_000), P(110, 50_000)]).value).toBe(107);
    const c = combineDexPools([P(110, 50_000, "a"), P(100, 50_000, "b")]);
    expect(c.ok && c.price).toBe(105);
  });

  test("I2: the WETH pools share one leg: their combined weight is capped at the leg's weight", () => {
    const pools = [P(100, 150_000, "usdg"), P(101, 117_000, "weth500", "eth"), P(101, 78_000, "weth3000", "eth")];
    // uncapped, the two WETH pools (195k) outweigh the USDG pool (150k) and set the value
    expect(weightedMedian(pools).value).toBe(101);
    const capped = capSharedLeg(pools, 100_000);
    const w = (label: string) => okPool(capped.find((p) => p.label === label)).weightUsd;
    expect(w("weth500") + w("weth3000")).toBeCloseTo(100_000, 6);
    expect(w("weth500") / w("weth3000")).toBeCloseTo(117 / 78, 9);
    expect(w("usdg")).toBe(150_000);
    expect(weightedMedian(capped.filter((p): p is Extract<DexPoolObservation, { ok: true }> => p.ok)).value).toBe(100);
    // under the cap: unchanged
    expect(capSharedLeg(pools, 500_000)).toEqual(pools);
  });

  test("I2 through the source: two WETH pools over a $100k leg do not outweigh a $150k USDG pool", async () => {
    const r = new FakeDexReader();
    const wethPer = (TOKEN_USD * 1.01) / ETH_USD;
    r.addPool(USDG_POOL, { token0: USDG, token1: NVDA, fee: 500, meanTick: tickFor(TOKEN_USD, false), depthUsd: 150_000 });
    r.addPool(WETH_POOL, { token0: WETH, token1: NVDA, quote: WETH, fee: 500, meanTick: tickFor(wethPer, false, 18, 18), depthUsd: 60 });
    r.addPool(WETH_POOL_2, { token0: WETH, token1: NVDA, quote: WETH, fee: 3000, meanTick: tickFor(wethPer, false, 18, 18), depthUsd: 40 });
    r.addPool(LEG, { token0: WETH, token1: USDG, quote: USDG, fee: 100, meanTick: tickFor(ETH_USD, true, 18, 6), depthUsd: 100_000 });
    r.setToken(NVDA);
    const src = new DexTwapSource(
      {
        NVDA: [
          dexPool(USDG_POOL, NVDA, { fee: 500, minDepthUsd: 15_000 }),
          dexPool(WETH_POOL, NVDA, { fee: 500, quoteToken: WETH, quote: "eth", minDepthUsd: 25_000 }),
          dexPool(WETH_POOL_2, NVDA, { fee: 3000, quoteToken: WETH, quote: "eth", minDepthUsd: 25_000 }),
        ],
      },
      r,
      { maxAgeMs: 120_000, factory: FACTORY, ethUsd: leg() },
    );
    const o = await src.observe("NVDA");
    if (!o.ok) throw new Error(o.reason);
    const eth = o.pools.filter((p) => p.quote === "eth").map(okPool);
    expect(bps(eth.reduce((s, p) => s + p.weightUsd, 0), 100_000)).toBeLessThan(2);
    expect(o.quote).toBe("usd");
    expect(bps(o.price, TOKEN_USD)).toBeLessThan(1);
  });

  test("a heavy pool below its floor (unusable) leaves the thin usable one to confirm alone", () => {
    const c = combineDexPools([F("insufficient depth: $9,000 moves the price 2% (floor $15,000)", "deep"), P(100.4, 26_000, "thin")]);
    expect(c.ok && [c.price, c.label]).toEqual([100.4, "thin"]);
    expect(c.pools).toHaveLength(2);
  });

  test("all pools failing: unavailable, every pool's reason named; one pool: its own reason", () => {
    const c = combineDexPools([
      F("no swap in the 1800s TWAP window (last swap 2000s ago): the TWAP would be an old trade", "NVDA/USDG 500 0xd4EB..14a3"),
      F("ETH/USD leg WETH/USDG 100 0x52e6..71Ca: insufficient depth", "NVDA/WETH 500 0x62AB..6b6C"),
    ]);
    expect(c.ok).toBe(false);
    expect(!c.ok && c.reason).toBe(
      "no usable confirm pool (2 configured): NVDA/USDG 500 0xd4EB..14a3: no swap in the 1800s TWAP window (last swap 2000s ago): the TWAP would be an old trade; NVDA/WETH 500 0x62AB..6b6C: ETH/USD leg WETH/USDG 100 0x52e6..71Ca: insufficient depth",
    );
    const one = combineDexPools([F("observe([1800, 0]) failed: OLD")]);
    expect(!one.ok && one.reason).toBe("observe([1800, 0]) failed: OLD");
    expect(combineDexPools([])).toEqual({ ok: false, reason: "no DEX confirm pool configured" });
  });

  test("one token-state read per Stock Token, whatever its number of pools", async () => {
    const { r, src } = setup();
    let reads = 0;
    const orig = r.tokenState.bind(r);
    r.tokenState = async (t, b) => {
      reads++;
      return orig(t, b);
    };
    await src.observe("NVDA");
    expect(reads).toBe(1);
  });
});

describe("confirm notes (which pools were used / failed)", () => {
  test("names the used pools with price, depth and weight, the reference, and every failed pool with its reason", async () => {
    const { src, pool } = setup();
    expect(src.confirmNote("NVDA")).toBeNull(); // not observed yet
    await src.observe("NVDA");
    const usdg = dexPoolLabel("NVDA", { pool: USDG_POOL, fee: 500, quote: "usd" });
    const weth = dexPoolLabel("NVDA", { pool: WETH_POOL, fee: 500, quote: "eth" });
    expect(src.confirmNote("NVDA")).toMatch(
      new RegExp(
        `^dex-twap: used ${esc(usdg)} \\$162\\.\\d\\d \\(2% depth \\$227,\\d{3} avg / \\$227,\\d{3} now, weight \\$227,\\d{3}, reference\\), ${esc(weth)} \\$162\\.\\d\\d \\(2% depth \\$116,\\d{3} avg / \\$116,\\d{3} now, weight \\$116,\\d{3}\\) \\(weighted median \\$162\\.\\d\\d\\)$`,
      ),
    );
    pool(WETH_POOL).newestTs = pool(WETH_POOL).newestTs - 670;
    pool(WETH_POOL).observationIndex = 11;
    await src.observe("NVDA");
    expect(src.confirmNote("NVDA")).toContain(`; failed ${weth}: no swap in the 600s TWAP window (last swap 700s ago)`);
    expect(src.confirmNote("AAPL")).toBeNull();
  });
});
