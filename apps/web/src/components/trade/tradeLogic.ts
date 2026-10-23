// Trading page logic (pure; test/trade.test.ts): the order panel's size (USD or units, 18-decimal sizes), side and
// signed size, slippage, leverage, what the order does to the position, the session badge, the price age and the
// countdown of a carried price, client-side order checks (the API repeats every engine rule before it prepares
// anything), and the page's risk copy (checked against the copy rules).
import { parseAmount } from "../../lib/amount";
import type { TradeMarket, TradeSession } from "../../lib/api-types";
import type { Tone } from "../../lib/limits";

export const SIZE_DECIMALS = 18;
const SIZE_PRICE_TO_USD = 10n ** 30n;

export type Side = "buy" | "sell";
export type SizeUnit = "usd" | "units";

/** Default slippage (0.5 %) and the bounds the API accepts (0.01 % .. 5 %). */
export const DEFAULT_SLIPPAGE_BPS = 50;
export const MIN_SLIPPAGE_BPS = 1;
export const MAX_SLIPPAGE_BPS = 500;
export const SLIPPAGE_PRESETS_BPS = [10, 50, 100] as const;

/** "0.5" (percent) -> 50 bps; null when not a number in the accepted range (at most 2 decimals). */
export function parseSlippagePct(v: string): number | null {
  const t = v.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return bps >= MIN_SLIPPAGE_BPS && bps <= MAX_SLIPPAGE_BPS ? bps : null;
}

/** Decimal price string ("100.05") -> WAD; null when malformed or not positive. */
export function priceWadOf(price: string | null | undefined): bigint | null {
  if (!price) return null;
  const w = parseAmount(price, SIZE_DECIMALS);
  return w !== null && w > 0n ? w : null;
}

/**
 * Unsigned size in 1e18 units from the order input: units as typed (at most 18 decimals), or a USD amount
 * (at most 6 decimals) converted at `priceWad` and floored (the order never trades more than the amount typed).
 */
export function sizeFromInput(unit: SizeUnit, value: string, priceWad: bigint | null): bigint | null {
  if (unit === "units") {
    const raw = parseAmount(value, SIZE_DECIMALS);
    return raw !== null && raw > 0n ? raw : null;
  }
  const usd = parseAmount(value, 6);
  if (usd === null || usd <= 0n || !priceWad || priceWad <= 0n) return null;
  const size = (usd * SIZE_PRICE_TO_USD) / priceWad;
  return size > 0n ? size : null;
}

/** Signed size (buy positive, sell negative). */
export const signedSize = (side: Side, size: bigint): bigint => (side === "buy" ? size : -size);

/** |size| x price in USD (6 dp), floored. */
export const notionalRaw = (size: bigint, priceWad: bigint): bigint => ((size < 0n ? -size : size) * priceWad) / SIZE_PRICE_TO_USD;

/** 1e18 units -> "1.25" (at most `dp` decimals, trailing zeros trimmed). */
export function fmtUnits(raw: bigint | string | null | undefined, dp = 6): string {
  if (raw === null || raw === undefined) return "—";
  const v = typeof raw === "string" ? (/^-?\d+$/.test(raw) ? BigInt(raw) : null) : raw;
  if (v === null) return raw as string;
  const neg = v < 0n;
  const a = neg ? -v : v;
  const scale = 10n ** BigInt(SIZE_DECIMALS - dp);
  const r = (a + scale / 2n) / scale;
  const whole = r / 10n ** BigInt(dp);
  const frac = (r % 10n ** BigInt(dp)).toString().padStart(dp, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

/** Decimal unit string from the API ("-12.5") -> raw 1e18 bigint (null when malformed). */
export function unitsRaw(v: string | null | undefined): bigint | null {
  if (!v) return null;
  const neg = v.startsWith("-");
  const r = parseAmount(neg ? v.slice(1) : v, SIZE_DECIMALS);
  return r === null ? null : neg ? -r : r;
}

/** Decimal unit string from the API ("-12.5") -> "12.5" (absolute, at most 6 decimals). */
export function absUnitsText(v: string | null | undefined): string {
  const r = unitsRaw(v);
  return r === null ? "—" : fmtUnits(r < 0n ? -r : r);
}

/** PoolEngine isNewRisk: opens, increases or flips the position. */
export function isNewRisk(oldSize: bigint, newSize: bigint): boolean {
  if (newSize === 0n) return false;
  if (oldSize === 0n) return true;
  if (oldSize > 0n !== newSize > 0n) return true;
  return (newSize < 0n ? -newSize : newSize) > (oldSize < 0n ? -oldSize : oldSize);
}

/** The size a close of `portionBps` trades: -size (all) or -(size x portion / 1e4), as the API computes it. */
export function closeDelta(sizeRaw: string, portionBps: number): bigint {
  const size = BigInt(sizeRaw);
  return portionBps === 10_000 ? -size : -((size * BigInt(portionBps)) / 10_000n);
}

export type OrderEffect = "open" | "increase" | "reduce" | "close" | "flip";

export function orderEffect(oldSize: bigint, delta: bigint): OrderEffect {
  const next = oldSize + delta;
  if (oldSize === 0n) return "open";
  if (next === 0n) return "close";
  if (oldSize > 0n !== next > 0n) return "flip";
  return (next < 0n ? -next : next) > (oldSize < 0n ? -oldSize : oldSize) ? "increase" : "reduce";
}

export const EFFECT_LABEL: Record<OrderEffect, string> = {
  open: "Opens a position",
  increase: "Adds to your position",
  reduce: "Reduces your position",
  close: "Closes your position",
  flip: "Closes your position and opens the other side",
};

/** Leverage = notional / equity ("9.2x"); null when there is no exposure or no positive equity. */
export function leverageOf(notionalUsd: bigint, equityUsd: bigint): number | null {
  if (notionalUsd <= 0n || equityUsd <= 0n) return null;
  return Number((notionalUsd * 100n) / equityUsd) / 100;
}

export const fmtLeverage = (x: number | null | undefined): string => (x == null || !Number.isFinite(x) ? "—" : `${x >= 10 ? x.toFixed(1) : x.toFixed(2)}x`);

export const SESSION_BADGE: Record<TradeSession, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "good" },
  reduce_only: { label: "Reduce-only", tone: "warn" },
  split_close_only: { label: "Close-only (split pending)", tone: "warn" },
  off_hours: { label: "Off-hours", tone: "neutral" },
  split_window: { label: "Paused (split)", tone: "critical" },
  no_fresh_price: { label: "Waiting for a price", tone: "neutral" },
  closed: { label: "Closed", tone: "neutral" },
};

/** Price age in words, toned against the trade bound: fresh, ageing (within the last 3 s of it), too old to trade. */
export function priceAge(ageSeconds: number | null | undefined, maxAgeSeconds: number): { text: string; tone: Tone } {
  if (ageSeconds == null) return { text: "no price", tone: "neutral" };
  const text = ageSeconds < 2 ? "just now" : `${ageSeconds}s ago`;
  if (ageSeconds > maxAgeSeconds - 3) return { text, tone: "warn" };
  return { text, tone: "good" };
}

/** Seconds left to get a prepared trade mined (its carried price's bound), never negative. */
export function secondsLeft(tradableUntil: string | null | undefined, nowMs: number): number | null {
  if (!tradableUntil) return null;
  const t = Date.parse(tradableUntil);
  return Number.isNaN(t) ? null : Math.max(0, Math.ceil((t - nowMs) / 1000));
}

export type OrderIssue = "no_size" | "market_closed" | "new_risk_blocked" | "above_room";

/**
 * Client-side check of an order before asking the API (which checks every engine rule again): a size, a market
 * that trades, new risk allowed, and an open / increase within the room left on its side (`notionalUsd` at the price).
 */
export function orderIssue(m: Pick<TradeMarket, "canTrade" | "newRisk" | "caps">, positionSize: bigint, delta: bigint | null, notionalUsd?: bigint): OrderIssue | null {
  if (delta === null || delta === 0n) return "no_size";
  if (!m.canTrade) return "market_closed";
  const effect = orderEffect(positionSize, delta);
  if (isNewRisk(positionSize, positionSize + delta) && !m.newRisk) return "new_risk_blocked";
  if ((effect === "open" || effect === "increase") && notionalUsd !== undefined) {
    const room = parseAmount(delta > 0n ? m.caps.buyRoomUsd : m.caps.sellRoomUsd, 6);
    if (room !== null && notionalUsd > room) return "above_room";
  }
  return null;
}

export function orderIssueText(issue: OrderIssue | null, m: Pick<TradeMarket, "reasons">): string | null {
  switch (issue) {
    case "market_closed":
    case "new_risk_blocked":
      return m.reasons[0] ?? "Trading is limited right now.";
    case "above_room":
      return "Above the room the market has left for this side.";
    default:
      return null;
  }
}

/** Plain risk copy of the page (every line passes the copy rules; test/trade.test.ts). */
export function tradeRiskLines(m: Pick<TradeMarket, "margin" | "tradePriceMaxAgeSeconds"> | null): Array<{ title: string; body: string }> {
  const im = m?.margin.initialMarginBps ?? 1000;
  const mm = m?.margin.maintenanceMarginBps ?? 500;
  const oh = m?.margin.offHoursMarginBps ?? Math.min(2 * im, 10_000);
  const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 1 : 0)}%`;
  return [
    {
      title: "This is a perpetual future, not the stock",
      body: "You hold a contract that follows the stock's price, with no expiry and no shares delivered. Funding is paid between the crowded side and the pool while the position is open.",
    },
    {
      title: "Leverage cuts both ways",
      body: `The maximum is ${(10_000 / im).toFixed(0)}x (initial margin ${pct(im)} of notional). A move against you of 1% costs about as many percent of your margin as your leverage.`,
    },
    {
      title: "Liquidation can take all of your margin",
      body: `Below the maintenance margin (${pct(mm)} of notional) anyone may close your whole position at the oracle price; a liquidation fee comes out of what is left. Margin is isolated: only this market's margin is at stake, and you can lose all of it.`,
    },
    {
      title: "Off-hours: no trading, a stricter requirement",
      body: `While the stock's session is closed no trade fills, closes included, and the requirement rises to ${pct(oh)} of notional (2x initial margin). A position above ${(10_000 / oh).toFixed(1).replace(/\.0$/, "")}x is liquidated at the closing price. Top up or reduce before the close; top-ups work off-hours.`,
    },
    {
      title: "Each trade carries its own signed price",
      body: `The order is filled at the oracle price it carries, which must be at most ${m?.tradePriceMaxAgeSeconds ?? 15} s old when mined, with a spread and a fee. A slippage limit bounds the fill; an expired price only costs gas.`,
    },
    {
      title: "A guarded launch",
      body: "The first in-house markets open with a small inventory cap and an insurance fund that absorbs bad debt first. Caps can stop new orders, a stock split makes a market close-only, and the market can be set to reduce-only. This is new software on a new chain.",
    },
  ];
}

