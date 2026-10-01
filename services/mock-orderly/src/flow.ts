// Stochastic taker flow (pure): Poisson arrivals, log-normal notional, side bias that responds to
// price moves (momentum vs. a price EMA) and to quote value (book mid vs. builder price). Takers are
// price-sensitive: each carries a limit at builder price +/- a random slippage tolerance, so a book
// quoting far from the price simply does not trade.
import type { Side } from "@bookrunner/shared";
import { logNormal, poisson, type Rng } from "./rng";

export interface FlowParams {
  enabled: boolean;
  ratePerMin: number; // mean taker arrivals per minute per symbol
  medianNotionalUsd: number;
  notionalSigma: number; // log-normal sigma
  maxNotionalUsd: number;
  momentumPerBps: number; // P(buy) shift per bp of (price - ema) / ema
  valuePerBps: number; // P(buy) shift per bp of (price - bookMid) / price
  maxBias: number; // |P(buy) - 0.5| cap
  maxSlippageBps: number; // taker tolerance beyond the builder price
  heldFactor: number; // arrival-rate multiplier while the builder price is held (session closed)
  emaHalfLifeSec: number;
}

export const DEFAULT_FLOW: FlowParams = {
  enabled: true,
  ratePerMin: 12,
  medianNotionalUsd: 1500,
  notionalSigma: 0.9,
  maxNotionalUsd: 25_000,
  momentumPerBps: 0.01,
  valuePerBps: 0.02,
  maxBias: 0.35,
  maxSlippageBps: 25,
  heldFactor: 0,
  emaHalfLifeSec: 120,
};

export interface FlowMarket {
  price: number; // builder (index) price
  emaPrice: number;
  held: boolean;
  bestBid?: number;
  bestAsk?: number;
}

export interface TakerArrival {
  side: Side;
  notionalUsd: number;
  qty: number;
  limitPx: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** P(taker buys). Momentum: price above its EMA -> more buys. Value: book mid below price -> more buys. */
export function buyProbability(m: FlowMarket, p: FlowParams): number {
  const momBps = m.emaPrice > 0 ? ((m.price - m.emaPrice) / m.emaPrice) * 1e4 : 0;
  let valueBps = 0;
  if (m.bestBid !== undefined && m.bestAsk !== undefined) {
    const mid = (m.bestBid + m.bestAsk) / 2;
    valueBps = ((m.price - mid) / m.price) * 1e4;
  } else if (m.bestAsk !== undefined) {
    valueBps = ((m.price - m.bestAsk) / m.price) * 1e4;
  } else if (m.bestBid !== undefined) {
    valueBps = ((m.price - m.bestBid) / m.price) * 1e4;
  }
  const bias = clamp(p.momentumPerBps * momBps + p.valuePerBps * valueBps, -p.maxBias, p.maxBias);
  return 0.5 + bias;
}

/** Arrivals in a tick of `dtSec`. */
export function sampleArrivals(rng: Rng, m: FlowMarket, p: FlowParams, dtSec: number): TakerArrival[] {
  if (!p.enabled || !(m.price > 0)) return [];
  const rate = (p.ratePerMin / 60) * (m.held ? p.heldFactor : 1);
  const n = poisson(rng, rate * dtSec);
  const out: TakerArrival[] = [];
  const pBuy = buyProbability(m, p);
  for (let i = 0; i < n; i++) {
    const side: Side = rng() < pBuy ? "BUY" : "SELL";
    const notionalUsd = Math.min(p.maxNotionalUsd, logNormal(rng, p.medianNotionalUsd, p.notionalSigma));
    const tol = (rng() * p.maxSlippageBps) / 1e4;
    const limitPx = side === "BUY" ? m.price * (1 + tol) : m.price * (1 - tol);
    out.push({ side, notionalUsd, qty: notionalUsd / m.price, limitPx });
  }
  return out;
}

/** EMA update with a half-life (time-aware). */
export function updateEma(prev: number | undefined, price: number, dtSec: number, halfLifeSec: number): number {
  if (prev === undefined || !(prev > 0)) return price;
  const alpha = 1 - Math.pow(0.5, Math.max(0, dtSec) / Math.max(1e-9, halfLifeSec));
  return prev + alpha * (price - prev);
}
