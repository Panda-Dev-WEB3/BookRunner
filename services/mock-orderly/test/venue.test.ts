import { describe, expect, test } from "bun:test";
import { builderShareMicro, settlementPeriodOf } from "../src/fees";
import { buyProbability, DEFAULT_FLOW, sampleArrivals } from "../src/flow";
import { mulberry32 } from "../src/rng";
import { MockVenue, VenueError } from "../src/venue";

const IF = `0x${"11".repeat(32)}`;
const MM = `0x${"22".repeat(32)}`;
const MM2 = `0x${"23".repeat(32)}`;
const BUILDER = `0x${"33".repeat(32)}`;
const SYM = "PERP_NVDA_USDC";

function setup(over: ConstructorParameters<typeof MockVenue>[0] = {}) {
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const v = new MockVenue({ settleIntervalSec: 300, ...over } as never, clock.now);
  v.createSymbol({ symbol: SYM, ifAccountId: IF, builderAccountId: BUILDER });
  v.credit(IF, 25_000_000_000);
  v.credit(MM, 75_000_000_000);
  v.setPrice("NVDA", 190, false);
  return { v, clock };
}

const ctx = { accountId: MM, keyId: null };

describe("orders and fills", () => {
  test("taker flow fills only at the book's quoted prices; positions and fees follow", () => {
    const { v } = setup();
    v.placeOrder(ctx, { symbol: SYM, order_type: "LIMIT", side: "BUY", order_price: 189.9, order_quantity: 10, client_order_id: "b1" });
    v.placeOrder(ctx, { symbol: SYM, order_type: "LIMIT", side: "SELL", order_price: 190.1, order_quantity: 10, client_order_id: "a1" });
    const buys = v.externalTaker(SYM, "BUY", 4);
    expect(buys.map((f) => f.price)).toEqual([190.1]);
    const sells = v.externalTaker(SYM, "SELL", 15); // only 10 resting on the bid
    expect(sells.map((f) => [f.price, f.qty])).toEqual([[189.9, 10]]);
    const pos = v.positionsView(MM).rows[0];
    expect(pos?.position_qty).toBe(6);
    // maker fee 0 -> holding only moved by realized pnl of the 4 closed units: 4 * (190.1 - 189.9) = 0.8
    const realized = 4 * (190.1 - 189.9);
    expect(v.getAccount(MM).holding).toBe(75_000_000_000 + Math.round(realized * 1e6));
    const trades = v.tradesView(MM, { symbol: SYM }).rows;
    expect(trades.every((t) => t.is_maker === 1)).toBe(true);
    expect(new Set(trades.map((t) => t.executed_price))).toEqual(new Set([190.1, 189.9]));
  });

  test("POST_ONLY that would cross is rejected; self-trade is rejected", () => {
    const { v } = setup();
    v.credit(MM2, 10_000_000_000);
    v.placeOrder({ accountId: MM2, keyId: null }, { symbol: SYM, order_type: "LIMIT", side: "SELL", order_price: 190, order_quantity: 1 });
    expect(() => v.placeOrder(ctx, { symbol: SYM, order_type: "POST_ONLY", side: "BUY", order_price: 190, order_quantity: 1 })).toThrow(VenueError);
    v.placeOrder(ctx, { symbol: SYM, order_type: "LIMIT", side: "SELL", order_price: 191, order_quantity: 1 });
    expect(() => v.placeOrder(ctx, { symbol: SYM, order_type: "LIMIT", side: "BUY", order_price: 191.5, order_quantity: 1 })).toThrow(/self-trade/);
  });

  test("reduce-only orders cannot increase the position", () => {
    const { v } = setup();
    expect(() => v.placeOrder(ctx, { symbol: SYM, order_type: "LIMIT", side: "SELL", order_price: 191, order_quantity: 1, reduce_only: true })).toThrow(/increase/);
  });

  test("margin check rejects orders beyond equity", () => {
    const { v } = setup();
    expect(() => v.placeOrder(ctx, { symbol: SYM, order_type: "LIMIT", side: "BUY", order_price: 190, order_quantity: 100_000 })).toThrow(/margin/);
  });

  test("tick enforcement (PRICE_FILTER / SIZE_FILTER) when enabled", () => {
    const { v } = setup({ enforceTicks: true, quoteTick: 0.01, baseTick: 0.001 } as never);
    expect(() => v.placeOrder(ctx, { symbol: SYM, order_type: "LIMIT", side: "BUY", order_price: 189.005, order_quantity: 1 })).toThrow(/quote_tick/);
    expect(() => v.placeOrder(ctx, { symbol: SYM, order_type: "LIMIT", side: "BUY", order_price: 189.01, order_quantity: 1.0005 })).toThrow(/base_tick/);
    expect(v.placeOrder(ctx, { symbol: SYM, order_type: "LIMIT", side: "BUY", order_price: 189.01, order_quantity: 1.001 }).status).toBe("NEW");
    expect(v.infoView(SYM)).toMatchObject({ quote_tick: 0.01, base_tick: 0.001 });
  });

  test("cancelAll and duplicate client ids", () => {
    const { v } = setup();
    v.placeOrder(ctx, { symbol: SYM, order_type: "LIMIT", side: "BUY", order_price: 189, order_quantity: 1, client_order_id: "x" });
    expect(() => v.placeOrder(ctx, { symbol: SYM, order_type: "LIMIT", side: "BUY", order_price: 188, order_quantity: 1, client_order_id: "x" })).toThrow(/duplicate/);
    expect(v.cancelAll(MM, SYM)).toBe(1);
    expect(v.externalTaker(SYM, "SELL", 1)).toHaveLength(0);
  });

  test("symbol is PENDING until the IF balance is strictly greater than the requirement", () => {
    const v = new MockVenue({ ifRequirementUsd: 25_000 } as never);
    v.createSymbol({ symbol: SYM, ifAccountId: IF });
    v.credit(IF, 25_000_000_000);
    expect(v.symbolStatus(v.requireSymbol(SYM))).toBe("PENDING");
    v.credit(IF, 1);
    expect(v.symbolStatus(v.requireSymbol(SYM))).toBe("ACTIVE");
  });
});

describe("builder fee share", () => {
  test("50% of base taker fees only — maker fees, liquidation fees and funding excluded", () => {
    expect(builderShareMicro("taker", 1_000_001, 5000)).toBe(500_000);
    expect(builderShareMicro("maker", 1_000_000, 5000)).toBe(0);
    expect(builderShareMicro("liquidation", 1_000_000, 5000)).toBe(0);
    expect(builderShareMicro("funding", 1_000_000, 5000)).toBe(0);

    const { v } = setup({ fees: { takerFeeBps: 6, makerFeeBps: 2, builderShareBps: 5000, liquidationFeeBps: 100, liquidationIfShareBps: 5000 }, fundingRateBps: 10, fundingIntervalSec: 60 } as never);
    v.placeOrder(ctx, { symbol: SYM, order_type: "LIMIT", side: "SELL", order_price: 200, order_quantity: 50 });
    v.externalTaker(SYM, "BUY", 50); // notional 10,000 -> taker fee 6.00, maker fee 2.00
    const s = v.requireSymbol(SYM);
    expect(s.stats.takerFees).toBe(6_000_000);
    expect(s.stats.makerFees).toBe(2_000_000);
    expect(s.stats.builderAccrued).toBe(3_000_000);
    // funding + liquidation do not move the builder share
    v.fundingTick(1_700_000_100);
    v.fundingTick(1_700_000_200);
    v.setPrice("NVDA", 3000, false); // short 50 deep under water -> liquidation
    expect(s.stats.liquidationFees).toBeGreaterThan(0);
    expect(s.stats.builderAccrued).toBe(3_000_000);
  });

  test("settlement per period is idempotent and credits the builder exactly once", () => {
    const { v, clock } = setup();
    v.placeOrder(ctx, { symbol: SYM, order_type: "LIMIT", side: "SELL", order_price: 200, order_quantity: 50 });
    v.externalTaker(SYM, "BUY", 50);
    const nowSec = Math.floor(clock.now() / 1000);
    const period = settlementPeriodOf(nowSec, 300);
    expect(v.settleDue(nowSec)).toHaveLength(0); // bucket not complete yet
    clock.advance((period - nowSec) * 1000);
    const rows = v.settleDue();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.period).toBe(period);
    expect(rows[0]?.amount).toBe(3_000_000);
    expect(v.settleDue()).toHaveLength(0);
    expect(v.settleNow()).toHaveLength(0);
    expect(v.getAccount(BUILDER).holding).toBe(3_000_000);
  });
});

describe("withdrawals and keys", () => {
  test("withdraw debits immediately, is idempotent per client ref, completes once", () => {
    const { v } = setup();
    const w = v.requestWithdraw(MM, { amountMicro: 1_000_000_000, receiver: "0xabc", token: "USDC", chainId: 31337, withdrawNonce: 1, clientRef: "n-1" });
    expect(v.getAccount(MM).holding).toBe(74_000_000_000);
    expect(v.requestWithdraw(MM, { amountMicro: 1_000_000_000, receiver: "0xabc", token: "USDC", chainId: 31337, withdrawNonce: 2, clientRef: "n-1" }).id).toBe(w.id);
    v.completeWithdraw(w.id, "0xtx");
    expect(v.completeWithdraw(w.id, "0xother").txHash).toBe("0xtx");
    expect(() => v.requestWithdraw(MM, { amountMicro: 80_000_000_000, receiver: "0xabc", token: "USDC", chainId: 31337, withdrawNonce: 3 })).toThrow(/exceeds/);
  });

  test("IF lock keeps the balance above the requirement while the symbol is effective", () => {
    const { v } = setup({ ifRequirementUsd: 100 } as never);
    expect(v.withdrawableMicro(v.getAccount(IF))).toBe(25_000_000_000 - 100_000_000 - 1);
    v.setSymbolStatus(SYM, "DELISTED");
    expect(v.withdrawableMicro(v.getAccount(IF))).toBe(25_000_000_000);
  });

  test("removing a key cancels its orders", () => {
    const { v } = setup();
    v.registerKey(MM, "ed25519:k1", ["read", "trading"], Date.now() + 1e9);
    v.placeOrder({ accountId: MM, keyId: "ed25519:k1" }, { symbol: SYM, order_type: "LIMIT", side: "BUY", order_price: 189, order_quantity: 1 });
    expect(v.removeKey(MM, "ed25519:k1")).toEqual({ removed: true, cancelled: 1 });
    expect(v.removeKey(MM, "ed25519:k1")).toEqual({ removed: false, cancelled: 0 });
  });

  test("snapshot round-trip", () => {
    const { v } = setup();
    v.placeOrder(ctx, { symbol: SYM, order_type: "LIMIT", side: "SELL", order_price: 200, order_quantity: 1 });
    const snap = JSON.parse(JSON.stringify(v.toSnapshot()));
    const w = new MockVenue();
    w.loadSnapshot(snap);
    expect(w.getAccount(MM).holding).toBe(v.getAccount(MM).holding);
    expect(w.openOrders(MM)).toHaveLength(1);
  });
});

describe("taker flow", () => {
  test("side bias responds to price moves and quote value", () => {
    expect(buyProbability({ price: 100, emaPrice: 100, held: false, bestBid: 99.9, bestAsk: 100.1 }, DEFAULT_FLOW)).toBeCloseTo(0.5, 6);
    expect(buyProbability({ price: 101, emaPrice: 100, held: false }, DEFAULT_FLOW)).toBeGreaterThan(0.5);
    expect(buyProbability({ price: 99, emaPrice: 100, held: false }, DEFAULT_FLOW)).toBeLessThan(0.5);
    expect(buyProbability({ price: 100, emaPrice: 100, held: false, bestBid: 98, bestAsk: 99 }, DEFAULT_FLOW)).toBeGreaterThan(0.5);
  });

  test("Poisson arrivals average the configured rate; none while held", () => {
    const rng = mulberry32(42);
    let n = 0;
    for (let i = 0; i < 3000; i++) n += sampleArrivals(rng, { price: 100, emaPrice: 100, held: false }, { ...DEFAULT_FLOW, ratePerMin: 60 }, 1).length;
    expect(n / 3000).toBeGreaterThan(0.9);
    expect(n / 3000).toBeLessThan(1.1);
    expect(sampleArrivals(rng, { price: 100, emaPrice: 100, held: true }, { ...DEFAULT_FLOW, ratePerMin: 600 }, 10)).toHaveLength(0);
  });

  test("tick produces fills at quoted prices", () => {
    const { v } = setup({ flow: { ...DEFAULT_FLOW, ratePerMin: 600, maxSlippageBps: 50 } } as never);
    v.placeOrder(ctx, { symbol: SYM, order_type: "LIMIT", side: "BUY", order_price: 189.95, order_quantity: 100 });
    v.placeOrder(ctx, { symbol: SYM, order_type: "LIMIT", side: "SELL", order_price: 190.05, order_quantity: 100 });
    const fills = v.tick(10, mulberry32(7));
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) expect([189.95, 190.05]).toContain(f.price);
  });
});
