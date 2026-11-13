// Several confirm pools per ticker (sources/dex-twap.ts): Stock-Token / WETH pools priced through the WETH / USDG
// leg (TWAP x TWAP over the same window, decimals, token0 / token1 both ways, the multiplier), the depth floor in USD
// through the leg, the depth-weighted median that combines the usable pools, and what the confirm status becomes.
import { describe, expect, test } from "bun:test";
import { MULTIPLIER_VECTOR as V, WAD } from "@bookrunner/shared";
import { type Address, getAddress } from "viem";
import { primaryConfirm } from "../src/domain/confirm";
import { type DexPoolObservation, DexTwapSource, type ResolvedEthUsdLeg, combineDexPools, depthWeightedMedian, dexPoolLabel, ethLegLabel } from "../src/sources/dex-twap";
import { FACTORY, FakeDexReader, USDG, WETH, dexPool, tickFor } from "./dex-fakes";

const NVDA = getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
const USDG_POOL = getAddress("0x00000000000000000000000000000000000b0001");
const WETH_POOL = getAddress("0x00000000000000000000000000000000000b0002");
const WETH_POOL_2 = getAddress("0x00000000000000000000000000000000000b0003");
const LEG = getAddress("0x00000000000000000000000000000000000b00e1");
const bps = (a: number, b: number) => (Math.abs(a - b) / b) * 1e4;

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
  return { r, src };
}

const okPool = (o: DexPoolObservation | undefined) => {
  if (!o?.ok) throw new Error(o ? o.reason : "no observation");
  return o;
};

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
        // the 2% depth in WETH, valued in USD at the leg's TWAP
        expect(o.depthQuote).toBeCloseTo(60, 3);
        expect(bps(o.depthUsd, 60 * ETH_USD)).toBeLessThan(1);
      }
    }
  });

  test("decimals: a Stock Token with 8 decimals and a 6-decimal USD quote give the same USD price", async () => {
    const { src } = setup({ stockDecimals: 8 });
    const o = await src.observe("NVDA");
    if (!o.ok) throw new Error(o.reason);
    for (const p of o.pools) expect(bps(okPool(p).tokenPrice, TOKEN_USD)).toBeLessThan(1.1);
  });

  test("the leg is observed at the WETH pools' window in the same read; a USDG-only pass does not read it", async () => {
    const { r, src } = setup();
    await src.observe("NVDA");
    expect(r.observed.find((x) => x.pool === LEG.toLowerCase())?.secondsAgos).toEqual([600, 0]);
    expect(r.observed.find((x) => x.pool === WETH_POOL.toLowerCase())?.secondsAgos).toEqual([600, 0]);
    // two windows: one observe([w1, w2, 0]) on the leg
    const r2 = new FakeDexReader();
    r2.addPool(WETH_POOL, { token0: WETH, token1: NVDA, quote: WETH, fee: 500, meanTick: tickFor(TOKEN_USD / ETH_USD, false, 18, 18), depthUsd: 60 });
    r2.addPool(WETH_POOL_2, { token0: WETH, token1: NVDA, quote: WETH, fee: 3000, meanTick: tickFor(TOKEN_USD / ETH_USD, false, 18, 18), depthUsd: 40 });
    r2.addPool(LEG, { token0: WETH, token1: USDG, quote: USDG, fee: 100, meanTick: tickFor(ETH_USD, true, 18, 6), depthUsd: 264_000 });
    r2.setToken(NVDA);
    const two = new DexTwapSource(
      { NVDA: [dexPool(WETH_POOL, NVDA, { fee: 500, quoteToken: WETH, quote: "eth", twapSec: 1800 }), dexPool(WETH_POOL_2, NVDA, { fee: 3000, quoteToken: WETH, quote: "eth", twapSec: 900 })] },
      r2,
      { maxAgeMs: 120_000, factory: FACTORY, ethUsd: leg() },
    );
    const o = await two.observe("NVDA");
    expect(o.ok).toBe(true);
    expect(r2.observed.filter((x) => x.pool === LEG.toLowerCase()).map((x) => x.secondsAgos)).toEqual([[900, 1800, 0]]);
    // only USDG pools usable: the leg is not read at all
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
    expect(!o.ok && o.reason).toMatch(/^insufficient depth: \$23,3\d\d moves the price 2% \(floor \$25,000; 12\.0 WETH at \$1,94\d\)$/);
    const ok = setup({ wethDepth: 13, withUsdgPool: false });
    expect((await ok.src.observe("NVDA")).ok).toBe(true);
  });

  test("the leg's own checks: depth floor, swap inside the window, history, factory pool; failing, every WETH pool confirms nothing", async () => {
    const shallow = setup({ legDepth: 40_000 });
    let o = await shallow.src.observe("NVDA");
    // the USDG pool still confirms; the WETH pool names the leg
    expect(o.ok && o.pools.map((p) => [p.quote, p.ok])).toEqual([
      ["usd", true],
      ["eth", false],
    ]);
    const weth = o.pools?.[1];
    expect(weth && !weth.ok && weth.reason).toMatch(new RegExp(`^ETH/USD leg ${esc(ethLegLabel(leg()))}: insufficient depth: \\$(39,9\\d\\d|40,0\\d\\d) moves the price 2% \\(floor \\$50,000\\)$`));
    expect(shallow.src.legObservation()).toMatchObject({ ok: false, label: ethLegLabel(leg()) });

    const quiet = setup({ withUsdgPool: false });
    quiet.r.pools.get(LEG.toLowerCase())!.newestTs = quiet.r.blockNow.timestamp - 600;
    o = await quiet.src.observe("NVDA");
    expect(!o.ok && o.reason).toBe(`ETH/USD leg ${ethLegLabel(leg())}: no swap in the 600s TWAP window (last swap 600s ago)`);

    const young = setup({ withUsdgPool: false });
    young.r.pools.get(LEG.toLowerCase())!.oldestTs = young.r.blockNow.timestamp - 300;
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

describe("combining several pools", () => {
  const P = (price: number, depthUsd: number, label = `p${price}`): Extract<DexPoolObservation, { ok: true }> => ({
    ok: true,
    pool: getAddress(`0x${(Math.round(price * 100) + depthUsd).toString(16).padStart(40, "0")}`) as Address,
    label,
    quote: "usd",
    price,
    tokenPrice: price,
    spotTokenPrice: price,
    meanTick: 0,
    twapSec: 1800,
    ts: 1,
    uiMultiplier: WAD,
    depthQuote: depthUsd,
    depthUsd,
    cardinality: 7200,
    historySec: 86_400,
    lastSwapAgeSec: 30,
  });
  const F = (reason: string, label = "failed"): DexPoolObservation => ({ ok: false, pool: USDG_POOL, label, quote: "usd", reason });

  test("depth-weighted median: the deeper of two decides; three pools: one outlier never moves it outside the others", () => {
    expect(depthWeightedMedian([P(100, 20_000), P(110, 200_000)]).price).toBe(110);
    expect(depthWeightedMedian([P(100, 200_000), P(110, 20_000)]).price).toBe(100);
    // a single pool with less than half the depth: wherever it sits, the value stays among the others
    for (const outlier of [1, 99, 150, 10_000]) {
      const m = depthWeightedMedian([P(100, 100_000), P(101, 90_000), P(outlier, 80_000)]).price;
      expect(m === 100 || m === 101).toBe(true);
    }
    // equal depth: the lower price (deterministic)
    expect(depthWeightedMedian([P(110, 50_000), P(100, 50_000)]).price).toBe(100);
    expect(() => depthWeightedMedian([])).toThrow("no pools");
  });

  const status = (dexPrice: number | null, chainlink = 100) =>
    primaryConfirm(
      [{ name: "chainlink", price: chainlink, ts: 1_000 }, ...(dexPrice === null ? [] : [{ name: "dex-twap", price: dexPrice, ts: 1_000 }])],
      { nowMs: 1_000, primary: "chainlink", confirmBps: 200, maxAgeMs: 60_000 },
    ).confirm.status;
  const combined = (...pools: DexPoolObservation[]) => {
    const c = combineDexPools(pools);
    return c.ok ? c.price : null;
  };

  test("a thin pool cannot raise a false divergence while a deeper pool agrees with Chainlink", () => {
    expect(status(combined(P(100.3, 227_000), P(120, 30_000)))).toBe("ok");
  });

  test("a thin pool cannot hide a real divergence the deeper pool shows", () => {
    expect(status(combined(P(105, 227_000), P(100.1, 30_000)))).toBe("diverged");
  });

  test("every usable pool diverging is a divergence; one of three diverging is not", () => {
    expect(status(combined(P(104, 100_000), P(106, 90_000)))).toBe("diverged");
    expect(status(combined(P(96, 100_000), P(104, 100_000)))).toBe("diverged");
    expect(status(combined(P(100.2, 100_000), P(99.9, 90_000), P(130, 95_000)))).toBe("ok");
  });

  test("a deep pool below its floor (unusable) leaves the thin usable one to confirm alone", () => {
    const c = combineDexPools([F("insufficient depth: $9,000 moves the price 2% (floor $15,000)", "deep"), P(100.4, 26_000, "thin")]);
    expect(c.ok && [c.price, c.label]).toEqual([100.4, "thin"]);
    expect(c.pools).toHaveLength(2);
  });

  test("all pools failing: unavailable, every pool's reason named; one pool: its own reason", () => {
    const c = combineDexPools([F("no swap in the 1800s TWAP window (last swap 2000s ago): the TWAP would be an old trade", "NVDA/USDG 500 0xd4EB..14a3"), F("ETH/USD leg WETH/USDG 100 0x52e6..71Ca: insufficient depth", "NVDA/WETH 500 0x62AB..6b6C")]);
    expect(c.ok).toBe(false);
    expect(!c.ok && c.reason).toBe(
      "no usable confirm pool (2 configured): NVDA/USDG 500 0xd4EB..14a3: no swap in the 1800s TWAP window (last swap 2000s ago): the TWAP would be an old trade; NVDA/WETH 500 0x62AB..6b6C: ETH/USD leg WETH/USDG 100 0x52e6..71Ca: insufficient depth",
    );
    expect(status(null)).toBe("unavailable");
    const one = combineDexPools([F("observe([1800, 0]) failed: OLD")]);
    expect(!one.ok && one.reason).toBe("observe([1800, 0]) failed: OLD");
    expect(combineDexPools([])).toEqual({ ok: false, reason: "no DEX confirm pool configured" });
  });

  test("through the source: deep USDG pool + thinner WETH pool; the deeper decides, each pool's TWAP is kept", async () => {
    // WETH pool manipulated +20%, but thinner ($117k) than the USDG pool ($227k): no divergence
    let { src } = setup({ wethPoolUsd: TOKEN_USD * 1.2 });
    let o = await src.observe("NVDA");
    if (!o.ok) throw new Error(o.reason);
    expect(o.quote).toBe("usd");
    expect(status(o.price, TOKEN_USD)).toBe("ok");
    expect(o.pools.map((p) => p.ok && Math.round(p.price))).toEqual([Math.round(TOKEN_USD), Math.round(TOKEN_USD * 1.2)]);
    // the USDG pool thinned to $50k: the WETH pool is now the deeper one and its divergence shows
    ({ src } = setup({ wethPoolUsd: TOKEN_USD * 1.2, usdgDepth: 50_000 }));
    o = await src.observe("NVDA");
    expect(o.ok && o.quote).toBe("eth");
    expect(o.ok && status(o.price, TOKEN_USD)).toBe("diverged");
    // the fetch value is the combined one
    expect((await src.fetch("NVDA"))?.price).toBe(o.ok ? o.price : -1);
  });

  test("one aggregate token-state read per Stock Token, whatever its number of pools", async () => {
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
  test("names the used pools with price and depth, the reference, and every failed pool with its reason", async () => {
    const { r, src } = setup();
    expect(src.confirmNote("NVDA")).toBeNull(); // not observed yet
    await src.observe("NVDA");
    const usdg = dexPoolLabel("NVDA", { pool: USDG_POOL, fee: 500, quote: "usd" });
    const weth = dexPoolLabel("NVDA", { pool: WETH_POOL, fee: 500, quote: "eth" });
    expect(src.confirmNote("NVDA")).toMatch(new RegExp(`^dex-twap: used ${esc(usdg)} \\$162\\.\\d\\d \\(2% depth \\$227,\\d{3}, reference\\), ${esc(weth)} \\$162\\.\\d\\d \\(2% depth \\$116,\\d{3}\\)$`));
    r.pools.get(WETH_POOL.toLowerCase())!.newestTs = r.blockNow.timestamp - 700;
    r.pools.get(WETH_POOL.toLowerCase())!.observationIndex = 11;
    await src.observe("NVDA");
    expect(src.confirmNote("NVDA")).toContain(`; failed ${weth}: no swap in the 600s TWAP window (last swap 700s ago)`);
    expect(src.confirmNote("AAPL")).toBeNull();
  });
});

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
