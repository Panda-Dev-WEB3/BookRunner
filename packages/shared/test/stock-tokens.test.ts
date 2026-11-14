import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import {
  MAINNET_CHAIN_ID,
  MULTIPLIER_VECTOR as V,
  RHC_TOKENS,
  WAD,
  dexPoolQuotedInEth,
  feedAnswerToWad,
  feedToken,
  loadChainPriceConfig,
  parseChainPriceConfig,
  parseFixed,
  perSharePriceWad,
} from "../src";

describe("multiplier convention (VERIFY C2)", () => {
  test("per-token feed / uiMultiplier -> per-share; registry formula -> qty x feed (applied once)", () => {
    const tokenWad = feedAnswerToWad(V.feedAnswer, V.feedDecimals);
    const perShare = perSharePriceWad(tokenWad, V.uiMultiplierWad);
    // the oracle signs 8 dp: round the per-share price like domain/price.ts
    const rounded = parseFixed((Number(perShare) / 1e18).toFixed(8), 18);
    expect(rounded).toBe(V.perSharePriceWad);
    expect(Number(rounded) / 1e18).toBe(V.perSharePrice);
    // StockTokenRegistry._value: qty * mult * price / (10^dec * 1e18 * 1e12)
    const value = (V.qtyRaw * V.uiMultiplierWad * V.perSharePriceWad) / (10n ** BigInt(V.decimals) * WAD * 10n ** 12n);
    expect(value).toBe(V.valueUsd6);
    // == Robinhood's holdings formula: balance * feed / 1e8 (-> 6 dp)
    expect((V.qtyRaw * V.feedAnswer) / 10n ** 8n / 10n ** 12n).toBe(V.valueUsd6);
    // the double-apply bug the convention prevents
    const doubled = (V.qtyRaw * V.uiMultiplierWad * tokenWad) / (10n ** BigInt(V.decimals) * WAD * 10n ** 12n);
    expect(doubled).toBe(V.doubleAppliedUsd6);
  });

  test("feedAnswerToWad scales both ways; perSharePriceWad rejects a zero multiplier", () => {
    expect(feedAnswerToWad(19_000_000_000n, 8)).toBe(190n * WAD);
    expect(feedAnswerToWad(190n * 10n ** 20n, 20)).toBe(190n * WAD);
    expect(() => perSharePriceWad(WAD, 0n)).toThrow("uiMultiplier");
  });
});

describe("chain price config", () => {
  test("config/chains/4663.json: canonical tokens + per-token Chainlink feeds for the launch tickers", () => {
    const cfg = loadChainPriceConfig(MAINNET_CHAIN_ID);
    expect(cfg).not.toBeNull();
    const c = cfg!;
    expect(c.chainId).toBe(4663);
    for (const t of ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN"]) {
      const st = c.stockTokens[t]!;
      const f = c.chainlink.feeds[t]!;
      // stored checksummed (viem's getAddress would throw on a bad checksum)
      expect(getAddress(st.token)).toBe(st.token as `0x${string}`);
      expect(getAddress(f.proxy)).toBe(f.proxy as `0x${string}`);
      expect(st.decimals).toBe(18);
      expect(st.multiplierSource).toBe("uiMultiplier");
      expect(f.basis).toBe("per-token");
      expect(f.decimals).toBe(8);
      expect(f.heartbeatSec).toBe(86_400);
      expect(feedToken(c, t, f)).toBe(getAddress(st.token));
    }
    // no feed shares a proxy, no token is listed twice
    expect(new Set(Object.values(c.chainlink.feeds).map((f) => f.proxy.toLowerCase())).size).toBe(5);
    expect(new Set(Object.values(c.stockTokens).map((s) => s.token.toLowerCase())).size).toBe(5);
  });

  test("missing default file -> null; explicit missing file / wrong chain -> throws", () => {
    expect(loadChainPriceConfig(999_999)).toBeNull();
    expect(() => loadChainPriceConfig(1, "config/chains/nope.json")).toThrow("not found");
    expect(() => loadChainPriceConfig(1, "config/chains/4663.json")).toThrow("chainId 4663 != 1");
  });

  test("a per-token feed must resolve a token", () => {
    const feed = { proxy: "0x00000000000000000000000000000000000000c1", basis: "per-token" };
    expect(() => parseChainPriceConfig({ chainId: 1, chainlink: { feeds: { NVDA: feed } } })).toThrow("per-token feed needs");
    const ok = parseChainPriceConfig({ chainId: 1, chainlink: { feeds: { NVDA: { ...feed, token: "0x00000000000000000000000000000000000000d1" } } } });
    expect(ok.chainlink.sequencerUptimeFeed).toBeNull();
    expect(() => parseChainPriceConfig({ chainId: 1, stockTokens: { X: { token: "0x12" } } })).toThrow("stockTokens.X.token");
  });

  test("dexConfirm: pools need a stockTokens entry, a fee tier, a positive depth floor, twapSec >= 60 (default 600)", () => {
    const token = { token: "0x00000000000000000000000000000000000000d1" };
    const pool = { pool: "0x00000000000000000000000000000000000000e1", quoteToken: "0x00000000000000000000000000000000000000f1", fee: 3000, minDepthUsd: 50_000 };
    const ok = parseChainPriceConfig({ chainId: 1, stockTokens: { NVDA: token }, dexConfirm: { readAt: "2026-10-17", pools: { NVDA: pool } } });
    // a single pool object is read as a one-pool list
    expect(ok.dexConfirm?.pools.NVDA?.[0]?.twapSec).toBe(1_800);
    expect(ok.dexConfirm?.pools.NVDA).toHaveLength(1);
    expect(() => parseChainPriceConfig({ chainId: 1, dexConfirm: { pools: { NVDA: pool } } })).toThrow("DEX confirm pool needs a stockTokens entry");
    expect(() => parseChainPriceConfig({ chainId: 1, stockTokens: { NVDA: token }, dexConfirm: { pools: { NVDA: { ...pool, minDepthUsd: 0 } } } })).toThrow("minDepthUsd");
    expect(() => parseChainPriceConfig({ chainId: 1, stockTokens: { NVDA: token }, dexConfirm: { pools: { NVDA: { ...pool, twapSec: 30 } } } })).toThrow("twapSec");
    const { fee: _fee, ...noFee } = pool;
    expect(() => parseChainPriceConfig({ chainId: 1, stockTokens: { NVDA: token }, dexConfirm: { pools: { NVDA: noFee } } })).toThrow("fee");
    expect(parseChainPriceConfig({ chainId: 1 }).dexConfirm).toBeUndefined();
  });

  test("dexConfirm: several pools per ticker; a WETH-quoted pool needs the ethUsd leg; quote tokens USD or WETH only; no pool twice", () => {
    const token = { token: "0x00000000000000000000000000000000000000d1" };
    const usd = "0x00000000000000000000000000000000000000f1";
    const weth = "0x00000000000000000000000000000000000000f2";
    const usdPool = { pool: "0x00000000000000000000000000000000000000e1", quoteToken: usd, fee: 500, minDepthUsd: 15_000 };
    const wethPool = { pool: "0x00000000000000000000000000000000000000e2", quoteToken: weth, fee: 500, minDepthUsd: 25_000 };
    const ethUsd = { pool: "0x00000000000000000000000000000000000000e9", fee: 100, weth, quoteToken: usd, minDepthUsd: 50_000 };
    const cfg = (dexConfirm: unknown) => parseChainPriceConfig({ chainId: 1, stockTokens: { NVDA: token }, dexConfirm });
    const ok = cfg({ pools: { NVDA: [usdPool, wethPool] }, ethUsd });
    expect(ok.dexConfirm?.pools.NVDA?.map((p) => p.pool)).toEqual([usdPool.pool, wethPool.pool]);
    expect(ok.dexConfirm?.pools.NVDA?.map((p) => dexPoolQuotedInEth(ok.dexConfirm!, p))).toEqual([false, true]);
    expect(() => cfg({ pools: { NVDA: [] } })).toThrow("dexConfirm.pools.NVDA");
    // a pool quoted in the leg's WETH, or in the chain's canonical WETH, without a leg
    expect(() => cfg({ pools: { NVDA: [wethPool] } }).dexConfirm).not.toThrow(); // unknown token without a leg: a USD quote
    expect(() => cfg({ pools: { NVDA: [{ ...wethPool, quoteToken: RHC_TOKENS.WETH }] } })).toThrow("WETH-quoted confirm pool needs dexConfirm.ethUsd");
    // with a leg, any other quote token is refused
    expect(() => cfg({ pools: { NVDA: [{ ...usdPool, quoteToken: "0x00000000000000000000000000000000000000f3" }] }, ethUsd })).toThrow("quoteToken must be ethUsd.quoteToken (USD) or ethUsd.weth (WETH)");
    expect(() => cfg({ pools: { NVDA: [usdPool, { ...usdPool }] } })).toThrow("is listed twice");
    expect(() => cfg({ pools: { NVDA: [{ ...usdPool, pool: ethUsd.pool }] }, ethUsd })).toThrow("is listed twice (or is the ethUsd leg)");
    expect(() => cfg({ pools: { NVDA: [usdPool] }, ethUsd: { ...ethUsd, weth: usd } })).toThrow("ethUsd.weth and ethUsd.quoteToken must differ");
    expect(() => cfg({ pools: { NVDA: [usdPool] }, ethUsd: { ...ethUsd, minDepthUsd: 0 } })).toThrow("minDepthUsd");
  });

  test("config/chains/4663.json: every ticker has a USDG pool; WETH pools only with the ethUsd leg (WETH / USDG, canonical tokens)", () => {
    const d = loadChainPriceConfig(MAINNET_CHAIN_ID)!.dexConfirm!;
    expect(d.ethUsd).toMatchObject({ weth: RHC_TOKENS.WETH, quoteToken: RHC_TOKENS.USDG, fee: 100 });
    for (const [t, pools] of Object.entries(d.pools)) {
      expect(pools[0]!.quoteToken, t).toBe(RHC_TOKENS.USDG);
      for (const p of pools) expect([RHC_TOKENS.USDG, RHC_TOKENS.WETH]).toContain(getAddress(p.quoteToken));
    }
    expect(d.pools.NVDA!.filter((p) => dexPoolQuotedInEth(d, p))).toHaveLength(2);
  });
});
