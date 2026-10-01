import { describe, expect, test } from "bun:test";
import { applyTrade, matchTaker, type RestingOrder, reducibleQty, wouldCross } from "../src/matching";

const ord = (orderId: number, side: "BUY" | "SELL", price: number, qty: number, createdAt = orderId): RestingOrder => ({ orderId, accountId: "a", side, price, qty, createdAt });

describe("matchTaker", () => {
  test("taker BUY lifts asks in price-time priority at the resting prices only", () => {
    const book = [ord(1, "SELL", 101, 1), ord(2, "SELL", 100.5, 0.5), ord(3, "SELL", 100.5, 2, 0), ord(4, "BUY", 99, 5)];
    const r = matchTaker(book, "BUY", 3);
    expect(r.fills).toEqual([
      { orderId: 3, accountId: "a", price: 100.5, qty: 2 },
      { orderId: 2, accountId: "a", price: 100.5, qty: 0.5 },
      { orderId: 1, accountId: "a", price: 101, qty: 0.5 },
    ]);
    expect(r.remaining).toBe(0);
    for (const f of r.fills) expect(book.find((o) => o.orderId === f.orderId)?.price).toBe(f.price);
  });

  test("taker SELL hits bids, respects the limit and leaves the rest unfilled", () => {
    const book = [ord(1, "BUY", 99, 1), ord(2, "BUY", 98, 1), ord(3, "SELL", 100, 1)];
    const r = matchTaker(book, "SELL", 5, 98.5);
    expect(r.fills).toEqual([{ orderId: 1, accountId: "a", price: 99, qty: 1 }]);
    expect(r.remaining).toBe(4);
  });

  test("no fills when the taker limit does not reach the quote", () => {
    expect(matchTaker([ord(1, "SELL", 100, 1)], "BUY", 1, 99.99).fills).toHaveLength(0);
  });

  test("caps (reduce-only makers) limit fill size", () => {
    const r = matchTaker([ord(1, "SELL", 100, 5)], "BUY", 5, undefined, () => 2);
    expect(r.fills[0]?.qty).toBe(2);
    expect(r.remaining).toBe(3);
  });

  test("wouldCross", () => {
    const book = [ord(1, "SELL", 100, 1), ord(2, "BUY", 99, 1)];
    expect(wouldCross(book, "BUY", 100)).toBe(true);
    expect(wouldCross(book, "BUY", 99.9)).toBe(false);
    expect(wouldCross(book, "SELL", 99)).toBe(true);
  });
});

describe("applyTrade", () => {
  test("open, add, reduce with realized pnl, flip", () => {
    let p = applyTrade({ qty: 0, avgOpenPx: 0 }, "BUY", 2, 100);
    expect(p).toEqual({ qty: 2, avgOpenPx: 100, realizedPnl: 0 });
    p = applyTrade(p, "BUY", 2, 110);
    expect(p.qty).toBe(4);
    expect(p.avgOpenPx).toBe(105);
    p = applyTrade(p, "SELL", 1, 115);
    expect(p.realizedPnl).toBeCloseTo(10, 9);
    expect(p.qty).toBe(3);
    expect(p.avgOpenPx).toBe(105);
    p = applyTrade(p, "SELL", 5, 100);
    expect(p.realizedPnl).toBeCloseTo(-15, 9);
    expect(p.qty).toBe(-2);
    expect(p.avgOpenPx).toBe(100);
    p = applyTrade(p, "BUY", 2, 90);
    expect(p.realizedPnl).toBeCloseTo(20, 9);
    expect(p.qty).toBe(0);
  });

  test("reducibleQty", () => {
    expect(reducibleQty(3, "SELL")).toBe(3);
    expect(reducibleQty(3, "BUY")).toBe(0);
    expect(reducibleQty(-2, "BUY")).toBe(2);
  });
});
