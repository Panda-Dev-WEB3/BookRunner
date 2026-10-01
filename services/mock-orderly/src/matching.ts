// Pure matching + position math for the simulator. Fills happen ONLY at resting (quoted) prices.
import type { Side } from "@bookrunner/shared";

export interface RestingOrder {
  orderId: number;
  accountId: string;
  side: Side; // resting side
  price: number;
  qty: number; // remaining, units of underlying
  createdAt: number;
}

export interface MatchFill {
  orderId: number;
  accountId: string;
  price: number; // == the resting order's price
  qty: number;
}

export interface MatchResult {
  fills: MatchFill[];
  remaining: number;
}

export const QTY_DP = 8; // Orderly: order_quantity precision within 8 digits
export const roundQty = (q: number): number => Math.round(q * 1e8) / 1e8;

/** Price-time priority: asks ascending, bids descending; ties by createdAt then orderId. */
export function sortForTaker(orders: RestingOrder[], takerSide: Side): RestingOrder[] {
  const restingSide: Side = takerSide === "BUY" ? "SELL" : "BUY";
  return orders
    .filter((o) => o.side === restingSide && o.qty > 0)
    .sort((a, b) => {
      if (a.price !== b.price) return takerSide === "BUY" ? a.price - b.price : b.price - a.price;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.orderId - b.orderId;
    });
}

/**
 * A taker of `qty` on `takerSide` sweeps resting orders of the opposite side in price-time priority,
 * never beyond `limitPx` (BUY: price <= limit, SELL: price >= limit). Each fill is at the resting price.
 * `capOf` optionally caps an order's fillable quantity (reduce-only makers); default = remaining qty.
 */
export function matchTaker(
  orders: RestingOrder[],
  takerSide: Side,
  qty: number,
  limitPx?: number,
  capOf: (o: RestingOrder) => number = (o) => o.qty,
): MatchResult {
  let remaining = roundQty(qty);
  const fills: MatchFill[] = [];
  for (const o of sortForTaker(orders, takerSide)) {
    if (remaining <= 0) break;
    if (limitPx !== undefined) {
      if (takerSide === "BUY" && o.price > limitPx) break;
      if (takerSide === "SELL" && o.price < limitPx) break;
    }
    const avail = roundQty(Math.min(o.qty, Math.max(0, capOf(o))));
    if (avail <= 0) continue;
    const q = roundQty(Math.min(avail, remaining));
    if (q <= 0) continue;
    fills.push({ orderId: o.orderId, accountId: o.accountId, price: o.price, qty: q });
    remaining = roundQty(remaining - q);
  }
  return { fills, remaining };
}

/** True if an incoming order at `price` on `side` would cross any of `orders` (opposite side). */
export function wouldCross(orders: RestingOrder[], side: Side, price: number): boolean {
  return orders.some((o) => o.qty > 0 && o.side !== side && (side === "BUY" ? o.price <= price : o.price >= price));
}

export interface PositionCore {
  qty: number; // signed units
  avgOpenPx: number;
}

export interface TradeEffect extends PositionCore {
  realizedPnl: number; // USD (float)
}

/** Apply a trade of `qty` (> 0) on `side` at `px` to a position (average-cost, realized on reduce). */
export function applyTrade(pos: PositionCore, side: Side, qty: number, px: number): TradeEffect {
  const signed = side === "BUY" ? qty : -qty;
  const cur = pos.qty;
  if (cur === 0 || Math.sign(cur) === Math.sign(signed)) {
    const newQty = roundQty(cur + signed);
    const avg = (Math.abs(cur) * pos.avgOpenPx + qty * px) / Math.abs(newQty);
    return { qty: newQty, avgOpenPx: avg, realizedPnl: 0 };
  }
  const closing = Math.min(Math.abs(signed), Math.abs(cur));
  const realizedPnl = closing * (px - pos.avgOpenPx) * Math.sign(cur);
  const newQty = roundQty(cur + signed);
  if (newQty === 0) return { qty: 0, avgOpenPx: 0, realizedPnl };
  if (Math.sign(newQty) !== Math.sign(cur)) return { qty: newQty, avgOpenPx: px, realizedPnl }; // flipped
  return { qty: newQty, avgOpenPx: pos.avgOpenPx, realizedPnl };
}

/** Quantity a reduce-only order on `side` may still fill given the position. */
export function reducibleQty(posQty: number, side: Side): number {
  if (side === "SELL") return Math.max(0, posQty);
  return Math.max(0, -posQty);
}
