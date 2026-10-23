// PoolEngine math off-chain (contracts/src/PoolEngine.sol, PoolEngineMath): the same integer formulas and the
// same rounding, so a quote, a margin requirement or a liquidation price shown by the trading page is what the
// engine computes. Units: size 1e18 = 1 unit (share) of the underlying, prices WAD, USD 6 decimals.
// Pure (services/api/test/trade.test.ts checks it against vectors of contracts/test/engine/PoolEngine.t.sol); shared by
// the API (trading page) and the waterfall liquidation keeper.

export const WAD = 10n ** 18n;
export const BPS = 10_000n;
/** size(1e18) * price(1e18) -> usd(1e6) */
export const SIZE_PRICE_TO_USD = 10n ** 30n;
const WAD_TO_USD = 10n ** 12n;
/** PoolEngine.OFF_HOURS_MARGIN_MULTIPLE: maintenance while the oracle is held = 2 x initial margin (capped at 100 %). */
export const OFF_HOURS_MARGIN_MULTIPLE = 2n;
/** PoolEngine.NEW_RISK_MAX_PRICE_AGE: a margin withdrawal with a position needs a stored price at most this old. */
export const NEW_RISK_MAX_PRICE_AGE = 60;

export const abs = (x: bigint): bigint => (x < 0n ? -x : x);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** floor(a / b), b > 0 (toward -inf). */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

/** ceil(a / b), b > 0 (toward +inf). */
export function ceilDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a > 0n ? q + 1n : q;
}

/** OpenZeppelin Math.mulDiv with Rounding.Ceil for non-negative operands. */
const mulDivCeil = (a: bigint, b: bigint, d: bigint): bigint => (a * b + d - 1n) / d;

/** |size| * price in USD, floored. */
export const notionalUsd = (size: bigint, priceWad: bigint): bigint => (abs(size) * priceWad) / SIZE_PRICE_TO_USD;

/** ceil(|size| * price * bps / 1e4) in USD: a margin requirement. */
export const requirementUsd = (size: bigint, priceWad: bigint, bps: bigint): bigint => mulDivCeil(abs(size), priceWad * bps, SIZE_PRICE_TO_USD * BPS);

/** Trader PnL of `size` opened at `entry` valued at `price`, floored (against the trader). */
export const pnlUsd = (size: bigint, entryWad: bigint, priceWad: bigint): bigint => floorDiv(size * (priceWad - entryWad), SIZE_PRICE_TO_USD);

/** Funding owed BY the trader (> 0) or TO the trader (< 0), ceiled (in the pool's favour). */
export const fundingOwedUsd = (size: bigint, indexNow: bigint, indexAtEntry: bigint): bigint => ceilDiv(size * (indexNow - indexAtEntry), WAD * WAD_TO_USD);

/** True when old -> new opens, increases or flips a position. */
export function isNewRisk(oldSize: bigint, newSize: bigint): boolean {
  if (newSize === 0n) return false;
  if (oldSize === 0n) return true;
  if (oldSize > 0n !== newSize > 0n) return true;
  return abs(newSize) > abs(oldSize);
}

/** Average entry after a trade: increases average in (rounded against the trader), reductions keep it, flips take the fill. */
export function newEntry(oldSize: bigint, newSize: bigint, oldEntry: bigint, fill: bigint): bigint {
  if (newSize === 0n) return 0n;
  if (oldSize === 0n || oldSize > 0n !== newSize > 0n) return fill;
  const absOld = abs(oldSize);
  const absNew = abs(newSize);
  if (absNew <= absOld) return oldEntry;
  const num = absOld * oldEntry + (absNew - absOld) * fill;
  return newSize > 0n ? (num + absNew - 1n) / absNew : num / absNew;
}

/** Signed size a delta closes against oldSize (same sign as oldSize; 0 when it does not reduce). */
export function closedSize(oldSize: bigint, delta: bigint): bigint {
  if (oldSize === 0n || oldSize > 0n === delta > 0n) return 0n;
  const c = min(abs(oldSize), abs(delta));
  return oldSize > 0n ? c : -c;
}

/**
 * PoolEngine._fillPrice: buy at oracle * (2e4 + spread + 2 skew) / 2e4 rounded up, sell at
 * oracle * (2e4 - spread + 2 skew) / 2e4 rounded down.
 */
export function fillPriceWad(priceWad: bigint, spreadBps: number, skewBps: number, sizeDelta: bigint): bigint {
  const den = 2n * BPS;
  const skew2 = 2n * BigInt(skewBps);
  if (sizeDelta > 0n) return mulDivCeil(priceWad, den + BigInt(spreadBps) + skew2, den);
  return (priceWad * (den - BigInt(spreadBps) + skew2)) / den;
}

/** Off-hours maintenance requirement: min(2 x initial margin, 100 %). */
export const offHoursMarginBps = (initialMarginBps: number): number => Math.min(Number(OFF_HOURS_MARGIN_MULTIPLE) * initialMarginBps, 10_000);

export interface EnginePosition {
  size: bigint;
  entryPriceWad: bigint;
  marginUsd: bigint;
  fundingIndexAtEntry: bigint;
}

/** margin + unrealised PnL (floored) - unsettled funding (ceiled). */
export const traderEquityUsd = (p: EnginePosition, priceWad: bigint, index: bigint): bigint =>
  p.marginUsd + pnlUsd(p.size, p.entryPriceWad, priceWad) - fundingOwedUsd(p.size, index, p.fundingIndexAtEntry);

/** PoolEngine._isLiquidatable at `requirementBps` (maintenance in session, offHoursMarginBps while held). */
export function isLiquidatable(p: EnginePosition, priceWad: bigint, index: bigint, requirementBps: number): boolean {
  if (p.size === 0n) return false;
  return traderEquityUsd(p, priceWad, index) < requirementUsd(p.size, priceWad, BigInt(requirementBps));
}

/** PoolEngine.marginRatioBps: equity / notional in bps (null when flat, 0 when equity <= 0). */
export function marginRatioBps(p: EnginePosition, priceWad: bigint, index: bigint): number | null {
  if (p.size === 0n) return null;
  const notional = notionalUsd(p.size, priceWad);
  if (notional === 0n) return null;
  const equity = traderEquityUsd(p, priceWad, index);
  if (equity <= 0n) return 0;
  return Number((equity * BPS) / notional);
}

/**
 * The oracle price at which the position becomes liquidatable at `requirementBps`, solving
 * equity(P) = requirement(P) of the engine (funding owed `fundingUsd` fixed at its current value):
 *   long:  P = (entry * 1e4 - (margin - funding) * 1e34 / size) / (1e4 - bps)   (liquidatable at or below)
 *   short: P = (entry * 1e4 + (margin - funding) * 1e34 / |size|) / (1e4 + bps) (liquidatable at or above)
 * The closed form brackets the answer; a bisection on the engine predicate itself (its floor / ceil rounding)
 * returns, for a long, the highest price that is liquidatable and, for a short, the lowest. null: flat, or a long
 * that no price can liquidate (margin covers the whole entry notional); `always`: every price liquidates it.
 */
export function liquidationPriceWad(p: EnginePosition, index: bigint, requirementBps: number): { priceWad: bigint | null; always: boolean } {
  if (p.size === 0n) return { priceWad: null, always: false };
  const bps = BigInt(requirementBps);
  const s = abs(p.size);
  const cushion = (p.marginUsd - fundingOwedUsd(p.size, index, p.fundingIndexAtEntry)) * SIZE_PRICE_TO_USD * BPS; // usd * 1e34
  const liq = (px: bigint) => isLiquidatable(p, px, index, requirementBps);
  if (p.size > 0n) {
    const den = BPS - bps;
    if (den <= 0n) return { priceWad: null, always: liq(p.entryPriceWad) };
    const num = p.entryPriceWad * BPS * s - cushion;
    if (num <= 0n || !liq(0n)) return { priceWad: null, always: false };
    // [lo liquidatable, hi not]
    let lo = 0n;
    let hi = 2n * (num / (s * den)) + 2n;
    for (let i = 0; i < 256 && liq(hi); i++) hi *= 2n;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (liq(mid)) lo = mid;
      else hi = mid;
    }
    return { priceWad: lo, always: false };
  }
  const den = BPS + bps;
  const num = p.entryPriceWad * BPS * s + cushion;
  if (num <= 0n || liq(0n)) return { priceWad: 0n, always: true };
  // [lo not liquidatable, hi liquidatable]
  let lo = 0n;
  let hi = 2n * ceilDiv(num, s * den) + 2n;
  for (let i = 0; i < 256 && !liq(hi); i++) hi *= 2n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (liq(mid)) hi = mid;
    else lo = mid;
  }
  return { priceWad: hi, always: false };
}

export interface EngineMarketMath {
  spreadBps: number;
  skewBps: number;
  takerFeeBps: number;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  /** cfg.maxNetExposureUsd: the live quote cap on |pool net exposure| */
  maxNetExposureUsd: bigint;
  /** inventoryCapUsd: per-side open-interest cap */
  inventoryCapUsd: bigint;
  longSize: bigint;
  shortSize: bigint;
  /** funding index including the accrual since the last interaction (PoolEngine.state) */
  fundingIndex: bigint;
}

export type TradeRefusal =
  | { code: "ZERO_SIZE"; message: string }
  | { code: "SETTLE_SHORTFALL"; message: string; requiredUsd: bigint; availableUsd: bigint }
  | { code: "FEE_SHORTFALL"; message: string; requiredUsd: bigint; availableUsd: bigint }
  | { code: "EXPOSURE_CAP"; message: string; exposureUsd: bigint; capUsd: bigint }
  | { code: "SIDE_CAP"; message: string; exposureUsd: bigint; capUsd: bigint }
  | { code: "INITIAL_MARGIN"; message: string; requiredUsd: bigint; equityUsd: bigint }
  | { code: "WOULD_BE_LIQUIDATABLE"; message: string };

export interface TradeSim {
  oldSize: bigint;
  newSize: bigint;
  newRisk: boolean;
  fillPriceWad: bigint;
  feeUsd: bigint;
  /** realised PnL of the closed part, at the fill */
  realisedPnlUsd: bigint;
  /** funding settled by the trade (> 0 paid by the trader) */
  fundingUsd: bigint;
  newEntryWad: bigint;
  marginAfterUsd: bigint;
  /** margin + unrealised PnL at the oracle price, after the trade */
  equityAfterUsd: bigint;
  notionalAfterUsd: bigint;
  /** initial margin the resulting position needs (0 when flat) */
  requiredInitialUsd: bigint;
  longSizeAfter: bigint;
  shortSizeAfter: bigint;
  refusal: TradeRefusal | null;
}

const usd = (raw: bigint) => {
  const neg = raw < 0n;
  const a = abs(raw);
  const cents = (a + 5_000n) / 10_000n;
  return `${neg ? "-" : ""}${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
};

/**
 * PoolEngine._trade without the oracle / session gates (checked by the caller) and without the pool-level
 * checks the API cannot see exactly (PoolUndercollateralized, the loss budget: the caller passes the loss
 * budget flag separately). `checkMargin` false: a quote without a wallet (the margin checks are skipped,
 * requiredInitialUsd says what the position needs).
 */
export function simulateTrade(m: EngineMarketMath, p: EnginePosition, priceWad: bigint, sizeDelta: bigint, checkMargin = true): TradeSim {
  const oldSize = p.size;
  const newSize = oldSize + sizeDelta;
  const newRisk = isNewRisk(oldSize, newSize);
  const fill = sizeDelta === 0n ? priceWad : fillPriceWad(priceWad, m.spreadBps, m.skewBps, sizeDelta);
  const fundingUsd = fundingOwedUsd(oldSize, m.fundingIndex, p.fundingIndexAtEntry);
  const realisedPnlUsd = pnlUsd(closedSize(oldSize, sizeDelta), p.entryPriceWad, fill);
  const feeUsd = (notionalUsd(sizeDelta, fill) * BigInt(m.takerFeeBps)) / BPS;
  const entry = newEntry(oldSize, newSize, p.entryPriceWad, fill);
  let longSize = m.longSize;
  let shortSize = m.shortSize;
  if (oldSize > 0n) longSize -= oldSize;
  else if (oldSize < 0n) shortSize -= oldSize;
  if (newSize > 0n) longSize += newSize;
  else if (newSize < 0n) shortSize += newSize;

  let refusal: TradeRefusal | null = null;
  const owed = fundingUsd - realisedPnlUsd;
  let margin = p.marginUsd;
  if (sizeDelta === 0n) refusal = { code: "ZERO_SIZE", message: "The size is zero." };
  if (owed > 0n) {
    if (margin < owed && checkMargin && !refusal)
      refusal = { code: "SETTLE_SHORTFALL", message: `Your margin (${usd(margin)}) does not cover the loss and funding this trade settles (${usd(owed)}). Add margin first.`, requiredUsd: owed, availableUsd: margin };
    margin = margin > owed ? margin - owed : 0n;
  } else margin += -owed;
  if (margin < feeUsd && checkMargin && !refusal)
    refusal = { code: "FEE_SHORTFALL", message: `Your margin after settlement (${usd(margin)}) does not cover the fee (${usd(feeUsd)}). Add margin first.`, requiredUsd: feeUsd, availableUsd: margin };
  margin = margin > feeUsd ? margin - feeUsd : 0n;

  const equityAfterUsd = margin + pnlUsd(newSize, entry, priceWad);
  const requiredInitialUsd = newSize === 0n ? 0n : requirementUsd(newSize, priceWad, BigInt(m.initialMarginBps));
  if (!refusal && newRisk) {
    const exposure = (abs(longSize + shortSize) * priceWad) / SIZE_PRICE_TO_USD;
    const sideOi = ((newSize > 0n ? longSize : -shortSize) * priceWad) / SIZE_PRICE_TO_USD;
    if (exposure > m.maxNetExposureUsd)
      refusal = { code: "EXPOSURE_CAP", message: `The pool's net exposure would be ${usd(exposure)}, above its current cap of ${usd(m.maxNetExposureUsd)}. Trade a smaller size.`, exposureUsd: exposure, capUsd: m.maxNetExposureUsd };
    else if (sideOi > m.inventoryCapUsd)
      refusal = { code: "SIDE_CAP", message: `Open interest on the ${newSize > 0n ? "long" : "short"} side would be ${usd(sideOi)}, above the market's inventory cap of ${usd(m.inventoryCapUsd)}. Trade a smaller size.`, exposureUsd: sideOi, capUsd: m.inventoryCapUsd };
    else if (checkMargin && equityAfterUsd < requiredInitialUsd) {
      const maxLev = 10_000 / m.initialMarginBps;
      refusal = { code: "INITIAL_MARGIN", message: `Over the maximum leverage (${maxLev.toFixed(maxLev % 1 ? 1 : 0)}x): the position needs ${usd(requiredInitialUsd)} of equity, it would have ${usd(equityAfterUsd)}. Add margin or trade a smaller size.`, requiredUsd: requiredInitialUsd, equityUsd: equityAfterUsd };
    }
  } else if (!refusal && newSize !== 0n && checkMargin) {
    // funding was just settled: the index at entry is the current one
    const after: EnginePosition = { size: newSize, entryPriceWad: entry, marginUsd: margin, fundingIndexAtEntry: m.fundingIndex };
    if (isLiquidatable(after, priceWad, m.fundingIndex, m.maintenanceMarginBps))
      refusal = { code: "WOULD_BE_LIQUIDATABLE", message: "This reduction would leave the rest of the position below its maintenance margin. Close it entirely or add margin first." };
  }
  return {
    oldSize,
    newSize,
    newRisk,
    fillPriceWad: fill,
    feeUsd,
    realisedPnlUsd,
    fundingUsd,
    newEntryWad: entry,
    marginAfterUsd: margin,
    equityAfterUsd,
    notionalAfterUsd: notionalUsd(newSize, priceWad),
    requiredInitialUsd,
    longSizeAfter: longSize,
    shortSizeAfter: shortSize,
    refusal,
  };
}

/** Worst acceptable fill for a slippage: buys pay up to +slippage, sells accept down to -slippage (as trader-sim). */
export function acceptablePriceWad(quoteWad: bigint, sizeDelta: bigint, slippageBps: number): bigint {
  const slip = BigInt(slippageBps);
  return sizeDelta > 0n ? (quoteWad * (BPS + slip)) / BPS : (quoteWad * (BPS - slip)) / BPS;
}

/**
 * Margin a withdrawal can take with an open position, safely: the engine settles funding, then needs
 * equity >= initial margin at the price; this also holds after an adverse move of `bufferBps` (the price moves
 * between preparation and mining). Flat: the whole margin.
 */
export function maxWithdrawableUsd(m: Pick<EngineMarketMath, "initialMarginBps" | "fundingIndex">, p: EnginePosition, priceWad: bigint, bufferBps = 100): bigint {
  if (p.size === 0n) return p.marginUsd;
  const funding = fundingOwedUsd(p.size, m.fundingIndex, p.fundingIndexAtEntry);
  const margin = p.marginUsd - funding;
  if (margin <= 0n) return 0n;
  const b = BigInt(bufferBps);
  const adverse = p.size > 0n ? (priceWad * (BPS - b)) / BPS : ceilDiv(priceWad * (BPS + b), BPS);
  const free = margin + pnlUsd(p.size, p.entryPriceWad, adverse) - requirementUsd(p.size, adverse, BigInt(m.initialMarginBps));
  if (free <= 0n) return 0n;
  return min(free, margin);
}

/**
 * PoolEngine._liquidate requirement: while the oracle is held (session closed) min(2 x initial margin, 100 %), otherwise
 * maintenance; a settled market (governance settle price in force, audit Task 7a) uses maintenance (a final price has
 * no reopen gap).
 */
export const liquidationRequirementBps = (m: { initialMarginBps: number; maintenanceMarginBps: number }, held: boolean, settled: boolean): number =>
  held && !settled ? offHoursMarginBps(m.initialMarginBps) : m.maintenanceMarginBps;

/**
 * What a liquidation pays its liquidator (PoolEngine._closeAtOracle + _liquidationFee): the position closes at the oracle,
 * funding and PnL settle against margin (a shortfall is bad debt the IF covers first), then the fee (liquidationFeeBps of
 * notional) comes out of what margin is left; the liquidator always earns half the NOMINAL fee, from that margin first
 * and from the IF after the bad debt (capped by its balance). A trader gain is assumed paid by the pool in full.
 */
export function liquidationRewardUsd(p: EnginePosition, priceWad: bigint, index: bigint, liquidationFeeBps: number, insuranceUsd: bigint): { rewardUsd: bigint; feeUsd: bigint; badDebtUsd: bigint } {
  if (p.size === 0n) return { rewardUsd: 0n, feeUsd: 0n, badDebtUsd: 0n };
  const owed = fundingOwedUsd(p.size, index, p.fundingIndexAtEntry) - pnlUsd(p.size, p.entryPriceWad, priceWad);
  let margin = p.marginUsd;
  let ins = insuranceUsd;
  let badDebtUsd = 0n;
  if (owed > 0n) {
    if (margin >= owed) margin -= owed;
    else {
      badDebtUsd = owed - margin;
      margin = 0n;
      ins -= min(badDebtUsd, ins);
    }
  } else margin += -owed;
  const nominal = (notionalUsd(p.size, priceWad) * BigInt(liquidationFeeBps)) / BPS;
  const feeUsd = min(margin, nominal);
  const fromFee = min(nominal / 2n, feeUsd);
  const ins2 = ins + feeUsd - fromFee;
  const fromIf = min(nominal / 2n - fromFee, ins2);
  return { rewardUsd: fromFee + fromIf, feeUsd, badDebtUsd };
}
