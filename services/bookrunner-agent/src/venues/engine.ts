// EngineVenue: QuotingVenue for in-house PoolEngine books.
//
// The engine has no order book: the pool quotes every taker at
//   buy  = oracle * (1e4 + spread/2 + skew) / 1e4,  sell = oracle * (1e4 - spread/2 + skew) / 1e4
// bounded by maxNetExposureUsd (post-trade |pool exposure| cap for new risk). A two-sided quote is
// therefore translated into desk.execute(SetQuote{spreadBps, skewBps, maxNetExposureUsd}):
//   spreadBps = ceil(width of the quote), skewBps = trunc((mid - oracle) / oracle) — both rounded
//   toward the mandate-safe side; maxNetExposureUsd = the |exposure| reachable through the quoted
//   sizes, rounded up to an exposure step and never above maxInventoryUsd. With only the reducing side
//   quoted (reduce-only / util >= 0.9) the cap freezes at the current |exposure|: takers can reduce
//   pool exposure but not grow it. cancelAll() = that freeze (the engine has no resting orders).
// SetQuote is re-sent only when params move beyond a threshold, capacity must shrink, the previous
// params left the mandate, or every refreshIntervalMs when anything differs.

import { type Mandate, type QuotingVenue, type TwoSidedQuote, type VenueAccount, type VenueFill, absBig, maxBig, minBig } from "@bookrunner/shared";
import type { Hex } from "viem";
import { type DeskAction, encodeSetQuote } from "../chain/desk-actions";

export interface EngineQuoteParams {
  spreadBps: number;
  skewBps: number;
  maxNetExposureUsd: bigint;
}

export interface EngineQuoteMeta {
  oraclePx?: number;
  theoretical?: { bidPx: number; askPx: number };
}

export interface EngineParamCtx {
  oraclePx: number;
  netExposureUsd: bigint;
  mandate: Mandate;
  /** Exposure cap rounding step, bps of maxInventoryUsd. */
  exposureStepBps: number;
  /** Last cap sent: a freeze never raises capacity above it (price moves can lift |exposure|). */
  prevMaxNetExposureUsd?: bigint;
}

const toUsdRaw = (x: number): bigint => (Number.isFinite(x) && x > 0 ? BigInt(Math.floor(x * 1e6)) : 0n);

export function exposureStepUsd(m: Mandate, stepBps: number): bigint {
  const step = (m.maxInventoryUsd * BigInt(Math.max(0, Math.round(stepBps)))) / 10_000n;
  return step > 0n ? step : 1n;
}

/** Pure: SetQuote params for a (possibly one-sided) quote. Null when no price envelope can be formed. */
export function engineParamsFromQuote(q: TwoSidedQuote & EngineQuoteMeta, ctx: EngineParamCtx): EngineQuoteParams | null {
  const m = ctx.mandate;
  const oracle = q.oraclePx && q.oraclePx > 0 ? q.oraclePx : ctx.oraclePx;
  if (!(oracle > 0)) return null;

  // two-sided price envelope (the engine always quotes both sides around the oracle)
  let bidPx: number;
  let askPx: number;
  if (q.theoretical) {
    ({ bidPx, askPx } = q.theoretical);
  } else if (q.bid && q.ask) {
    bidPx = q.bid.px;
    askPx = q.ask.px;
  } else if (q.bid || q.ask) {
    const w = (m.minQuoteWidthBps + 1) / 20_000;
    if (q.ask) {
      const mid = q.ask.px / (1 + w);
      bidPx = mid * (1 - w);
      askPx = q.ask.px;
    } else {
      const mid = (q.bid as { px: number }).px / (1 - w);
      bidPx = (q.bid as { px: number }).px;
      askPx = mid * (1 + w);
    }
  } else {
    return null;
  }
  if (!(bidPx > 0) || !(askPx > bidPx)) return null;
  const mid = (bidPx + askPx) / 2;
  const widthBps = ((askPx - bidPx) / mid) * 10_000;
  const skewRaw = ((mid - oracle) / oracle) * 10_000;

  const spreadBps = Math.min(0xffff, Math.max(m.minQuoteWidthBps, Math.ceil(widthBps - 1e-9)));
  const maxSkew = Math.max(0, m.maxSkewBps);
  const skewBps = Math.max(-maxSkew, Math.min(maxSkew, Math.trunc(skewRaw)));

  // exposure reachable through the quoted sizes (book perspective: bid fill +, ask fill -)
  const e = ctx.netExposureUsd;
  const absE = absBig(e);
  const bidUsd = q.bid ? toUsdRaw(q.bid.qty * q.bid.px) : 0n;
  const askUsd = q.ask ? toUsdRaw(q.ask.qty * q.ask.px) : 0n;
  const reach = maxBig(absE, absBig(e + bidUsd), absBig(e - askUsd));
  const step = exposureStepUsd(m, ctx.exposureStepBps);
  let cap: bigint;
  if (reach > absE) {
    cap = ((reach + step - 1n) / step) * step; // growth allowed: round up to the step
  } else {
    // freeze: no new capacity; never above the previous cap (off-hours SetQuote must not widen)
    cap = ctx.prevMaxNetExposureUsd !== undefined ? minBig(absE, ctx.prevMaxNetExposureUsd) : absE;
  }
  return { spreadBps, skewBps, maxNetExposureUsd: minBig(cap, m.maxInventoryUsd) };
}

export interface ResendConfig {
  /** No non-urgent re-send sooner than this after the last send. */
  minIntervalMs: number;
  /** Re-send whatever differs at least this often. */
  refreshIntervalMs: number;
  spreadThresholdBps: number;
  skewThresholdBps: number;
  exposureStepBps: number;
}

export const DEFAULT_RESEND: ResendConfig = {
  minIntervalMs: 5_000,
  refreshIntervalMs: 60_000,
  spreadThresholdBps: 2,
  skewThresholdBps: 2,
  exposureStepBps: 500,
};

export const sameParams = (a: EngineQuoteParams | null | undefined, b: EngineQuoteParams | null | undefined): boolean =>
  !!a && !!b && a.spreadBps === b.spreadBps && a.skewBps === b.skewBps && a.maxNetExposureUsd === b.maxNetExposureUsd;

export function paramsWithinMandate(p: EngineQuoteParams, m: Mandate): boolean {
  return p.spreadBps >= m.minQuoteWidthBps && Math.abs(p.skewBps) <= m.maxSkewBps && p.maxNetExposureUsd <= m.maxInventoryUsd;
}

export interface SentState {
  params: EngineQuoteParams;
  sentAtMs: number;
}

/** Pure change-threshold logic for SetQuote. */
export function shouldResend(
  prev: SentState | null,
  next: EngineQuoteParams,
  nowMs: number,
  cfg: ResendConfig,
  m: Mandate,
): { send: boolean; urgent: boolean; reason: string } {
  if (!paramsWithinMandate(next, m)) return { send: false, urgent: false, reason: "NEXT_OUT_OF_MANDATE" };
  if (!prev) return { send: true, urgent: true, reason: "INITIAL" };
  if (sameParams(prev.params, next)) return { send: false, urgent: false, reason: "UNCHANGED" };
  if (!paramsWithinMandate(prev.params, m)) return { send: true, urgent: true, reason: "PREV_OUT_OF_MANDATE" };
  const step = exposureStepUsd(m, cfg.exposureStepBps);
  if (prev.params.maxNetExposureUsd - next.maxNetExposureUsd >= step) return { send: true, urgent: true, reason: "CAPACITY_DOWN" };
  const elapsed = nowMs - prev.sentAtMs;
  if (elapsed < cfg.minIntervalMs) return { send: false, urgent: false, reason: "RATE_LIMITED" };
  if (
    Math.abs(next.spreadBps - prev.params.spreadBps) >= cfg.spreadThresholdBps ||
    Math.abs(next.skewBps - prev.params.skewBps) >= cfg.skewThresholdBps ||
    absBig(next.maxNetExposureUsd - prev.params.maxNetExposureUsd) >= step
  ) {
    return { send: true, urgent: false, reason: "CHANGED" };
  }
  if (elapsed >= cfg.refreshIntervalMs) return { send: true, urgent: false, reason: "REFRESH" };
  return { send: false, urgent: false, reason: "BELOW_THRESHOLD" };
}

// ---------------------------------------------------------------- adapters

export interface EngineState {
  netExposureUsd: bigint; // adapter.netExposureUsd(): pool exposure, positive = book long
  marginEquityUsd: bigint; // pool equity
  insuranceEquityUsd: bigint;
  poolEquityUsd: bigint;
  poolCashUsd: bigint;
  netSize: bigint; // pool net size, 1e18 units (= -(long + short))
  reduceOnly: boolean;
}

export interface EngineTrade {
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  tsMs: number;
  trader: Hex;
  sizeDelta: bigint; // trader perspective
  fillPriceWad: bigint;
  feeUsd: bigint;
}

export interface EngineChain {
  readState(): Promise<EngineState>;
  /** Current on-chain quote params (seed for the change-threshold logic). */
  readQuote(): Promise<EngineQuoteParams | null>;
  /** Trade events of the book's market since the last scan with block time >= sinceMs. */
  tradesSince(sinceMs: number): Promise<EngineTrade[]>;
}

export interface DeskExecutor {
  execute(action: DeskAction, label: string): Promise<Hex>;
}

export type EngineFill = VenueFill & { trader: string };

/** Pure: engine Trade event -> fill from the BOOK's perspective (the pool is the taker's counterparty). */
export function tradeToFill(t: EngineTrade, symbol: string): EngineFill {
  const abs = t.sizeDelta < 0n ? -t.sizeDelta : t.sizeDelta;
  return {
    tradeId: `${t.txHash}:${t.logIndex}`,
    symbol,
    side: t.sizeDelta > 0n ? "sell" : "buy",
    qty: Number(abs) / 1e18,
    px: Number(t.fillPriceWad) / 1e18,
    feeUsd: -Number(t.feeUsd) / 1e6, // taker fee accrues to the book's fee flow
    ts: t.tsMs,
    maker: true,
    trader: t.trader.toLowerCase(),
  };
}

export interface EngineVenueDeps {
  chain: EngineChain;
  desk: DeskExecutor;
  mandate: () => Mandate;
  oraclePx: () => number | null;
  symbol: string;
  now?: () => number;
  onSent?: (p: EngineQuoteParams, reason: string, txHash: Hex) => void;
}

export interface EngineVenueConfig extends ResendConfig {
  /** After a failed SetQuote, non-urgent sends wait this long. */
  failureBackoffMs: number;
}

export class EngineVenue implements QuotingVenue {
  readonly kind = "engine" as const;
  private last: SentState | null = null;
  private lastFailureMs = -Infinity;
  private seeded = false;
  private readonly now: () => number;

  constructor(
    private readonly deps: EngineVenueDeps,
    private readonly cfg: EngineVenueConfig = { ...DEFAULT_RESEND, failureBackoffMs: 15_000 },
  ) {
    this.now = deps.now ?? Date.now;
  }

  get lastSent(): SentState | null {
    return this.last;
  }

  /** Seed with on-chain params (sentAt 0) so an unchanged quote is not re-sent at startup. */
  private async seed(): Promise<void> {
    if (this.seeded) return;
    this.seeded = true;
    const onChain = await this.deps.chain.readQuote().catch(() => null);
    if (onChain && !this.last) this.last = { params: onChain, sentAtMs: 0 };
  }

  async replaceQuote(q: TwoSidedQuote & EngineQuoteMeta): Promise<void> {
    await this.seed();
    const m = this.deps.mandate();
    const st = await this.deps.chain.readState();
    const next = engineParamsFromQuote(q, {
      oraclePx: this.deps.oraclePx() ?? 0,
      netExposureUsd: st.netExposureUsd,
      mandate: m,
      exposureStepBps: this.cfg.exposureStepBps,
      ...(this.last ? { prevMaxNetExposureUsd: this.last.params.maxNetExposureUsd } : {}),
    });
    if (!next) throw new Error("engine: cannot derive SetQuote params from quote");
    await this.apply(next, m, false);
  }

  async cancelAll(): Promise<void> {
    await this.seed();
    const m = this.deps.mandate();
    const st = await this.deps.chain.readState();
    const prev = this.last?.params;
    const next: EngineQuoteParams = {
      spreadBps: Math.min(0xffff, Math.max(prev?.spreadBps ?? m.minQuoteWidthBps, m.minQuoteWidthBps)),
      skewBps: Math.max(-Math.max(0, m.maxSkewBps), Math.min(Math.max(0, m.maxSkewBps), prev?.skewBps ?? 0)),
      maxNetExposureUsd: minBig(absBig(st.netExposureUsd), prev?.maxNetExposureUsd ?? m.maxInventoryUsd, m.maxInventoryUsd),
    };
    await this.apply(next, m, true);
  }

  private async apply(next: EngineQuoteParams, m: Mandate, forced: boolean): Promise<void> {
    const now = this.now();
    const d = shouldResend(this.last, next, now, this.cfg, m);
    const send = d.send || (forced && !sameParams(this.last?.params, next) && paramsWithinMandate(next, m));
    if (!send) return;
    const urgent = d.urgent || forced;
    if (!urgent && now - this.lastFailureMs < this.cfg.failureBackoffMs) return;
    const action = encodeSetQuote(next.spreadBps, next.skewBps, next.maxNetExposureUsd);
    try {
      const hash = await this.deps.desk.execute(action, `SetQuote:${forced ? "cancel" : d.reason}`);
      this.last = { params: next, sentAtMs: now };
      this.deps.onSent?.(next, forced ? "CANCEL" : d.reason, hash);
    } catch (err) {
      this.lastFailureMs = now;
      throw err;
    }
  }

  async account(): Promise<VenueAccount> {
    const st = await this.deps.chain.readState();
    const netQty = Number(st.netSize) / 1e18;
    const oracle = this.deps.oraclePx();
    const markPx = oracle && oracle > 0 ? oracle : netQty !== 0 ? Math.abs(Number(st.netExposureUsd) / 1e6 / netQty) : 0;
    return {
      equityUsd: st.marginEquityUsd,
      freeCollateralUsd: st.marginEquityUsd > 0n ? st.marginEquityUsd : 0n,
      position: {
        symbol: this.deps.symbol,
        netQty,
        avgPx: 0, // aggregate pool accounting has no average entry (VERIFY if the engine exposes one)
        markPx,
        netExposureUsd: st.netExposureUsd,
        unrealizedPnlUsd: st.poolEquityUsd - st.poolCashUsd,
      },
    };
  }

  async fillsSince(sinceMs: number): Promise<EngineFill[]> {
    const trades = await this.deps.chain.tradesSince(sinceMs);
    return trades.filter((t) => t.tsMs >= sinceMs).map((t) => tradeToFill(t, this.deps.symbol));
  }
}
