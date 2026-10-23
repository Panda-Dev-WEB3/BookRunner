// Trading page (2026-10, Plan B2: single-stock markets on the in-house PoolEngine). Which price a trade fills at
// (pull oracle: the trade carries the freshest signed print, docs/LOW_GAS.md §1), the market's session state
// (open / reduce-only / split close-only / off-hours / split window / no fresh price / closed), and the views of a
// market and a trader's position. Every rule mirrors PoolEngine.sol; the math is in ./engine.ts. Pure.
import { decodePriceData, encodePriceData, type PriceUpdate, priceUpdateFromMsg } from "@bookrunner/shared/eip712";
import type { OraclePriceMsg } from "@bookrunner/shared/queues";
import { type Address, type Hex, isAddress, isHex } from "viem";
import type { EngineMarketChainState, EngineTraderChainState } from "../chain/gateway";
import { usdStr, wadStr } from "../format";
import {
  BPS,
  type EngineMarketMath,
  type EnginePosition,
  NEW_RISK_MAX_PRICE_AGE,
  SIZE_PRICE_TO_USD,
  WAD,
  abs,
  fillPriceWad,
  fundingOwedUsd,
  liquidationPriceWad,
  marginRatioBps,
  maxWithdrawableUsd,
  notionalUsd,
  offHoursMarginBps,
  pnlUsd,
  traderEquityUsd,
} from "./engine";

/** A trade carries a price at least this many seconds younger than the engine's bound (it is mined a block or two later). */
export const TRADE_PRICE_HEADROOM_SEC = 3;
/** Default slippage of the order panel (0.5 %), and the most the API prepares. */
export const DEFAULT_SLIPPAGE_BPS = 50;
export const MAX_SLIPPAGE_BPS = 500;
/** Adverse move the safe margin withdrawal keeps room for. */
export const WITHDRAW_BUFFER_BPS = 100;

export interface SignedPrice {
  update: PriceUpdate;
  signature: Hex;
  /** abi.encode([update], [signature]): the trade's `priceData` (only this market's print) */
  priceData: Hex;
}

/**
 * The freshest signed print of `underlying` from the oracle's bundle (KEYS.oracleBundle) or its per-key messages
 * (KEYS.oracleLast, heartbeat mode). A bundle signed for another chain or oracle is ignored (the signature would
 * not verify on this deployment's AttestedOracle).
 */
export function signedPriceFor(rawBundle: unknown, messages: unknown[], underlying: Hex, domain: { chainId: number; oracle: Address }): SignedPrice | null {
  const want = underlying.toLowerCase();
  const found: Array<{ update: PriceUpdate; signature: Hex }> = [];
  const b = rawBundle && typeof rawBundle === "object" ? (rawBundle as Record<string, unknown>) : null;
  const sameDomain =
    b !== null &&
    (b.chainId === undefined || b.chainId === domain.chainId) &&
    (b.oracle === undefined || (typeof b.oracle === "string" && isAddress(b.oracle, { strict: false }) && b.oracle.toLowerCase() === domain.oracle.toLowerCase()));
  if (b && sameDomain && typeof b.priceData === "string" && isHex(b.priceData) && b.priceData !== "0x") {
    try {
      const { updates, sigs } = decodePriceData(b.priceData);
      updates.forEach((u, i) => {
        if (u.underlying.toLowerCase() === want && sigs[i]) found.push({ update: u, signature: sigs[i] });
      });
    } catch {
      /* malformed bundle: the per-key messages */
    }
  }
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const o = m as Partial<OraclePriceMsg>;
    if (typeof o.underlying !== "string" || o.underlying.toLowerCase() !== want || typeof o.signature !== "string" || !isHex(o.signature)) continue;
    try {
      found.push({ update: priceUpdateFromMsg(o as OraclePriceMsg), signature: o.signature });
    } catch {
      /* malformed message */
    }
  }
  const best = found.filter((f) => f.update.priceWad > 0n).sort((a, b) => (a.update.publishedAt > b.update.publishedAt ? -1 : a.update.publishedAt < b.update.publishedAt ? 1 : 0))[0];
  return best ? { ...best, priceData: encodePriceData([best.update], [best.signature]) } : null;
}

/** The price a trade fills at: the carried signed print when it is newer than the stored one (AttestedOracle.update skips a not-newer entry). */
export interface TradePrice {
  priceWad: bigint;
  publishedAt: number;
  held: boolean;
  source: "signed" | "stored";
  /** `priceData` the trade carries ("0x" when the stored price is the newer one) */
  priceData: Hex;
}

export function tradePrice(m: Pick<EngineMarketChainState, "stored">, signed: SignedPrice | null): TradePrice | null {
  const s = m.stored;
  if (signed && (!s || Number(signed.update.publishedAt) > s.publishedAt)) {
    return { priceWad: signed.update.priceWad, publishedAt: Number(signed.update.publishedAt), held: signed.update.held, source: "signed", priceData: signed.priceData };
  }
  return s ? { priceWad: s.priceWad, publishedAt: s.publishedAt, held: s.held, source: "stored", priceData: "0x" } : null;
}

/** PoolEngine._tradeStale bound: min(maxPriceAge, NEW_RISK_MAX_PRICE_AGE, maxTradePriceAge). */
export const tradeMaxAge = (m: Pick<EngineMarketChainState, "maxPriceAge" | "maxTradePriceAge">) => Math.min(m.maxPriceAge, NEW_RISK_MAX_PRICE_AGE, m.maxTradePriceAge);
/** PoolEngine._newRiskStale bound (margin withdrawal with a position): min(maxPriceAge, NEW_RISK_MAX_PRICE_AGE). */
export const withdrawMaxAge = (m: Pick<EngineMarketChainState, "maxPriceAge">) => Math.min(m.maxPriceAge, NEW_RISK_MAX_PRICE_AGE);

export type Session = "open" | "reduce_only" | "split_close_only" | "off_hours" | "split_window" | "no_fresh_price" | "closed";

export interface SessionState {
  session: Session;
  /** any voluntary trade (open, increase, reduce, close, flip) can fill now */
  canTrade: boolean;
  /** new risk (open / increase / flip) can fill now */
  newRisk: boolean;
  /** why trading is limited, in plain words (empty when open) */
  reasons: string[];
}

export interface SessionInput {
  bookState: string;
  price: TradePrice | null;
  nowSec: number;
  maxAgeSec: number;
  reduceOnly: boolean;
  closeOutAfter: number;
  lossBudgetBlocked: boolean;
  split: { pending: boolean; window: boolean };
}

/** Session of a market, strictest first, as PoolEngine._trade gates a trade. */
export function sessionOf(i: SessionInput): SessionState {
  const live = i.bookState === "Live" || i.bookState === "Retiring";
  if (!live) return { session: "closed", canTrade: false, newRisk: false, reasons: [`The book is ${i.bookState}: its market is not open.`] };
  if (i.split.window) return { session: "split_window", canTrade: false, newRisk: false, reasons: ["A stock split took effect and the price is still in pre-split shares: no trade fills until the oracle reprices."] };
  if (!i.price) return { session: "no_fresh_price", canTrade: false, newRisk: false, reasons: ["The market has no price yet."] };
  if (i.price.held) return { session: "off_hours", canTrade: false, newRisk: false, reasons: ["The stock's session is closed (off-hours): no trade fills, closes included, until it reopens. Margin top-ups still work."] };
  if (i.nowSec - i.price.publishedAt > i.maxAgeSec - TRADE_PRICE_HEADROOM_SEC)
    return { session: "no_fresh_price", canTrade: false, newRisk: false, reasons: [`No signed price fresh enough to trade (a trade needs one at most ${i.maxAgeSec} s old). Retry in a few seconds.`] };
  const reasons: string[] = [];
  if (i.split.pending) reasons.push("A stock split is pending: close-only until it is done (positions are per share and are never rebased).");
  if (i.reduceOnly)
    reasons.push(i.closeOutAfter > 0 ? `The book is winding down: reduce-only, and from ${new Date(i.closeOutAfter * 1000).toISOString()} anyone may close remaining positions at the oracle price.` : "The market is reduce-only: only reductions and closes fill.");
  if (i.bookState === "Retiring" && !i.reduceOnly) reasons.push("The book is retiring: reduce-only.");
  if (i.lossBudgetBlocked) reasons.push("The pool's loss budget for this period is spent: new risk is paused until the next period, reductions and closes fill.");
  if (reasons.length === 0) return { session: "open", canTrade: true, newRisk: true, reasons };
  return { session: i.split.pending ? "split_close_only" : "reduce_only", canTrade: true, newRisk: false, reasons };
}

export const mathOf = (m: EngineMarketChainState): EngineMarketMath => ({
  spreadBps: m.state.spreadBps,
  skewBps: m.state.skewBps,
  takerFeeBps: m.config.takerFeeBps,
  initialMarginBps: m.config.initialMarginBps,
  maintenanceMarginBps: m.config.maintenanceMarginBps,
  maxNetExposureUsd: m.config.maxNetExposureUsd,
  inventoryCapUsd: m.inventoryCapUsd,
  longSize: m.state.longSize,
  shortSize: m.state.shortSize,
  fundingIndex: m.state.fundingIndex,
});

/** 1e18-unit size -> decimal string ("0.5", "-12.25"). */
export const unitsStr = (raw: bigint): string => {
  const s = wadStr(abs(raw));
  return raw < 0n ? `-${s}` : s;
};
const signedUsd = (raw: bigint) => (raw < 0n ? `-${usdStr(-raw)}` : usdStr(raw));
const lev = (notional: bigint, equity: bigint) => (equity > 0n && notional > 0n ? Number((notional * 100n) / equity) / 100 : null);

/** Room left for new risk in USD per side at `priceWad`: min(side inventory cap - side OI, quote cap -/+ net). */
export function roomUsd(m: EngineMarketMath, priceWad: bigint): { buyUsd: bigint; sellUsd: bigint } {
  const longUsd = (m.longSize * priceWad) / SIZE_PRICE_TO_USD;
  const shortUsd = (-m.shortSize * priceWad) / SIZE_PRICE_TO_USD;
  const netUsd = ((m.longSize + m.shortSize) * priceWad) / SIZE_PRICE_TO_USD; // traders' net, long positive
  const pos = (v: bigint) => (v > 0n ? v : 0n);
  const minB = (a: bigint, b: bigint) => (a < b ? a : b);
  return {
    buyUsd: pos(minB(m.inventoryCapUsd - longUsd, m.maxNetExposureUsd - netUsd)),
    sellUsd: pos(minB(m.inventoryCapUsd - shortUsd, m.maxNetExposureUsd + netUsd)),
  };
}

export interface MarketMeta {
  bookId: number;
  name: string | null;
  bookSymbol: string;
  symbol: string;
  bookState: string;
}

export function marketView(meta: MarketMeta, m: EngineMarketChainState, price: TradePrice | null, s: SessionState, nowSec: number) {
  const math = mathOf(m);
  const px = price?.priceWad ?? 0n;
  const maxAge = tradeMaxAge(m);
  const room = px > 0n ? roomUsd(math, px) : { buyUsd: 0n, sellUsd: 0n };
  const ohBps = offHoursMarginBps(m.config.initialMarginBps);
  return {
    bookId: meta.bookId,
    marketId: m.marketId,
    name: meta.name,
    symbol: meta.symbol,
    bookSymbol: meta.bookSymbol,
    bookState: meta.bookState,
    engine: m.engine,
    adapter: m.adapter,
    underlying: m.config.underlying,
    session: s.session,
    canTrade: s.canTrade,
    newRisk: s.newRisk,
    reasons: s.reasons,
    price: price
      ? {
          price: wadStr(price.priceWad),
          priceWad: price.priceWad.toString(),
          publishedAt: new Date(price.publishedAt * 1000).toISOString(),
          publishedAtSec: price.publishedAt,
          ageSeconds: Math.max(0, nowSec - price.publishedAt),
          held: price.held,
          source: price.source,
          /** a trade carrying this print must be mined before this time (publishedAt + the trade bound) */
          tradableUntil: new Date((price.publishedAt + maxAge) * 1000).toISOString(),
        }
      : null,
    storedPrice: m.stored ? { price: wadStr(m.stored.priceWad), publishedAt: new Date(m.stored.publishedAt * 1000).toISOString(), ageSeconds: Math.max(0, nowSec - m.stored.publishedAt), held: m.stored.held } : null,
    tradePriceMaxAgeSeconds: maxAge,
    quote: {
      spreadBps: m.state.spreadBps,
      skewBps: m.state.skewBps,
      /** fill of a 1-unit buy / sell at the price (PoolEngine._fillPrice) */
      buyPrice: px > 0n ? wadStr(fillPriceWad(px, m.state.spreadBps, m.state.skewBps, WAD)) : null,
      sellPrice: px > 0n ? wadStr(fillPriceWad(px, m.state.spreadBps, m.state.skewBps, -WAD)) : null,
    },
    fees: { takerFeeBps: m.config.takerFeeBps, liquidationFeeBps: m.config.liquidationFeeBps },
    margin: {
      initialMarginBps: m.config.initialMarginBps,
      maintenanceMarginBps: m.config.maintenanceMarginBps,
      offHoursMarginBps: ohBps,
      maxLeverage: 10_000 / m.config.initialMarginBps,
      /** the most leverage a position can carry through a session close without being liquidatable at the held price */
      holdableLeverage: 10_000 / ohBps,
    },
    funding: {
      ratePerDayWad: m.fundingRatePerDayWad.toString(),
      /** signed bps of notional per day, 2 decimals (positive: longs pay, shorts receive; settled against the pool) */
      ratePerDayBps: Number((m.fundingRatePerDayWad * BPS * 100n) / WAD) / 100,
      velocityBps: m.config.fundingVelocityBps,
    },
    openInterest: {
      longUnits: unitsStr(m.state.longSize),
      shortUnits: unitsStr(-m.state.shortSize),
      longUsd: usdStr((m.state.longSize * px) / SIZE_PRICE_TO_USD),
      shortUsd: usdStr((-m.state.shortSize * px) / SIZE_PRICE_TO_USD),
      /** the pool's signed exposure = -(traders' net) x price (positive: the pool is long) */
      poolNetExposureUsd: signedUsd((-(m.state.longSize + m.state.shortSize) * px) / SIZE_PRICE_TO_USD),
    },
    caps: {
      inventoryCapUsd: usdStr(m.inventoryCapUsd),
      quoteCapUsd: usdStr(m.config.maxNetExposureUsd),
      /** new-risk room left at the price for a buy (long) / a sell (short) */
      buyRoomUsd: usdStr(room.buyUsd),
      sellRoomUsd: usdStr(room.sellUsd),
    },
    pool: { cashUsd: usdStr(m.state.poolCashUsd), insuranceUsd: usdStr(m.state.insuranceUsd), lossBudgetBlocked: m.lossBudgetBlocked },
    closeOutAfter: m.closeOutAfter > 0 ? new Date(m.closeOutAfter * 1000).toISOString() : null,
    reduceOnly: m.state.reduceOnly,
  };
}

export type MarketView = ReturnType<typeof marketView>;

/** Liquidation price as a decimal string (null: none on price; "any" when every price liquidates). */
function liqStr(r: { priceWad: bigint | null; always: boolean }): string | null {
  if (r.always) return "any";
  return r.priceWad === null ? null : wadStr(r.priceWad);
}

export function positionView(m: EngineMarketChainState, t: EngineTraderChainState, priceWad: bigint, maxWithdrawUsd: bigint) {
  const p: EnginePosition = t.position;
  const idx = m.state.fundingIndex;
  const flat = p.size === 0n;
  const equity = flat ? p.marginUsd : traderEquityUsd(p, priceWad, idx);
  const notional = notionalUsd(p.size, priceWad);
  const ohBps = offHoursMarginBps(m.config.initialMarginBps);
  return {
    marketId: m.marketId,
    side: flat ? ("flat" as const) : p.size > 0n ? ("long" as const) : ("short" as const),
    size: unitsStr(p.size),
    sizeRaw: p.size.toString(),
    entryPrice: flat ? null : wadStr(p.entryPriceWad),
    markPrice: wadStr(priceWad),
    marginUsd: usdStr(p.marginUsd),
    equityUsd: signedUsd(equity),
    notionalUsd: usdStr(notional),
    unrealizedPnlUsd: signedUsd(flat ? 0n : pnlUsd(p.size, p.entryPriceWad, priceWad)),
    /** unsettled funding (positive: owed by the trader; settled at the next trade or withdrawal) */
    fundingOwedUsd: signedUsd(flat ? 0n : fundingOwedUsd(p.size, idx, p.fundingIndexAtEntry)),
    marginRatioBps: marginRatioBps(p, priceWad, idx),
    leverage: lev(notional, equity),
    liquidationPrice: flat ? null : liqStr(liquidationPriceWad(p, idx, m.config.maintenanceMarginBps)),
    /** while the session is closed the requirement is 2 x initial margin: the price at which a held position is liquidated */
    liquidationPriceOffHours: flat ? null : liqStr(liquidationPriceWad(p, idx, ohBps)),
    maintenanceUsd: usdStr(flat ? 0n : (abs(p.size) * priceWad * BigInt(m.config.maintenanceMarginBps) + SIZE_PRICE_TO_USD * BPS - 1n) / (SIZE_PRICE_TO_USD * BPS)),
    maxWithdrawUsd: usdStr(maxWithdrawUsd),
    walletUsd: usdStr(t.usdcBalance),
    allowanceUsd: usdStr(t.usdcAllowance),
  };
}

export type PositionView = ReturnType<typeof positionView>;

export const safeMaxWithdraw = (m: EngineMarketChainState, t: EngineTraderChainState, priceWad: bigint) => maxWithdrawableUsd(mathOf(m), t.position, priceWad, WITHDRAW_BUFFER_BPS);

export { lev, signedUsd };
