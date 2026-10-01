// Simulated taker behaviour (pure, seeded): Poisson arrivals, log-uniform notional, mild mean
// reversion of each trader's own position, occasional closes, leverage cap, and close-only mode
// after the venue reports reduce-only / off-hours.

import { type Rng, exponential, logUniform } from "../domain/rng";

export interface SimParams {
  minNotionalUsd: number;
  maxNotionalUsd: number;
  closeProb: number;
  maxLeverage: number;
  slippageBps: number;
}

export type TraderAction =
  | { kind: "open"; side: "buy" | "sell"; notionalUsd: number }
  | { kind: "close" }
  | { kind: "none"; reason: string };

export interface TraderView {
  /** Signed position notional at the current price (trader perspective). */
  positionUsd: number;
  marginUsd: number;
  /** Venue rejects new risk (off-hours / reduce-only), observed or recently reported. */
  closeOnly: boolean;
  /** Only this side is accepted (pool exposure at its cap: trade the side that reduces it). */
  forceSide?: "buy" | "sell";
}

export interface EngineGateInput {
  reduceOnly: boolean;
  oracleHeld: boolean;
  oracleStale: boolean;
  /** Pool exposure (positive = pool long), USD. */
  poolExposureUsd: number;
  maxNetExposureUsd: number;
}

/**
 * Pre-trade view of the in-house engine's rules (independent of revert decoding): new risk is
 * blocked while reduce-only / held / stale; near the pool exposure cap only the side that reduces
 * pool exposure is traded (a trader buy makes the pool shorter).
 */
export function engineGate(g: EngineGateInput, capFrac = 0.9): Pick<TraderView, "closeOnly" | "forceSide"> {
  const closeOnly = g.reduceOnly || g.oracleHeld || g.oracleStale;
  if (g.maxNetExposureUsd <= 0) return { closeOnly: true };
  if (Math.abs(g.poolExposureUsd) >= g.maxNetExposureUsd * capFrac && g.poolExposureUsd !== 0) {
    return { closeOnly, forceSide: g.poolExposureUsd > 0 ? "buy" : "sell" };
  }
  return { closeOnly };
}

export function nextAction(rng: Rng, v: TraderView, p: SimParams): TraderAction {
  const hasPos = Math.abs(v.positionUsd) > 1e-6;
  if (v.closeOnly) return hasPos ? { kind: "close" } : { kind: "none", reason: "CLOSE_ONLY_FLAT" };
  if (hasPos && rng.next() < p.closeProb) return { kind: "close" };

  // mean reversion: a long trader is more likely to sell, a short trader to buy
  const tilt = hasPos ? Math.sign(v.positionUsd) * 0.2 : 0;
  const side: "buy" | "sell" = v.forceSide ?? (rng.next() < 0.5 - tilt ? "buy" : "sell");
  let notional = logUniform(rng, Math.max(1, p.minNotionalUsd), Math.max(p.minNotionalUsd + 1, p.maxNotionalUsd));

  // leverage cap on the post-trade position
  const capUsd = Math.max(0, v.marginUsd * p.maxLeverage);
  const signed = side === "buy" ? notional : -notional;
  const after = v.positionUsd + signed;
  if (Math.abs(after) > capUsd) {
    const room = side === "buy" ? capUsd - v.positionUsd : capUsd + v.positionUsd;
    if (room < p.minNotionalUsd) return hasPos ? { kind: "close" } : { kind: "none", reason: "NO_MARGIN" };
    notional = room;
  }
  return { kind: "open", side, notionalUsd: notional };
}

/** Delay until this book's next taker arrival (ms). */
export function nextDelayMs(rng: Rng, tradesPerMin: number): number {
  const ms = exponential(rng, Math.max(1e-6, tradesPerMin) / 60_000);
  return Math.min(10 * 60_000, Math.max(250, ms));
}

/** Engine size delta (1e18 = 1 unit) for a notional at a price, signed by side. */
export function sizeDeltaFor(notionalUsd: number, priceUsd: number, side: "buy" | "sell"): bigint {
  if (!(priceUsd > 0) || !(notionalUsd > 0)) return 0n;
  const micro = BigInt(Math.floor((notionalUsd / priceUsd) * 1e6)); // 1e-6 unit precision
  const size = micro * 10n ** 12n;
  return side === "buy" ? size : -size;
}

/** Worst acceptable fill: buys may pay up to +slippage, sells accept down to -slippage. */
export function acceptablePriceWad(quotePriceWad: bigint, sizeDelta: bigint, slippageBps: number): bigint {
  const slip = BigInt(Math.max(0, Math.round(slippageBps)));
  return sizeDelta > 0n ? (quotePriceWad * (10_000n + slip)) / 10_000n : (quotePriceWad * (10_000n - slip)) / 10_000n;
}

export type TradeErrorClass = "off_hours" | "reduce_only" | "exposure_cap" | "margin" | "price" | "not_live" | "other";

/** Classify a venue rejection (custom error name and/or message) so the sim can back off sensibly. */
export function classifyTradeError(name: string | null, message: string): TradeErrorClass {
  const s = `${name ?? ""} ${message}`.toLowerCase();
  if (/stale|held|offhours|off_hours|off-hours|session/.test(s)) return "off_hours";
  if (/reduceonly|reduce_only|reduce-only|newrisk/.test(s)) return "reduce_only";
  if (/exposure|maxnet|inventory|capacity/.test(s)) return "exposure_cap";
  if (/margin|collateral|insufficient/.test(s)) return "margin";
  if (/price|slippage|acceptable/.test(s)) return "price";
  if (/not live|notlive|market|state/.test(s)) return "not_live";
  return "other";
}

/** Rejections after which the sim only closes positions for a while (exposure caps flip side instead). */
export const CLOSE_ONLY_CLASSES: readonly TradeErrorClass[] = ["off_hours", "reduce_only"];
