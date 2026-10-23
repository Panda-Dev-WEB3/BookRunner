// Liquidation keeper decisions (pure; test/liquidation.test.ts). Mirrors PoolEngine.sol exactly:
//   - the price a liquidation uses is the one its transaction brings: the carried signed print when AttestedOracle.update
//     stores it (newer than the stored price and within maxPriceAge), else the stored price;
//   - _oracleOrSettle: when that price is held or older than 60 s and a governance settle price is in force, the market
//     is priced at the settle price as held + settled;
//   - _isLiquidatable: equity < requirement, maintenance in session, min(2 x initial margin, 100 %) while held, and
//     maintenance on a settled market (audit Task 7a);
//   - forceClose (no fee, no reward) where it is the engine's path for the rest: a settled market (any position, any
//     price), or a wind-down close-out that is open (closeOutAfter passed) with a live price within the trade bound.
// Gas guard: a transaction may cost at most its reward plus a margin (reward converted at the configured ETH/USD), and
// never more than the per-transaction or the hourly cap.
import { type EnginePosition, NEW_RISK_MAX_PRICE_AGE, isLiquidatable, liquidationRequirementBps, liquidationRewardUsd, requirementUsd, traderEquityUsd } from "@bookrunner/shared/engineMath";
import type { BacklogReason, LiquidationBacklogItem, LiquidationMarketStatus } from "@bookrunner/shared/liquidationKeeper";
import type { SignedPrice } from "@bookrunner/shared/signedPrice";
import type { Hex } from "viem";

export interface EngineMarketCfg {
  underlying: Hex;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  liquidationFeeBps: number;
}

/** One market as one pass reads it (one aggregate3). */
export interface MarketRead {
  marketId: number;
  cfg: EngineMarketCfg;
  /** PoolEngine.state().fundingIndex (accrued to now at the stored price) */
  fundingIndex: bigint;
  insuranceUsd: bigint;
  closeOutAfter: number;
  /** AttestedOracle.latest(underlying); null = never priced */
  stored: { priceWad: bigint; publishedAt: number; held: boolean } | null;
  /** AttestedOracle.settlePrice(underlying); null = unreadable (an older oracle) or none */
  settle: { priceWad: bigint; effective: boolean } | null;
}

export interface ProtocolParams {
  maxPriceAge: number;
  maxTradePriceAge: number;
}

export interface PriceUsed {
  priceWad: bigint;
  publishedAt: number;
  held: boolean;
  settled: boolean;
  /** what the transaction carries ("0x" = nothing newer than the stored price) */
  priceData: Hex;
}

/** The price an engine transaction sent now would use (see the header). null = the market was never priced. */
export function priceUsed(m: MarketRead, signed: SignedPrice | null, nowSec: number, p: ProtocolParams): PriceUsed | null {
  const s = m.stored;
  const sp = signed ? Number(signed.update.publishedAt) : 0;
  const carried = signed !== null && (!s || sp > s.publishedAt) && sp + p.maxPriceAge >= nowSec;
  let px: Omit<PriceUsed, "settled"> | null = carried
    ? { priceWad: signed.update.priceWad, publishedAt: sp, held: signed.update.held, priceData: signed.priceData }
    : s
      ? { ...s, priceData: "0x" }
      : null;
  if (!px) return null;
  if ((px.held || nowSec - px.publishedAt > NEW_RISK_MAX_PRICE_AGE) && m.settle?.effective) {
    px = { ...px, priceWad: m.settle.priceWad, held: true, publishedAt: nowSec };
    return { ...px, settled: true };
  }
  return { ...px, settled: false };
}

export type KeeperAction = {
  marketId: number;
  trader: string;
  action: "liquidate" | "forceClose";
  /** what the liquidator earns (0 for a forceClose) */
  rewardUsd: bigint;
  equityUsd: bigint;
  requirementUsd: bigint;
  priceData: Hex;
};

export function regimeOf(m: MarketRead, px: PriceUsed | null, nowSec: number, p: ProtocolParams): LiquidationMarketStatus["regime"] {
  if (!px) return "no_price";
  if (px.settled) return "settled";
  if (closeOutOpen(m, px, nowSec, p)) return "closeout";
  return px.held ? "held" : "open";
}

/** PoolEngine._forceClose for an unsettled market: close-out time passed, live price within the trade bound. */
function closeOutOpen(m: MarketRead, px: PriceUsed, nowSec: number, p: ProtocolParams): boolean {
  if (m.closeOutAfter === 0 || nowSec < m.closeOutAfter || px.held) return false;
  const bound = Math.min(p.maxPriceAge, NEW_RISK_MAX_PRICE_AGE, p.maxTradePriceAge);
  return px.publishedAt + bound >= nowSec;
}

/** What to send for each open position of a market (liquidate first: it pays; forceClose for the rest where allowed). */
export function decideMarket(m: MarketRead, positions: Array<{ trader: string; position: EnginePosition }>, px: PriceUsed | null, nowSec: number, p: ProtocolParams): KeeperAction[] {
  if (!px) return [];
  const bps = liquidationRequirementBps(m.cfg, px.held, px.settled);
  const closeOut = px.settled || closeOutOpen(m, px, nowSec, p);
  const out: KeeperAction[] = [];
  for (const { trader, position } of positions) {
    if (position.size === 0n) continue;
    const equityUsd = traderEquityUsd(position, px.priceWad, m.fundingIndex);
    const req = requirementUsd(position.size, px.priceWad, BigInt(bps));
    if (isLiquidatable(position, px.priceWad, m.fundingIndex, bps)) {
      const { rewardUsd } = liquidationRewardUsd(position, px.priceWad, m.fundingIndex, m.cfg.liquidationFeeBps, m.insuranceUsd);
      out.push({ marketId: m.marketId, trader, action: "liquidate", rewardUsd, equityUsd, requirementUsd: req, priceData: px.priceData });
    } else if (closeOut) {
      out.push({ marketId: m.marketId, trader, action: "forceClose", rewardUsd: 0n, equityUsd, requirementUsd: req, priceData: px.priceData });
    }
  }
  return out;
}

/** USD (6 dp) -> wei at an ETH/USD price (WAD). */
export const usdToWei = (usd6: bigint, ethUsdWad: bigint): bigint => (usd6 * 10n ** 30n) / ethUsdWad;

export interface GasPolicy {
  /** ETH/USD (WAD); 0 = unknown: only the caps apply */
  ethUsdWad: bigint;
  /** spend at most reward + this (USD 6 dp) */
  marginUsd: bigint;
  /** per-transaction cap (wei) */
  maxTxWei: bigint;
  /** rolling one-hour cap (wei) */
  hourlyWei: bigint;
}

/** The most a transaction of `rewardUsd` may cost (wei), given what the last hour already spent. */
export function gasAllowanceWei(policy: GasPolicy, rewardUsd: bigint, spentLastHourWei: bigint): bigint {
  const left = policy.hourlyWei > spentLastHourWei ? policy.hourlyWei - spentLastHourWei : 0n;
  let cap = policy.maxTxWei < left ? policy.maxTxWei : left;
  if (policy.ethUsdWad > 0n) {
    const byReward = usdToWei(rewardUsd + policy.marginUsd, policy.ethUsdWad);
    if (byReward < cap) cap = byReward;
  }
  return cap;
}

/** Rolling one-hour sum of keeper gas spent on liquidations. */
export class GasWindow {
  private entries: Array<{ at: number; wei: bigint }> = [];
  add(at: number, wei: bigint) {
    this.entries.push({ at, wei });
  }
  spent(now: number): bigint {
    this.entries = this.entries.filter((e) => now - e.at < 3_600_000);
    return this.entries.reduce((a, e) => a + e.wei, 0n);
  }
}

export type SendOutcome = "sent" | "raced" | "price" | "gas_guard" | "failed";

/** A revert name -> what it means for the keeper. NotLiquidatable / NoPosition: someone else was first (or the price moved). */
export function classifyRevert(errorName: string | undefined, message: string): Exclude<SendOutcome, "sent" | "gas_guard"> {
  const s = `${errorName ?? ""} ${message}`;
  if (/NotLiquidatable|NoPosition/.test(s)) return "raced";
  if (/StalePrice|OffHours|BadSigner|FuturePrice|CloseOutNotOpen|NoPrice|SplitWindow/.test(s)) return "price";
  return "failed";
}

/** Positions found actionable, with since when and why they are still open (status backlog). */
export class Backlog {
  private items = new Map<string, LiquidationBacklogItem>();
  private key = (marketId: number, trader: string) => `${marketId}|${trader.toLowerCase()}`;

  /** Keeps the actionable ones (their `since` survives), drops the rest. */
  observe(actions: KeeperAction[], now: number) {
    const keep = new Map<string, LiquidationBacklogItem>();
    for (const a of actions) {
      const k = this.key(a.marketId, a.trader);
      const prev = this.items.get(k);
      keep.set(k, prev && prev.action === a.action ? prev : { marketId: a.marketId, trader: a.trader.toLowerCase(), action: a.action, since: now, reason: "pending", detail: null });
    }
    this.items = keep;
  }

  set(marketId: number, trader: string, reason: BacklogReason, detail: string | null) {
    const it = this.items.get(this.key(marketId, trader));
    if (it) {
      it.reason = reason;
      it.detail = detail;
    }
  }

  done(marketId: number, trader: string) {
    this.items.delete(this.key(marketId, trader));
  }

  list(): LiquidationBacklogItem[] {
    return [...this.items.values()].sort((a, b) => a.since - b.since);
  }
}
