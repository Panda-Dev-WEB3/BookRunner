// Hedge planner (pure). Keeps hedgeRatioBps (shared mandate.ts) inside [hedgeRatioMinBps,
// hedgeRatioMaxBps] with desk legs, under the mandate rules the contracts enforce:
//   - Spot Stock Tokens are long-only: a spot hedge only offsets a SHORT venue exposure. With long or
//     flat venue exposure any held spot adds to the book's net long, so it is flattened and the
//     quoting skew does the work (perp hedges on allow-listed venues behind a feature flag).
//   - Buys need desk USDC: FundDesk first (vault -> desk) within the FundDesk cap
//     (desk value after <= maxInventoryUsd * hedgeRatioMaxBps / 1e4). Never off-hours / reduce-only.
//   - FundDesk is also capped by vault.deployable() (UnderwritingVault.fundDesk reverts
//     InsufficientIdle above it). closeWindow deploys the whole raise (IF + MM), so the vault is
//     ~empty on a live book: the shortfall is first recalled from the MM account with a desk
//     InventoryToVault leg. Engine recalls are synchronous (recall -> FundDesk -> buy in one plan,
//     bounded by the engine's withdrawable pool cash); Orderly recalls are asynchronous (plan the
//     recall alone, buy on a later cycle once the funds reach the vault; never re-recall while a
//     withdrawal to the vault is in flight).
//   - Post-trade holdings <= registry floatCapRaw per token (FloatCapExceeded on-chain).
//   - Off-hours with noNewRiskOffHours (and reduce-only mode): a leg must reduce |exposure + hedge|.
//   - Every planned spot leg is pre-checked with checkHedgeLeg() (same rule as MMMandate.checkHedge).
// Index books hedge with the weighted basket of their component tokens.
// Hysteresis (simulated trader flow swings exposure within minutes; every leg is a desk tx):
//   - inside the band nothing trades; out of band the hedge goes back to the band midpoint (the
//     deadband is the whole band, so a fix is never followed by another one at the opposite edge
//     unless exposure itself moved by more than the band allows);
//   - a trim the band does not require (exposure below the enforcement threshold, or long exposure
//     a spot hedge cannot offset) waits until the hedge exceeds what the band allows by minTradeUsd;
//   - legs under minLegUsd are skipped, plans under minTradeUsd are dropped;
//   - reversal hold: a plan that reverses the last executed trade direction (sell after buy, buy after
//     sell) waits reverseHoldMs, unless the ratio is out of an enforced band (safety always wins) or
//     the mode / off-hours rule asks for risk reduction.

import { type Mandate, BPS, absBig, checkHedgeLeg, hedgeBandOk, hedgeInBand, hedgeRatioBps, maxBig, minBig } from "@bookrunner/shared";
import type { Address, Hex } from "viem";

const E12 = 10n ** 12n;
const WAD = 10n ** 18n;

export interface HedgeComponent {
  token: Address;
  /** Allow-list asset id: tokenUnderlying(token). */
  assetId: Hex;
  /** Basket weight (single-token books: 10000). */
  weightBps: number;
  decimals: number;
  /** Oracle price per share of the equity (WAD). */
  priceWad: bigint;
  /** Shares of the equity per whole token (WAD). */
  multiplierWad: bigint;
  balanceRaw: bigint;
  floatCapRaw: bigint;
  /** Allow-list proof for (assetId, venue). */
  proof: Hex[];
}

/** normal: keep the band; reduce_only: only legs reducing |exposure + hedge|; flatten: sell everything; off: nothing. */
export type HedgeMode = "normal" | "reduce_only" | "flatten" | "off";

export interface HedgePlannerConfig {
  minTradeUsd: bigint;
  slippageBps: number;
  /** Ratio to rebalance to once out of band; defaults to the band midpoint. Clamped into the band. */
  targetRatioBps?: number;
  perpEnabled: boolean;
  /**
   * When flattening (Retiring), desk USDC above this is returned to the vault. Default 0: any
   * residue blocks finalizeRetirement (the final mark must carry deployedValueUsd == 0).
   */
  returnDustUsd: bigint;
  /** Per-leg dust floor for normal / reduce-only legs (default 1 USD). Retiring uses RETIRE_FLATTEN_MIN_USD. */
  minLegUsd?: bigint;
  /**
   * Minimum time (ms) between trades in opposite directions (buy after sell, sell after buy) when the
   * reversal is not needed to bring an enforced band back in range. 0 / absent: no hold.
   */
  reverseHoldMs?: number;
}

/** Direction of the last executed spot hedge trade (buy legs: buy; sell / flatten legs: sell). */
export interface LastHedgeTrade {
  side: "buy" | "sell";
  atMs: number;
}

/** What a desk InventoryToVault(MM) can bring to the vault right now. */
export interface MmRecallInfo {
  /** Max MM recall that should succeed now (engine: withdrawable pool cash; Orderly: free margin). */
  recallableUsd: bigint;
  /** Requested or confirmed withdrawals not yet in the vault (Orderly); 0 on the engine. */
  inFlightUsd: bigint;
  /** Engine: the recall settles in the same call, so FundDesk can follow in the same plan. */
  sync: boolean;
}

export interface HedgePlanInput {
  mandate: Mandate;
  netExposureUsd: bigint;
  /** desk.hedgeNotionalUsd(): long spot inventory value. */
  deskHedgeUsd: bigint;
  /** Signed perp hedge notional on allow-listed venues (negative = short). 0 when disabled. */
  perpHedgeUsd: bigint;
  deskUsdcUsd: bigint;
  /** desk.valueUsd(): USDC + token inventory. */
  deskValueUsd: bigint;
  /** vault.deployable(): the most FundDesk can move (InsufficientIdle above it). */
  vaultDeployableUsd: bigint;
  /** MM recall capacity; absent -> no recall is planned (NO_VAULT_IDLE). */
  mmRecall?: MmRecallInfo;
  components: HedgeComponent[];
  offHours: boolean;
  mode: HedgeMode;
  /** A perp venue pair is present in the allow-list. */
  perpAllowed: boolean;
  /**
   * Legs that ADD hedge are allowed (default true). False when the venue valuation behind
   * adapter.netExposureUsd() is older than maxPriceAge * 4 (Orderly report lag): only reducing legs.
   */
  allowAddHedge?: boolean;
  /** Last executed spot trade (reversal hold); absent: none known. */
  lastTrade?: LastHedgeTrade | null;
  /** Clock for the reversal hold (ms). Required for the hold to apply. */
  nowMs?: number;
}

export type HedgeLeg =
  | { kind: "recall_mm"; amountUsd: bigint }
  | { kind: "fund_desk"; amountUsd: bigint }
  | { kind: "buy"; token: Address; assetId: Hex; amountInUsd: bigint; expectedOutRaw: bigint; minAmountOutRaw: bigint; notionalUsd: bigint; proof: Hex[] }
  | { kind: "sell"; token: Address; assetId: Hex; amountInRaw: bigint; minAmountOutUsd: bigint; notionalUsd: bigint; proof: Hex[] }
  | { kind: "flatten"; token: Address; assetId: Hex; amountInRaw: bigint; minAmountOutUsd: bigint; notionalUsd: bigint }
  | { kind: "return_to_vault"; amountUsd: bigint | "all" }
  | { kind: "perp"; notionalUsd: bigint };

export interface HedgePlan {
  action: "none" | "buy" | "sell" | "flatten" | "perp" | "recall";
  reason: string;
  ratioBefore: bigint | null;
  ratioAfter: bigint | null;
  targetHedgeUsd: bigint;
  legs: HedgeLeg[];
}

/** USD (6dp) value of qtyRaw — mirrors StockTokenRegistry.valueUsd (multiplier applied once). */
export function valueUsdOf(qtyRaw: bigint, priceWad: bigint, multiplierWad: bigint, decimals: number): bigint {
  return (qtyRaw * multiplierWad * priceWad) / (10n ** BigInt(decimals) * WAD) / E12;
}

/** Inverse of valueUsdOf (floor): raw token quantity worth `usd`. */
export function qtyForUsd(usd: bigint, priceWad: bigint, multiplierWad: bigint, decimals: number): bigint {
  const denom = multiplierWad * priceWad;
  if (denom === 0n) return 0n;
  return (usd * E12 * 10n ** BigInt(decimals) * WAD) / denom;
}

const applyBps = (x: bigint, bps: bigint) => (x * bps) / BPS;

/**
 * Retiring (flatten mode) sells every token position worth at least this (USD 6dp = 0.001 USD):
 * Book.finalizeRetirement needs a final mark with deployedValueUsd == 0, so the 1 USD per-leg dust
 * floor does not apply. Below this a swap can round under the desk's maxSlippageBps check; the mark
 * service values such residue at 0 for Retiring books (mark MARK_RETIRE_TOKEN_DUST_USD, same value).
 */
export const RETIRE_FLATTEN_MIN_USD = 1_000n;

function none(reason: string, ratioBefore: bigint | null, targetHedgeUsd: bigint): HedgePlan {
  return { action: "none", reason, ratioBefore, ratioAfter: ratioBefore, targetHedgeUsd, legs: [] };
}

function flattenLegs(components: HedgeComponent[], slipBps: bigint, minLegUsd: bigint): HedgeLeg[] {
  const legs: HedgeLeg[] = [];
  for (const c of components) {
    if (c.balanceRaw <= 0n) continue;
    const value = valueUsdOf(c.balanceRaw, c.priceWad, c.multiplierWad, c.decimals);
    if (value < minLegUsd) continue;
    legs.push({
      kind: "flatten",
      token: c.token,
      assetId: c.assetId,
      amountInRaw: c.balanceRaw,
      minAmountOutUsd: applyBps(value, BPS - slipBps),
      notionalUsd: value,
    });
  }
  return legs;
}

/** Spot hedge value actually held (sum over components) — used when desk notional is unavailable. */
export function componentsValueUsd(components: HedgeComponent[]): bigint {
  return components.reduce((s, c) => s + valueUsdOf(c.balanceRaw, c.priceWad, c.multiplierWad, c.decimals), 0n);
}

/** Direction a plan trades the spot hedge in (null: no spot trade). */
export function planSide(plan: HedgePlan): "buy" | "sell" | null {
  if (plan.action === "buy") return "buy";
  if (plan.action === "sell" || plan.action === "flatten") return plan.legs.some((l) => l.kind === "sell" || l.kind === "flatten") ? "sell" : null;
  return null;
}

/** Remaining reversal hold (ms) for a plan trading `side`; 0 when none applies. */
export function reversalHoldRemainingMs(side: "buy" | "sell" | null, inp: Pick<HedgePlanInput, "lastTrade" | "nowMs">, holdMs: number | undefined): number {
  const last = inp.lastTrade;
  if (!side || !last || inp.nowMs === undefined || !holdMs || holdMs <= 0 || last.side === side) return 0;
  return Math.max(0, last.atMs + holdMs - inp.nowMs);
}

export function planHedge(inp: HedgePlanInput, cfg: HedgePlannerConfig): HedgePlan {
  const plan = planCore(inp, cfg);
  const remaining = reversalHoldRemainingMs(planSide(plan), inp, cfg.reverseHoldMs);
  if (remaining <= 0) return plan;
  const m = inp.mandate;
  // safety wins: never hold while an enforced band is breached, nor when risk reduction is asked for
  // (reduce-only mode, off-hours no-new-risk, Retiring flatten)
  const hedge = inp.deskHedgeUsd > 0n ? inp.deskHedgeUsd : 0n;
  const canHedgeLong = cfg.perpEnabled && inp.perpAllowed;
  if (!hedgeBandOk(m, inp.netExposureUsd, hedge, canHedgeLong)) return plan;
  if (inp.mode !== "normal" || (inp.offHours && m.noNewRiskOffHours)) return plan;
  return none("REVERSAL_HOLD", plan.ratioBefore, plan.targetHedgeUsd);
}

function planCore(inp: HedgePlanInput, cfg: HedgePlannerConfig): HedgePlan {
  const m = inp.mandate;
  const exp = inp.netExposureUsd;
  const hedge = inp.deskHedgeUsd > 0n ? inp.deskHedgeUsd : 0n;
  const absExp = absBig(exp);
  const lo = BigInt(m.hedgeRatioMinBps);
  const hi = BigInt(m.hedgeRatioMaxBps);
  const targetBps = minBig(hi, maxBig(lo, cfg.targetRatioBps === undefined ? (lo + hi) / 2n : BigInt(Math.round(cfg.targetRatioBps))));
  const slip = BigInt(Math.max(0, Math.min(5_000, Math.round(cfg.slippageBps))));
  const ratioBefore = hedgeRatioBps(m, exp, hedge);
  const minLegUsd = maxBig(1_000_000n, cfg.minLegUsd ?? 0n); // dust floor per leg (>= 1 USD)
  const reduceRule = inp.mode === "reduce_only" || (inp.offHours && m.noNewRiskOffHours);
  const ruleMandate: Mandate = reduceRule ? { ...m, noNewRiskOffHours: true } : m;

  if (inp.mode === "off") return none("DISABLED", ratioBefore, hedge);
  if (inp.components.length === 0) return none("NO_HEDGE_UNIVERSE", ratioBefore, hedge);

  if (inp.mode === "flatten") {
    const legs = flattenLegs(inp.components, slip, RETIRE_FLATTEN_MIN_USD);
    const proceeds = legs.reduce((s, l) => s + (l.kind === "flatten" ? l.minAmountOutUsd : 0n), 0n);
    if (inp.deskUsdcUsd + proceeds > cfg.returnDustUsd) legs.push({ kind: "return_to_vault", amountUsd: "all" });
    if (legs.length === 0) return none("FLAT", ratioBefore, 0n);
    return { action: "flatten", reason: "FLATTEN_ALL", ratioBefore, ratioAfter: hedgeRatioBps(m, exp, 0n), targetHedgeUsd: 0n, legs };
  }

  // ---------------------------------------------------------------- long / flat venue exposure
  if (exp >= 0n) {
    if (hedge >= cfg.minTradeUsd) {
      // held spot only adds to the net long: flatten (always reduces |exposure + hedge|)
      const legs = flattenLegs(inp.components, slip, minLegUsd);
      if (legs.reduce((s, l) => s + (l.kind === "flatten" ? l.notionalUsd : 0n), 0n) >= cfg.minTradeUsd) {
        return { action: "flatten", reason: "LONG_EXPOSURE_NO_SPOT_HEDGE", ratioBefore, ratioAfter: hedgeRatioBps(m, exp, 0n), targetHedgeUsd: 0n, legs };
      }
    }
    if (ratioBefore !== null && cfg.perpEnabled && inp.perpAllowed) {
      // offsetting short perp on an allow-listed venue (feature flag)
      const desiredPerp = -applyBps(absExp, targetBps);
      const perpRatio = hedgeRatioBps(m, exp, inp.perpHedgeUsd < 0n ? inp.perpHedgeUsd : 0n);
      // hedgeRatioBps treats a negative hedge against long exposure as offsetting
      if (!hedgeInBand(m, perpRatio)) {
        const delta = desiredPerp - inp.perpHedgeUsd;
        const before = absBig(exp + inp.perpHedgeUsd);
        const after = absBig(exp + desiredPerp);
        if (absBig(delta) >= cfg.minTradeUsd && (!reduceRule || after < before)) {
          return { action: "perp", reason: "PERP_HEDGE_LONG_EXPOSURE", ratioBefore, ratioAfter: hedgeRatioBps(m, exp, desiredPerp), targetHedgeUsd: desiredPerp, legs: [{ kind: "perp", notionalUsd: delta }] };
        }
      }
    }
    return none(ratioBefore === null ? "BELOW_THRESHOLD" : "LONG_EXPOSURE_SKEW_ONLY", ratioBefore, 0n);
  }

  // ---------------------------------------------------------------- short venue exposure: spot offsets
  const targetHedge = applyBps(absExp, targetBps);
  let side: "buy" | "sell" | null = null;
  if (ratioBefore !== null) {
    if (ratioBefore < lo) side = "buy";
    else if (ratioBefore > hi) side = "sell";
    else return none("IN_BAND", ratioBefore, targetHedge);
  } else {
    // band not enforced below 5% of maxInventory: only trim a hedge that exceeds the band's upper
    // bound by at least minTradeUsd (deadband: a shrinking exposure does not trigger a ladder of trims)
    if (hedge - applyBps(absExp, hi) >= cfg.minTradeUsd) side = "sell";
    else return none("BELOW_THRESHOLD", ratioBefore, targetHedge);
  }

  if (side === "buy") {
    if (inp.allowAddHedge === false) return none("STALE_VENUE_VALUATION", ratioBefore, targetHedge);
    return planBuy(inp, cfg, { exp, hedge, targetHedge, ratioBefore, slip, reduceRule, ruleMandate, minLegUsd });
  }
  return planSell(inp, cfg, { exp, hedge, absExp, targetHedge, ratioBefore, slip, reduceRule, ruleMandate, minLegUsd });
}

interface Ctx {
  exp: bigint;
  hedge: bigint;
  targetHedge: bigint;
  ratioBefore: bigint | null;
  slip: bigint;
  reduceRule: boolean;
  ruleMandate: Mandate;
  minLegUsd: bigint;
}

function planBuy(inp: HedgePlanInput, cfg: HedgePlannerConfig, c: Ctx): HedgePlan {
  const m = inp.mandate;
  const delta = c.targetHedge - c.hedge;
  // FundDesk is an inventory move: never off-hours, never in reduce-only mode.
  const canFund = inp.mode === "normal" && !(inp.offHours && m.noNewRiskOffHours);
  const fundCap = applyBps(m.maxInventoryUsd, BigInt(m.hedgeRatioMaxBps));
  const fundRoom = maxBig(0n, fundCap - inp.deskValueUsd);
  const usdc = maxBig(0n, inp.deskUsdcUsd);
  // what FundDesk should move under the mandate cap, before the vault's idle cash is considered
  const want = canFund && usdc < delta ? minBig(delta - usdc, fundRoom) : 0n;
  const idle = maxBig(0n, inp.vaultDeployableUsd);
  let fund = minBig(want, idle);
  let recall = 0n;
  const rc = inp.mmRecall;
  if (want > idle && rc) {
    const shortfall = want - idle;
    if (rc.sync) {
      // engine: InventoryToVault settles in the call, FundDesk can use it in the same plan
      recall = minBig(shortfall, maxBig(0n, rc.recallableUsd));
      if (recall < c.minLegUsd) recall = 0n;
      fund = minBig(want, idle + recall);
    } else if (usdc + idle < cfg.minTradeUsd) {
      // Orderly: the recall lands asynchronously; ask for it now and buy on a later cycle
      if (rc.inFlightUsd > 0n) return none("RECALL_IN_FLIGHT", c.ratioBefore, c.targetHedge);
      const amount = minBig(shortfall, maxBig(0n, rc.recallableUsd));
      if (amount < cfg.minTradeUsd) return none("NO_VAULT_IDLE", c.ratioBefore, c.targetHedge);
      return { action: "recall", reason: "NO_VAULT_IDLE_RECALL_MM", ratioBefore: c.ratioBefore, ratioAfter: c.ratioBefore, targetHedgeUsd: c.targetHedge, legs: [{ kind: "recall_mm", amountUsd: amount }] };
    }
  }
  const budget = usdc + fund;
  const buyUsd = minBig(delta, budget);
  if (buyUsd < cfg.minTradeUsd) {
    if (!canFund || usdc + fundRoom < cfg.minTradeUsd) return none("NO_BUDGET", c.ratioBefore, c.targetHedge);
    return none(want > idle + recall ? "NO_VAULT_IDLE" : "BELOW_MIN_TRADE", c.ratioBefore, c.targetHedge);
  }

  const legs: HedgeLeg[] = [];
  let total = 0n;
  const weightSum = inp.components.reduce((s, x) => s + BigInt(x.weightBps), 0n) || 1n;
  for (const comp of inp.components) {
    let notional = (buyUsd * BigInt(comp.weightBps)) / weightSum;
    // float cap: bound the worst-case (slippage-favourable) fill by the remaining float
    const remainingRaw = comp.floatCapRaw - comp.balanceRaw;
    if (remainingRaw <= 0n) continue;
    const maxNotional = applyBps(valueUsdOf(remainingRaw, comp.priceWad, comp.multiplierWad, comp.decimals), BPS * BPS / (BPS + c.slip));
    if (notional > maxNotional) notional = maxNotional;
    if (notional < c.minLegUsd) continue;
    const expectedOutRaw = qtyForUsd(notional, comp.priceWad, comp.multiplierWad, comp.decimals);
    if (expectedOutRaw <= 0n) continue;
    legs.push({
      kind: "buy",
      token: comp.token,
      assetId: comp.assetId,
      amountInUsd: notional,
      expectedOutRaw,
      minAmountOutRaw: applyBps(expectedOutRaw, BPS - c.slip),
      notionalUsd: notional,
      proof: comp.proof,
    });
    total += notional;
  }
  if (total < cfg.minTradeUsd) return none("FLOAT_CAP", c.ratioBefore, c.targetHedge);

  const after = c.hedge + total;
  const check = checkHedgeLeg(c.ruleMandate, c.exp, c.hedge, after, c.reduceRule, 100);
  if (!check.ok) return none(check.reason ?? "CHECK_FAILED", c.ratioBefore, c.targetHedge);

  fund = maxBig(0n, minBig(fund, total - usdc));
  // recall only what this FundDesk needs beyond the vault's idle cash
  recall = maxBig(0n, minBig(recall, fund - idle));
  if (fund > 0n) legs.unshift({ kind: "fund_desk", amountUsd: fund });
  if (recall > 0n) legs.unshift({ kind: "recall_mm", amountUsd: recall });
  return { action: "buy", reason: "UNDER_HEDGED", ratioBefore: c.ratioBefore, ratioAfter: hedgeRatioBps(m, c.exp, after), targetHedgeUsd: c.targetHedge, legs };
}

function planSell(inp: HedgePlanInput, cfg: HedgePlannerConfig, c: Ctx & { absExp: bigint }): HedgePlan {
  const m = inp.mandate;
  // reduce-only: never sell past net-flat (selling below |exposure| would grow |exposure + hedge|)
  const floor = c.reduceRule ? maxBig(c.targetHedge, minBig(c.hedge, c.absExp)) : c.targetHedge;
  const delta = c.hedge - floor;
  if (delta < cfg.minTradeUsd) return none("BELOW_MIN_TRADE", c.ratioBefore, c.targetHedge);

  const values = inp.components.map((x) => valueUsdOf(x.balanceRaw, x.priceWad, x.multiplierWad, x.decimals));
  const held = values.reduce((s, v) => s + v, 0n);
  if (held <= 0n) return none("NO_HOLDINGS", c.ratioBefore, c.targetHedge);
  const sellUsd = minBig(delta, held);

  const legs: HedgeLeg[] = [];
  let total = 0n;
  inp.components.forEach((comp, i) => {
    const v = values[i] ?? 0n;
    if (v <= 0n) return;
    // pro-rata to holdings value: keeps the basket composition
    const share = (sellUsd * v) / held;
    let amountInRaw = qtyForUsd(share, comp.priceWad, comp.multiplierWad, comp.decimals);
    if (amountInRaw > comp.balanceRaw) amountInRaw = comp.balanceRaw;
    const value = valueUsdOf(amountInRaw, comp.priceWad, comp.multiplierWad, comp.decimals);
    if (value < c.minLegUsd) return;
    legs.push({
      kind: "sell",
      token: comp.token,
      assetId: comp.assetId,
      amountInRaw,
      minAmountOutUsd: applyBps(value, BPS - c.slip),
      notionalUsd: value,
      proof: comp.proof,
    });
    total += value;
  });
  if (total < cfg.minTradeUsd) return none("BELOW_MIN_TRADE", c.ratioBefore, c.targetHedge);

  const after = c.hedge - total;
  const check = checkHedgeLeg(c.ruleMandate, c.exp, c.hedge, after, c.reduceRule, 100);
  if (!check.ok) return none(check.reason ?? "CHECK_FAILED", c.ratioBefore, c.targetHedge);
  return { action: "sell", reason: "OVER_HEDGED", ratioBefore: c.ratioBefore, ratioAfter: hedgeRatioBps(m, c.exp, after), targetHedgeUsd: c.targetHedge, legs };
}

/**
 * PoolEngine.withdrawLiquidity succeeds only for amount <= poolCash with poolEquity - amount >=
 * requiredPoolMargin. While traders hold positions a buffer (5% of the required margin + 1 USD)
 * absorbs price / funding drift between this read and the mined tx; a flat pool needs none.
 */
export function engineWithdrawableUsd(poolCashUsd: bigint, poolEquityUsd: bigint, requiredPoolMarginUsd: bigint): bigint {
  const buffer = requiredPoolMarginUsd > 0n ? requiredPoolMarginUsd / 20n + 1_000_000n : 0n;
  const headroom = poolEquityUsd - requiredPoolMarginUsd - buffer;
  return headroom > 0n ? minBig(poolCashUsd, headroom) : 0n;
}
