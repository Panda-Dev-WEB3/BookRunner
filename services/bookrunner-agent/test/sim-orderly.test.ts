import { describe, expect, test } from "bun:test";
import type { QuotingVenue } from "@bookrunner/shared";
import { mulberry32 } from "../src/domain/rng";
import { MockOrderlyTaker } from "../src/sim/orderly-taker";
import { CLOSE_ONLY_CLASSES, acceptablePriceWad, classifyTradeError, nextAction, nextDelayMs, sizeDeltaFor } from "../src/sim/trader-logic";
import { type FetchLike, MockOrderlyHttpVenue, createOrderlyVenue } from "../src/venues/orderly";
import { silentLog } from "./helpers";

const params = { minNotionalUsd: 200, maxNotionalUsd: 3_000, closeProb: 0.15, maxLeverage: 5, slippageBps: 50 };

describe("trader-sim logic", () => {
  test("close-only mode only closes; flat traders do nothing", () => {
    const rng = mulberry32(1);
    expect(nextAction(rng, { positionUsd: 1_000, marginUsd: 10_000, closeOnly: true }, params)).toEqual({ kind: "close" });
    expect(nextAction(rng, { positionUsd: 0, marginUsd: 10_000, closeOnly: true }, params).kind).toBe("none");
  });

  test("opens within notional bounds and the leverage cap; closes sometimes", () => {
    const rng = mulberry32(99);
    let closes = 0;
    for (let i = 0; i < 5_000; i++) {
      const pos = (rng.next() - 0.5) * 40_000;
      const a = nextAction(rng, { positionUsd: pos, marginUsd: 10_000, closeOnly: false }, params);
      if (a.kind === "close") closes++;
      if (a.kind === "open") {
        expect(a.notionalUsd).toBeGreaterThanOrEqual(params.minNotionalUsd - 1e-9);
        expect(a.notionalUsd).toBeLessThanOrEqual(params.maxNotionalUsd + 1e-9);
        const after = pos + (a.side === "buy" ? a.notionalUsd : -a.notionalUsd);
        expect(Math.abs(after)).toBeLessThanOrEqual(50_000 + 1e-6);
      }
    }
    expect(closes).toBeGreaterThan(300);
  });

  test("sizes, acceptable prices, arrival delays", () => {
    expect(sizeDeltaFor(1_900, 190, "buy")).toBe(10n * 10n ** 18n);
    expect(sizeDeltaFor(1_900, 190, "sell")).toBe(-10n * 10n ** 18n);
    expect(sizeDeltaFor(0, 190, "buy")).toBe(0n);
    expect(acceptablePriceWad(10_000n, 1n, 50)).toBe(10_050n);
    expect(acceptablePriceWad(10_000n, -1n, 50)).toBe(9_950n);
    const rng = mulberry32(5);
    const ds = Array.from({ length: 2_000 }, () => nextDelayMs(rng, 6));
    const mean = ds.reduce((s, x) => s + x, 0) / ds.length;
    expect(mean).toBeGreaterThan(8_000);
    expect(mean).toBeLessThan(12_000);
  });

  test("venue rejections are classified for graceful handling", () => {
    expect(classifyTradeError("StalePrice", "")).toBe("off_hours");
    expect(classifyTradeError(null, "execution reverted: ReduceOnly()")).toBe("reduce_only");
    expect(classifyTradeError("MaxNetExposure", "")).toBe("exposure_cap");
    expect(classifyTradeError(null, "InsufficientMargin")).toBe("margin");
    expect(classifyTradeError(null, "worse than acceptable price")).toBe("price");
    expect(classifyTradeError(null, "boom")).toBe("other");
    expect(CLOSE_ONLY_CLASSES).toContain("off_hours");
  });
});

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function fakeFetch(routes: Record<string, unknown>, calls: Call[]): FetchLike {
  return async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    const path = new URL(url).pathname;
    const body = routes[`${method} ${path}`] ?? { success: true, data: {} };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

describe("mock-orderly fallback venue", () => {
  const opts = { bookId: 1, symbol: "PERP_NVDA_USDC", accountId: "0xacc", baseUrl: "http://127.0.0.1:4420/" };

  test("replaceQuote = cancel-all then batch LIMIT orders with reduce_only flag", async () => {
    const calls: Call[] = [];
    const v = new MockOrderlyHttpVenue(opts, fakeFetch({}, calls));
    await v.replaceQuote({ bid: { px: 189.9, qty: 2 }, ask: { px: 190.1, qty: 3 }, reduceOnly: false });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["DELETE /v1/orders", "POST /v1/batch-order"]);
    const orders = (calls[1]!.body as { orders: Array<Record<string, unknown>> }).orders;
    expect(orders.map((o) => [o.side, o.order_price, o.order_quantity, o.order_type, o.reduce_only])).toEqual([
      ["BUY", 189.9, 2, "LIMIT", false],
      ["SELL", 190.1, 3, "LIMIT", false],
    ]);
    calls.length = 0;
    await v.replaceQuote({});
    expect(calls.length).toBe(1); // nothing to place after the cancel
  });

  test("account and fills parsing", async () => {
    const calls: Call[] = [];
    const v = new MockOrderlyHttpVenue(
      opts,
      fakeFetch(
        {
          "GET /v1/positions": { success: true, data: { rows: [{ symbol: "PERP_NVDA_USDC", position_qty: -10, average_open_price: 191, mark_price: 190, unsettled_pnl: 10 }] } },
          "GET /v1/client/holding": { success: true, data: { holding: [{ token: "USDC", holding: 75_000, frozen: 1_000 }] } },
          "GET /v1/trades": { success: true, data: { rows: [{ id: 7, symbol: "PERP_NVDA_USDC", side: "SELL", executed_price: 190.2, executed_quantity: 1.5, fee: 0.05, executed_timestamp: 2_000, is_maker: true }] } },
        },
        calls,
      ),
    );
    const a = await v.account();
    expect(a.equityUsd).toBe(75_010_000_000n);
    expect(a.freeCollateralUsd).toBe(74_000_000_000n);
    expect(a.position?.netExposureUsd).toBe(-1_900_000_000n);
    const fills = await v.fillsSince(1_000);
    expect(fills).toEqual([{ tradeId: "7", symbol: "PERP_NVDA_USDC", side: "sell", qty: 1.5, px: 190.2, feeUsd: 0.05, ts: 2_000, maker: true }]);
    expect(calls.at(-1)!.url).toContain("start_t=1000");
  });

  test("createOrderlyVenue prefers ops-venue's client, falls back only in mock mode", async () => {
    const injected: QuotingVenue = { kind: "orderly", replaceQuote: async () => {}, cancelAll: async () => {}, account: async () => ({ equityUsd: 0n, freeCollateralUsd: 0n, position: null }), fillsSince: async () => [] };
    const base = { ...opts, mode: "mock" as const, env: {} };
    expect(await createOrderlyVenue(base, silentLog, async () => () => injected)).toBe(injected);
    expect(await createOrderlyVenue(base, silentLog, async () => null)).toBeInstanceOf(MockOrderlyHttpVenue);
    await expect(createOrderlyVenue({ ...base, mode: "live" }, silentLog, async () => null)).rejects.toThrow("live");
  });

  test("mock taker posts {symbol, side, qty}", async () => {
    const calls: Call[] = [];
    const t = new MockOrderlyTaker("http://127.0.0.1:4420", fakeFetch({}, calls));
    await t.take("PERP_TSLA_USDC", "BUY", 0.5);
    expect(calls[0]).toEqual({ url: "http://127.0.0.1:4420/mock/taker", method: "POST", body: { symbol: "PERP_TSLA_USDC", side: "BUY", qty: 0.5 } });
  });
});
