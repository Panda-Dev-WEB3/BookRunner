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
  /** bad debt the close would leave for the IF now (margin short of loss + funding); 0 = above water */
  badDebtUsd: bigint;
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
      const { rewardUsd, badDebtUsd } = liquidationRewardUsd(position, px.priceWad, m.fundingIndex, m.cfg.liquidationFeeBps, m.insuranceUsd);
      out.push({ marketId: m.marketId, trader, action: "liquidate", rewardUsd, badDebtUsd, equityUsd, requirementUsd: req, priceData: px.priceData });
    } else if (closeOut) {
      const { badDebtUsd } = liquidationRewardUsd(position, px.priceWad, m.fundingIndex, 0, m.insuranceUsd);
      out.push({ marketId: m.marketId, trader, action: "forceClose", rewardUsd: 0n, badDebtUsd, equityUsd, requirementUsd: req, priceData: px.priceData });
    }
  }
  return out;
}

/** USD (6 dp) -> wei at an ETH/USD price (WAD). */
export const usdToWei = (usd6: bigint, ethUsdWad: bigint): bigint => (usd6 * 10n ** 30n) / ethUsdWad;

/**
 * Gas policy (review I-3). What a liquidation is worth is its reward (to the keeper) and, for a position under water,
 * the bad debt it stops from growing (to the IF). The policy, per candidate (most at stake first):
 *   - PAYS for itself (cost <= reward): sent; it never uses the hourly budget, so liquidations that pay can never be
 *     starved by others;
 *   - DUST (reward < cost) above water: skipped. It owes no bad debt yet; once its loss eats the margin it is under
 *     water and qualifies below. A griefer opening many tiny positions therefore burns none of our gas;
 *   - UNDER WATER (bad debt > 0, or a forceClose the protocol needs): the cost must stay below what is at stake (bad
 *     debt + reward + margin) and the per-transaction cap; with bad debt >= `badDebtOverrideUsd` it is sent whatever the
 *     hourly budget; below that, while the hourly budget of loss-making gas lasts (the part of the cost above the
 *     reward); beyond it the position waits (backlog `gas_guard`, alerted after 60 s).
 * Reverted transactions count in full against the hourly budget. Without an ETH/USD price (testnet only: mainnet
 * refuses to start, config.ts) the reward cannot be compared: every transaction counts in full against the caps.
 * Risk bound: what the budget can hold back is under-water positions of less than `badDebtOverrideUsd` bad debt each,
 * for at most the rest of the hour; the IF covers them. Anything larger always goes out.
 */
export interface GasPolicy {
  /** ETH/USD (WAD); 0 = unknown (testnet): only the caps apply */
  ethUsdWad: bigint;
  /** a transaction may cost its reward plus this (USD 6 dp) */
  marginUsd: bigint;
  /** per-transaction cap (wei) */
  maxTxWei: bigint;
  /** rolling one-hour budget (wei) of the loss-making part of liquidations + reverted transactions */
  hourlyWei: bigint;
  /** an under-water position with at least this bad debt (USD 6 dp) is liquidated whatever the hourly budget */
  badDebtOverrideUsd: bigint;
}

export type GasDecision = { send: true; lossWei: bigint } | { send: false; reason: "dust" | "gas_guard"; detail: string };

/** Whether a liquidation / close-out of `a` may go out at `costWei`, given the loss budget already spent this hour. */
export function gasDecision(policy: GasPolicy, a: Pick<KeeperAction, "rewardUsd" | "badDebtUsd"> & { action?: KeeperAction["action"] }, costWei: bigint, spentLastHourWei: bigint): GasDecision {
  const left = policy.hourlyWei > spentLastHourWei ? policy.hourlyWei - spentLastHourWei : 0n;
  const override = a.badDebtUsd > 0n && a.badDebtUsd >= policy.badDebtOverrideUsd;
  if (costWei > policy.maxTxWei) return { send: false, reason: "gas_guard", detail: `cost ${costWei} wei > per-tx cap ${policy.maxTxWei} wei` };
  if (policy.ethUsdWad === 0n) {
    if (override) return { send: true, lossWei: costWei };
    if (costWei > left) return { send: false, reason: "gas_guard", detail: `hourly budget left ${left} wei < cost ${costWei} wei` };
    return { send: true, lossWei: costWei };
  }
  const rewardWei = usdToWei(a.rewardUsd, policy.ethUsdWad);
  if (costWei <= rewardWei) return { send: true, lossWei: 0n };
  const lossWei = costWei - rewardWei;
  const underWater = a.badDebtUsd > 0n || a.action === "forceClose";
  if (!underWater) return { send: false, reason: "dust", detail: `reward ${a.rewardUsd} usd6 below the cost ${costWei} wei, not under water` };
  const atStake = usdToWei(a.badDebtUsd + a.rewardUsd + policy.marginUsd, policy.ethUsdWad);
  if (costWei > atStake) return { send: false, reason: "gas_guard", detail: `cost ${costWei} wei above the ${a.badDebtUsd + a.rewardUsd} usd6 at stake + margin` };
  if (override) return { send: true, lossWei };
  if (lossWei > left) return { send: false, reason: "gas_guard", detail: `hourly loss budget left ${left} wei < ${lossWei} wei` };
  return { send: true, lossWei };
}

/** Candidate order: liquidations before close-outs, then the most at stake first (max of reward and bad debt). */
export function byStake(a: KeeperAction, b: KeeperAction): number {
  if (a.action !== b.action) return a.action === "liquidate" ? -1 : 1;
  const sa = a.rewardUsd > a.badDebtUsd ? a.rewardUsd : a.badDebtUsd;
  const sb = b.rewardUsd > b.badDebtUsd ? b.rewardUsd : b.badDebtUsd;
  return sb > sa ? 1 : sb < sa ? -1 : 0;
}

/** Rolling one-hour sum of the loss-making gas of liquidations (and reverted transactions). */
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

  /** A paged pass (review I-6): only the keys it read (`seen`) are re-observed; the other pages' items stay as they are. */
  merge(actions: KeeperAction[], now: number, seen: Set<string>) {
    const rest = [...this.items.entries()].filter(([k]) => !seen.has(k));
    this.observe(actions, now);
    for (const [k, v] of rest) if (!this.items.has(k)) this.items.set(k, v);
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
