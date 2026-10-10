import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import {
  MAINNET_CHAIN_ID,
  MULTIPLIER_VECTOR as V,
  WAD,
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
});
