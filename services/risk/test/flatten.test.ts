import { describe, expect, test } from "bun:test";
import { MULTIPLIER_VECTOR as V, usd, wad } from "@bookrunner/shared";
import { planFlatten, stockValueUsd } from "../src/domain/flatten";
import { NVDA_TOKEN, TSLA_TOKEN, holding } from "./fakes";

describe("planFlatten", () => {
  const nvda = holding(NVDA_TOKEN, 100, 190); // 19,000 USD

  test("mode all sells every token, minAmountOut = oracle value - slippage", () => {
    const p = planFlatten({ holdings: [nvda], netBookExposureUsd: usd(-50_000), mode: "all", slippageBps: 100 });
    expect(p.orders).toHaveLength(1);
    expect(p.orders[0]?.amountIn).toBe(nvda.qtyRaw);
    expect(p.orders[0]?.expectedOutUsd).toBe(usd(19_000));
    expect(p.orders[0]?.minAmountOut).toBe(usd(18_810));
  });

  test("net mode, venue flat: the whole hedge is excess and is sold", () => {
    const p = planFlatten({ holdings: [nvda], netBookExposureUsd: usd(19_000), mode: "net", slippageBps: 50 });
    expect(p.sellUsd).toBe(usd(19_000));
    expect(p.orders[0]?.amountIn).toBe(nvda.qtyRaw);
    expect(p.orders[0]?.minAmountOut).toBe(usd(18_905));
  });

  test("net mode, hedge offsets a short venue exposure: nothing is sold (would add risk)", () => {
    // venue -20k + desk +19k = -1k net
    const p = planFlatten({ holdings: [nvda], netBookExposureUsd: usd(-1_000), mode: "net", slippageBps: 100 });
    expect(p.orders).toEqual([]);
    expect(p.sellUsd).toBe(0n);
  });

  test("net mode, over-hedged: only the excess is sold, pro-rata across tokens", () => {
    const tsla = holding(TSLA_TOKEN, 25, 440); // 11,000
    // venue -25k, desk +30k -> net +5k -> sell 5k of 30k = 1/6
    const p = planFlatten({ holdings: [nvda, tsla], netBookExposureUsd: usd(5_000), mode: "net", slippageBps: 0 });
    expect(p.sellUsd).toBe(usd(5_000));
    expect(p.orders.map((o) => o.token)).toEqual([NVDA_TOKEN, TSLA_TOKEN]);
    expect(p.orders[0]?.amountIn).toBe((nvda.qtyRaw * 5n) / 30n);
    expect(p.orders[1]?.amountIn).toBe((tsla.qtyRaw * 5n) / 30n);
    const total = p.orders.reduce((s, o) => s + o.expectedOutUsd, 0n);
    expect(total).toBeLessThanOrEqual(usd(5_000));
    expect(total).toBeGreaterThan(usd(4_999.99));
  });

  test("tokens without a price are skipped (never sold with minAmountOut 0)", () => {
    const unpriced = { ...holding(TSLA_TOKEN, 10, 440), valueUsd: 0n, priceWad: 0n };
    const p = planFlatten({ holdings: [unpriced], netBookExposureUsd: usd(10_000), mode: "all", slippageBps: 100 });
    expect(p.orders).toEqual([]);
    expect(p.skipped).toEqual([{ token: TSLA_TOKEN, reason: "no_price" }]);
  });

  test("empty desk: nothing to do", () => {
    expect(planFlatten({ holdings: [], netBookExposureUsd: 0n, mode: "all", slippageBps: 100 }).orders).toEqual([]);
  });
});

describe("stockValueUsd (registry fallback)", () => {
  test("multiplier applied exactly once", () => {
    const qty = 10n * 10n ** 18n; // 10 tokens, 18 decimals
    expect(stockValueUsd(qty, wad(1), wad(190), 18)).toBe(usd(1_900));
    expect(stockValueUsd(qty, wad(2), wad(190), 18)).toBe(usd(3_800)); // exactly 2x
    expect(stockValueUsd(10_000_000n, wad(1), wad(190), 6)).toBe(usd(1_900)); // 6-decimals token
  });

  test("pinned convention (VERIFY C2): per-share oracle price x live uiMultiplier = qty x Chainlink per-token feed", () => {
    // the multiplier comes from registry.getToken (the token's live uiMultiplier on mainnet), the price is
    // the oracle's per-share price (feed / uiMultiplier): applied once, never twice
    expect(stockValueUsd(V.qtyRaw, V.uiMultiplierWad, V.perSharePriceWad, V.decimals)).toBe(V.valueUsd6);
    const perTokenWad = V.feedAnswer * 10n ** 10n;
    expect(stockValueUsd(V.qtyRaw, V.uiMultiplierWad, perTokenWad, V.decimals)).toBe(V.doubleAppliedUsd6);
  });
});
