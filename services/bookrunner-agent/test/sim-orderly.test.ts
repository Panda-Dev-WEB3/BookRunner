import { describe, expect, test } from "bun:test";
import type { QuotingVenue } from "@bookrunner/shared";
import { mulberry32 } from "../src/domain/rng";
import { MockOrderlyTaker } from "../src/sim/orderly-taker";
import {
  CLOSE_ONLY_CLASSES,
  PAUSE_CLASSES,
  acceptablePriceWad,
  classifyTradeError,
  engineGate,
  holdableLeverage,
  liquidationMarginBps,
  nearLiquidation,
  nextAction,
  nextDelayMs,
  offHoursMarginBps,
  sizeDeltaFor,
} from "../src/sim/trader-logic";
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
    // held / stale engine price: PoolEngine fills no trade (closes included) -> pause, not close-only
    expect(CLOSE_ONLY_CLASSES).not.toContain("off_hours");
    expect(PAUSE_CLASSES).toContain("off_hours");
    expect(CLOSE_ONLY_CLASSES).toContain("reduce_only");
  });

  test("engine gate: held / stale price freezes every trade (audit A2-01 / A2-03), reduce-only only closes", () => {
    const g = { reduceOnly: false, oracleHeld: false, oracleStale: false, poolExposureUsd: 0, maxNetExposureUsd: 50_000 };
    expect(engineGate(g)).toEqual({ closeOnly: false, frozen: false });
    expect(engineGate({ ...g, oracleHeld: true })).toEqual({ closeOnly: false, frozen: true });
    expect(engineGate({ ...g, oracleStale: true })).toEqual({ closeOnly: false, frozen: true });
    expect(engineGate({ ...g, reduceOnly: true })).toEqual({ closeOnly: true, frozen: false });
    const rng = mulberry32(3);
    for (let i = 0; i < 50; i++) {
      // a frozen trader neither opens nor closes, whatever its position / mode
      expect(nextAction(rng, { positionUsd: 1_000, marginUsd: 10_000, closeOnly: true, frozen: true }, params)).toEqual({ kind: "none", reason: "PRICE_NOT_LIVE" });
      expect(nextAction(rng, { positionUsd: -1_000, marginUsd: 10_000, closeOnly: false, frozen: true }, params).kind).toBe("none");
    }
  });

  test("off-hours margin (audit A2-02): 2x initial margin while held; sim leverage survives a session close", () => {
    expect(offHoursMarginBps(1_000)).toBe(2_000);
    expect(offHoursMarginBps(6_000)).toBe(10_000); // capped at 100 %
    const m = { initialMarginBps: 1_000, maintenanceMarginBps: 500 };
    expect(liquidationMarginBps(m, false)).toBe(500);
    expect(liquidationMarginBps(m, true)).toBe(2_000);
    expect(holdableLeverage(5, 1_000)).toBeCloseTo(4); // 0.8 / 20 %
    expect(holdableLeverage(3, 1_000)).toBe(3);
    // 4x on 20 % off-hours: ~25 % equity, not a sweep candidate even with the 20 % buffer (24 %)
    const UNIT = 10n ** 18n;
    const px = 100n * UNIT;
    const size = 400n * UNIT; // $40k on $10k margin
    const pos = { size, entryPriceWad: px, marginUsd: 10_000_000_000n };
    expect(nearLiquidation(pos, px, liquidationMarginBps(m, true))).toBe(false);
    // 5x is (live: fine; held: a candidate)
    const pos5 = { size: 500n * UNIT, entryPriceWad: px, marginUsd: 10_000_000_000n };
    expect(nearLiquidation(pos5, px, liquidationMarginBps(m, false))).toBe(false);
    expect(nearLiquidation(pos5, px, liquidationMarginBps(m, true))).toBe(true);
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
