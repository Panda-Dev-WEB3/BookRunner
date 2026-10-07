// Simulated taker behaviour (pure, seeded): Poisson arrivals, log-uniform notional, mild mean
// reversion of each trader's own position, occasional closes, leverage cap, close-only mode after the
// venue reports reduce-only, and no trading at all while the engine's price is not live (held / stale:
// PoolEngine fills no trade then, closes included — audit A2-01 / A2-03).

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
  /** Venue rejects new risk (reduce-only / off-hours on a venue that still takes closes), observed or recently reported. */
  closeOnly: boolean;
  /** Venue fills no trade at all, closes included (in-house engine: held / stale price). */
  frozen?: boolean;
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
 * Pre-trade view of the in-house engine's rules (independent of revert decoding): no trade at all while
 * the price is held / stale (frozen), new risk blocked while reduce-only; near the pool exposure cap
 * only the side that reduces pool exposure is traded (a trader buy makes the pool shorter).
 */
export function engineGate(g: EngineGateInput, capFrac = 0.9): Pick<TraderView, "closeOnly" | "frozen" | "forceSide"> {
  const frozen = g.oracleHeld || g.oracleStale;
  const closeOnly = g.reduceOnly;
  if (g.maxNetExposureUsd <= 0) return { closeOnly: true, frozen };
  if (Math.abs(g.poolExposureUsd) >= g.maxNetExposureUsd * capFrac && g.poolExposureUsd !== 0) {
    return { closeOnly, frozen, forceSide: g.poolExposureUsd > 0 ? "buy" : "sell" };
  }
  return { closeOnly, frozen };
}

/** PoolEngine.OFF_HOURS_MARGIN_MULTIPLE: while held, maintenance = 2x initial margin (capped at 100 %). */
export const OFF_HOURS_MARGIN_MULTIPLE = 2;

/** Maintenance requirement (bps of notional) the engine applies off-hours (oracle held), audit A2-02. */
export function offHoursMarginBps(initialMarginBps: number): number {
  return Math.min(10_000, OFF_HOURS_MARGIN_MULTIPLE * Math.max(0, Math.round(initialMarginBps)));
}

/** Requirement a liquidation is checked against at `held`: off-hours requirement, else maintenance. */
export function liquidationMarginBps(m: { initialMarginBps: number; maintenanceMarginBps: number }, held: boolean): number {
  return held ? offHoursMarginBps(m.initialMarginBps) : m.maintenanceMarginBps;
}

/**
 * Leverage the sim may run so its positions survive a session close (off-hours requirement, with
 * `headroom` for adverse moves and fees): min(maxLeverage, headroom / offHoursMargin).
 */
export function holdableLeverage(maxLeverage: number, initialMarginBps: number, headroom = 0.8): number {
  const bps = offHoursMarginBps(initialMarginBps);
  if (bps <= 0) return maxLeverage;
  return Math.min(maxLeverage, (headroom * 10_000) / bps);
}

export function nextAction(rng: Rng, v: TraderView, p: SimParams): TraderAction {
  const hasPos = Math.abs(v.positionUsd) > 1e-6;
  if (v.frozen) return { kind: "none", reason: "PRICE_NOT_LIVE" };
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

/**
 * PoolEngine._fillPrice at an oracle price the chain has not stored yet (pull mode: the trade carries it):
 * buy = ceil(p * (2e4 + spread + 2*skew) / 2e4), sell = floor(p * (2e4 - spread + 2*skew) / 2e4).
 */
export function engineFillPriceWad(priceWad: bigint, spreadBps: number, skewBps: number, sizeDelta: bigint): bigint {
  const den = 20_000n;
  const spread = BigInt(Math.max(0, Math.round(spreadBps)));
  const skew2 = 2n * BigInt(Math.round(skewBps));
  if (sizeDelta > 0n) {
    const f = den + spread + skew2;
    return f <= 0n ? 0n : (priceWad * f + den - 1n) / den;
  }
  const g = den - spread + skew2;
  return g <= 0n ? 0n : (priceWad * g) / den;
}

/**
 * Cheap pre-filter for the liquidation sweep (only candidates are simulated on-chain): trader equity at
 * `priceWad` (margin + unrealised PnL, funding ignored) below the requirement plus a buffer (pass
 * `liquidationMarginBps(pool, held)`: maintenance, or the off-hours requirement while held).
 * Units: size 1e18, prices WAD, USD 6dp.
 */
export function nearLiquidation(
  pos: { size: bigint; entryPriceWad: bigint; marginUsd: bigint },
  priceWad: bigint,
  maintenanceMarginBps: number,
  bufferBps = 2_000,
): boolean {
  if (pos.size === 0n || priceWad <= 0n) return false;
  const SCALE = 10n ** 30n; // 1e18 size * 1e18 price -> 1e6 USD
  const pnl = (pos.size * (priceWad - pos.entryPriceWad)) / SCALE;
  const equity = pos.marginUsd + pnl;
  const absSize = pos.size < 0n ? -pos.size : pos.size;
  const required = (absSize * priceWad * BigInt(Math.max(0, Math.round(maintenanceMarginBps)))) / SCALE / 10_000n;
  return equity * 10_000n < required * (10_000n + BigInt(Math.max(0, Math.round(bufferBps))));
}

/** Worst acceptable fill: buys may pay up to +slippage, sells accept down to -slippage. */
export function acceptablePriceWad(quotePriceWad: bigint, sizeDelta: bigint, slippageBps: number): bigint {
  const slip = BigInt(Math.max(0, Math.round(slippageBps)));
  return sizeDelta > 0n ? (quotePriceWad * (10_000n + slip)) / 10_000n : (quotePriceWad * (10_000n - slip)) / 10_000n;
}

export type TradeErrorClass = "stale_price" | "off_hours" | "reduce_only" | "exposure_cap" | "margin" | "price" | "not_live" | "other";

/** Classify a venue rejection (custom error name and/or message) so the sim can back off sensibly. */
export function classifyTradeError(name: string | null, message: string, o: { carriedPrice?: boolean } = {}): TradeErrorClass {
  const s = `${name ?? ""} ${message}`.toLowerCase();
  // pull oracle: the in-tx AttestedOracle.update rejected the bundle (signer rotated, signer clock ahead
  // of the chain) — the next arrival carries a fresher one; not an off-hours signal
  if (/badsigner|futureprice/.test(s)) return "stale_price";
  // a trade that carried its price and still got StalePrice: the carried print was past maxTradePriceAge
  // when mined (PoolEngine reverts StalePrice for it) — retry with a fresher bundle, no close-only period
  if (o.carriedPrice && /staleprice/.test(s)) return "stale_price";
  if (/stale|held|offhours|off_hours|off-hours|session/.test(s)) return "off_hours";
  if (/reduceonly|reduce_only|reduce-only|newrisk/.test(s)) return "reduce_only";
  if (/exposure|maxnet|inventory|capacity/.test(s)) return "exposure_cap";
  if (/margin|collateral|insufficient/.test(s)) return "margin";
  if (/price|slippage|acceptable/.test(s)) return "price";
  if (/not live|notlive|market|state/.test(s)) return "not_live";
  return "other";
}

/** Rejections after which the sim only closes positions for a while (exposure caps flip side instead). */
export const CLOSE_ONLY_CLASSES: readonly TradeErrorClass[] = ["reduce_only"];

/**
 * Rejections after which the sim does not trade at all for a while: the engine's price is held / stale and
 * PoolEngine fills no trade then, closes included (audit A2-01 / A2-03).
 */
export const PAUSE_CLASSES: readonly TradeErrorClass[] = ["off_hours"];
