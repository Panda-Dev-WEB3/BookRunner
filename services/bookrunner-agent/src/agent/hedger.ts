// Hedge executor: snapshot desk + registry + oracle state, run the pure planner, execute the legs as
// desk actions (InventoryToVault(MM) -> FundDesk -> Hedge buys, Hedge sells, Flatten, ReturnToVault),
// persist hedges rows + receipt leaves. A failed leg aborts the rest of the cycle; the next cycle
// re-plans from chain state. The direction + time of the last executed trade feed the planner's
// reversal hold (seeded from the hedges table at startup, so a restart does not reset it). On
// shutdown (ctx.signal aborted) no new leg starts; the leg in flight finishes its receipt + record.
// Capital-flow legs (recall / FundDesk / ReturnToVault) are skipped while a mark is pending (the desk
// reverts MarkPending: they would void the period's mark) and retried on a later cycle.

import { ACCOUNT, HEDGE_VENUES, type Logger, type Mandate, bytes32ToStr } from "@bookrunner/shared";
import { bookrunnerDeskAbi } from "@bookrunner/shared/abi";
import { type Address, type Hex, type TransactionReceipt, parseEventLogs } from "viem";
import type { AgentStore } from "../adapters/store";
import type { OraclePoint, StockTokenInfo } from "../chain/book-chain";
import { encodeFlatten, encodeFundDesk, encodeHedge, encodeInventoryToVault, encodeReturnToVault } from "../chain/desk-actions";
import type { DeskRunner } from "../chain/desk-client";
import {
  type HedgeComponent,
  type HedgeMode,
  type HedgePlan,
  type HedgePlannerConfig,
  type LastHedgeTrade,
  type MmRecallInfo,
  componentsValueUsd,
  planHedge,
  reversalHoldRemainingMs,
} from "../domain/hedge-planner";
import type { HedgeUniverse } from "../domain/hedge-universe";
import { gateCapitalLegs, isCapitalLeg } from "../domain/mark-window";
import { hedgeReceipt } from "../domain/receipts";
import { errMsg } from "../util";

export interface HedgeChain {
  deskHedgeUsd(): Promise<bigint>;
  deskValueUsd(): Promise<bigint>;
  deskUsdc(): Promise<bigint>;
  tokenBalance(token: Address, owner: Address): Promise<bigint>;
  getToken(token: Address): Promise<StockTokenInfo>;
  oracleLatest(priceId: Hex): Promise<OraclePoint>;
  /** vault.deployable(): FundDesk reverts InsufficientIdle above it. */
  vaultDeployable(): Promise<bigint>;
  /** MM recall capacity for hedge funding (null/absent: never recall). */
  mmRecall?(): Promise<MmRecallInfo | null>;
  /**
   * Desk mark-window gate (BookrunnerDesk.capitalFlowOpen rule): false while a mark is pending, when
   * capital-flow legs must not be sent. Absent: always open. A failed read counts as closed.
   */
  capitalFlowOpen?(): Promise<boolean>;
}

/** Offsetting perp legs on an allow-listed venue (feature flag HEDGE_PERP_ENABLED). */
export interface PerpHedger {
  /** Signed perp hedge notional (negative = short). */
  positionUsd(): Promise<bigint>;
  /** Change the perp hedge by a signed notional. */
  hedge(deltaUsd: bigint): Promise<void>;
}

export interface HedgeCycleContext {
  mandate: Mandate;
  mode: HedgeMode;
  offHours: boolean;
  /** Venue exposure as the mandate sees it (adapter.netExposureUsd()). */
  netExposureUsd: bigint;
  /** False when the adapter valuation is too old for legs that add hedge. */
  allowAddHedge: boolean;
  /** Aborted on shutdown: no new leg starts (the one in flight completes and is recorded). */
  signal?: AbortSignal;
}

export interface HedgeCycleRunner {
  cycle(ctx: HedgeCycleContext): Promise<HedgePlan>;
}

export interface HedgerDeps {
  bookId: number;
  desk: Address;
  chain: HedgeChain;
  runner: DeskRunner;
  store: AgentStore;
  universe: HedgeUniverse;
  cfg: HedgePlannerConfig;
  poolFee: number;
  receiptsIntervalSec: number;
  log: Logger;
  now?: () => number;
  perp?: PerpHedger | null;
  /**
   * Orderly books (low-gas): relay the latest signed venue report before every hedge leg — MMMandate
   * band-checks buys and sells against the on-chain exposure, which otherwise only advances at marks.
   */
  beforeHedgeLeg?: () => Promise<void>;
  /**
   * Pull oracle: value the desk inventory from the snapshot (freshest signed prices) instead of the
   * on-chain desk views, which price at the stored oracle value and revert StalePrice once nothing
   * landed for maxPriceAge. Chain mode still falls back to it when a view reverts.
   */
  offchainValuation?: boolean;
}

export function parseHedgeExecuted(receipt: Pick<TransactionReceipt, "logs">, token: Address) {
  const evs = parseEventLogs({ abi: bookrunnerDeskAbi, eventName: "HedgeExecuted", logs: receipt.logs });
  const hit = evs.find((e) => e.args.token.toLowerCase() === token.toLowerCase());
  return hit ? { amountIn: hit.args.amountIn, amountOut: hit.args.amountOut, notionalUsd: hit.args.notionalUsd, buy: hit.args.buy } : null;
}

export class Hedger implements HedgeCycleRunner {
  private lastReason = "";
  private warnedAllowList = false;
  private warnedValuation = false;
  private markPendingLogged = false;
  private lastTrade: LastHedgeTrade | null = null;
  private seeded = false;
  private readonly now: () => number;

  constructor(private readonly d: HedgerDeps) {
    this.now = d.now ?? Date.now;
  }

  async snapshot(): Promise<HedgeComponent[]> {
    return Promise.all(
      this.d.universe.components.map(async (c) => {
        const [info, bal] = await Promise.all([this.d.chain.getToken(c.token), this.d.chain.tokenBalance(c.token, this.d.desk)]);
        const px = await this.d.chain.oracleLatest(info.priceId);
        return {
          token: c.token,
          assetId: c.assetId,
          weightBps: c.allowed && info.active ? c.weightBps : 0,
          decimals: info.decimals,
          priceWad: px.priceWad,
          multiplierWad: info.multiplierWad,
          balanceRaw: bal,
          floatCapRaw: info.floatCapRaw,
          proof: c.proof,
        };
      }),
    );
  }

  /** desk hedge notional + total value (USD 6dp): on-chain views, or the snapshot valued off-chain. */
  private async valuation(usdc: bigint, comps: HedgeComponent[]): Promise<{ hedge: bigint; value: bigint }> {
    const offchain = () => {
      const hedge = componentsValueUsd(comps);
      return { hedge, value: usdc + hedge };
    };
    if (this.d.offchainValuation) return offchain();
    try {
      const [hedge, value] = await Promise.all([this.d.chain.deskHedgeUsd(), this.d.chain.deskValueUsd()]);
      return { hedge, value };
    } catch (err) {
      if (!this.warnedValuation) {
        this.d.log.warn({ err: errMsg(err) }, "hedge: desk valuation views unavailable (stale stored price?); valuing the snapshot off-chain");
        this.warnedValuation = true;
      }
      return offchain();
    }
  }

  /** Last executed spot trade (reversal hold). */
  get lastTradeInfo(): LastHedgeTrade | null {
    return this.lastTrade;
  }

  /** Seed the reversal hold from the last persisted hedge row (once; best-effort). */
  private async seedLastTrade(): Promise<void> {
    if (this.seeded || !this.d.store.lastHedge) return;
    try {
      const last = await this.d.store.lastHedge(this.d.bookId);
      this.seeded = true;
      if (last && !this.lastTrade) this.lastTrade = { side: last.buy ? "buy" : "sell", atMs: last.ts };
    } catch (err) {
      this.d.log.debug({ err: errMsg(err) }, "hedge: last hedge row unavailable; reversal hold starts empty");
    }
  }

  async cycle(ctx: HedgeCycleContext): Promise<HedgePlan> {
    await this.seedLastTrade();
    const [usdc, comps, vaultDeployable, mmRecall] = await Promise.all([
      this.d.chain.deskUsdc(),
      this.snapshot(),
      this.d.chain.vaultDeployable(),
      this.d.chain.mmRecall
        ? this.d.chain.mmRecall().catch((err) => {
            this.d.log.warn({ err: errMsg(err) }, "hedge: MM recall capacity unavailable; no recall this cycle");
            return null;
          })
        : Promise.resolve(null),
    ]);
    const { hedge, value } = await this.valuation(usdc, comps);
    const perpUsd = this.d.cfg.perpEnabled && this.d.perp ? await this.d.perp.positionUsd() : 0n;
    const plan = planHedge(
      {
        mandate: ctx.mandate,
        netExposureUsd: ctx.netExposureUsd,
        deskHedgeUsd: hedge,
        perpHedgeUsd: perpUsd,
        deskUsdcUsd: usdc,
        deskValueUsd: value,
        vaultDeployableUsd: vaultDeployable,
        ...(mmRecall ? { mmRecall } : {}),
        components: comps,
        offHours: ctx.offHours,
        mode: ctx.mode,
        perpAllowed: this.d.universe.perpAllowed,
        allowAddHedge: ctx.allowAddHedge,
        lastTrade: this.lastTrade,
        nowMs: this.now(),
      },
      this.d.cfg,
    );
    const summary = {
      action: plan.action,
      reason: plan.reason,
      mode: ctx.mode,
      exposureUsd: ctx.netExposureUsd.toString(),
      hedgeUsd: hedge.toString(),
      vaultDeployableUsd: vaultDeployable.toString(),
      ratioBefore: plan.ratioBefore?.toString() ?? null,
      ratioAfter: plan.ratioAfter?.toString() ?? null,
      legs: plan.legs.map((l) => l.kind),
      ...(plan.reason === "REVERSAL_HOLD" && this.lastTrade
        ? { lastTrade: this.lastTrade.side, holdRemainingMs: reversalHoldRemainingMs(this.lastTrade.side === "buy" ? "sell" : "buy", { lastTrade: this.lastTrade, nowMs: this.now() }, this.d.cfg.reverseHoldMs) }
        : {}),
    };
    if (plan.action === "none") {
      if (plan.reason !== this.lastReason) this.d.log.info(summary, "hedge: no action");
      this.lastReason = plan.reason;
      return plan;
    }
    this.lastReason = plan.reason;
    const needsProof = plan.legs.some((l) => l.kind === "buy" || l.kind === "sell");
    if (needsProof && !this.d.universe.rootMatches) {
      if (!this.warnedAllowList) {
        this.d.log.warn({ computedRoot: this.d.universe.root, ...summary }, "hedge: allow-list pairs do not match mandate.hedgeAllowRoot; Hedge legs skipped (set HEDGE_ALLOW_PAIRS)");
        this.warnedAllowList = true;
      }
      return { ...plan, action: "none", reason: "ALLOW_LIST_MISMATCH", legs: [] };
    }
    const gated = await this.gateMarkWindow(plan, summary);
    if (gated.action === "none") return gated;
    return this.run(gated, comps, ctx, { ...summary, legs: gated.legs.map((l) => l.kind) });
  }

  /** Drop capital-flow legs while a mark is pending (logged once per pending window). */
  private async gateMarkWindow(plan: HedgePlan, summary: Record<string, unknown>): Promise<HedgePlan> {
    if (!this.d.chain.capitalFlowOpen || !plan.legs.some(isCapitalLeg)) return plan;
    const open = await this.d.chain.capitalFlowOpen().catch((err) => {
      this.d.log.warn({ err: errMsg(err) }, "hedge: mark-window state unavailable; capital-flow legs held this cycle");
      return false;
    });
    if (open) {
      this.markPendingLogged = false;
      return plan;
    }
    const { plan: gated, skipped } = gateCapitalLegs(plan, false);
    if (!this.markPendingLogged) {
      this.d.log.info({ ...summary, skipped, kept: gated.legs.map((l) => l.kind) }, "hedge: mark pending; capital-flow legs deferred until it lands");
      this.markPendingLogged = true;
    }
    this.lastReason = gated.reason;
    return gated;
  }

  private async run(plan: HedgePlan, comps: HedgeComponent[], ctx: HedgeCycleContext, summary: Record<string, unknown>): Promise<HedgePlan> {
    if (ctx.signal?.aborted) {
      this.d.log.info(summary, "hedge: shutting down; plan not started");
      return { ...plan, action: "none", reason: "SHUTDOWN", legs: [] };
    }
    this.d.log.info(summary, "hedge: executing plan");
    await this.execute(plan, comps, ctx.signal);
    return plan;
  }

  private async record(action: "buy" | "sell" | "flatten", comp: HedgeComponent, qtyRaw: bigint, amountIn: bigint, amountOut: bigint, valueUsd: bigint, txHash: Hex): Promise<void> {
    const ts = this.now();
    this.lastTrade = { side: action === "buy" ? "buy" : "sell", atMs: ts };
    const pxPerToken = (Number(comp.priceWad) / 1e18) * (Number(comp.multiplierWad) / 1e18);
    const venue = bytes32ToStr(HEDGE_VENUES.UNIV3);
    try {
      await this.d.store.insertHedge(
        {
          bookId: this.d.bookId,
          ts: new Date(ts),
          asset: comp.token.toLowerCase(),
          qtyRaw,
          px: pxPerToken,
          mult: Number(comp.multiplierWad) / 1e18,
          txHash,
          venue,
          valueUsd,
        },
        hedgeReceipt(
          { bookId: this.d.bookId, ts, action, token: comp.token.toLowerCase(), venue, qtyRaw, amountIn, amountOut, valueUsd, txHash },
          this.d.receiptsIntervalSec,
        ),
      );
    } catch (err) {
      this.d.log.warn({ txHash, err: errMsg(err) }, "hedge: persisting hedge row failed");
    }
  }

  private async execute(plan: HedgePlan, comps: HedgeComponent[], signal?: AbortSignal): Promise<void> {
    const byToken = new Map(comps.map((c) => [c.token.toLowerCase(), c]));
    for (const [i, leg] of plan.legs.entries()) {
      if (signal?.aborted) {
        // partial plan: the next cycle (after restart) re-plans from chain state
        this.d.log.info({ done: plan.legs.slice(0, i).map((l) => l.kind), skipped: plan.legs.slice(i).map((l) => l.kind) }, "hedge: shutting down; remaining legs skipped");
        return;
      }
      switch (leg.kind) {
        case "recall_mm": {
          await this.d.runner.run(encodeInventoryToVault(ACCOUNT.MM, leg.amountUsd), "InventoryToVault:MM");
          break;
        }
        case "fund_desk": {
          await this.d.runner.run(encodeFundDesk(leg.amountUsd), "FundDesk");
          break;
        }
        case "buy": {
          const comp = byToken.get(leg.token.toLowerCase());
          if (!comp) throw new Error(`hedge: unknown component ${leg.token}`);
          await this.d.beforeHedgeLeg?.();
          const r = await this.d.runner.run(
            encodeHedge({ token: leg.token, buy: true, amountIn: leg.amountInUsd, minAmountOut: leg.minAmountOutRaw, poolFee: this.d.poolFee, proof: leg.proof }),
            "Hedge:buy",
          );
          const ev = parseHedgeExecuted(r.receipt, leg.token);
          await this.record("buy", comp, ev?.amountOut ?? leg.expectedOutRaw, ev?.amountIn ?? leg.amountInUsd, ev?.amountOut ?? leg.expectedOutRaw, ev?.notionalUsd ?? leg.amountInUsd, r.hash);
          break;
        }
        case "sell":
        case "flatten": {
          const comp = byToken.get(leg.token.toLowerCase());
          if (!comp) throw new Error(`hedge: unknown component ${leg.token}`);
          // a token outside the allow-list cannot be sold via Hedge (no proof): Flatten is reduce-only and proof-free
          const allowed = this.d.universe.components.some((u) => u.allowed && u.token.toLowerCase() === leg.token.toLowerCase());
          const action =
            leg.kind === "sell" && allowed
              ? encodeHedge({ token: leg.token, buy: false, amountIn: leg.amountInRaw, minAmountOut: leg.minAmountOutUsd, poolFee: this.d.poolFee, proof: leg.proof })
              : encodeFlatten({ token: leg.token, amountIn: leg.amountInRaw, minAmountOut: leg.minAmountOutUsd, poolFee: this.d.poolFee });
          await this.d.beforeHedgeLeg?.();
          const r = await this.d.runner.run(action, leg.kind === "sell" ? "Hedge:sell" : "Flatten");
          const ev = parseHedgeExecuted(r.receipt, leg.token);
          const out = ev?.amountOut ?? leg.minAmountOutUsd;
          await this.record(leg.kind, comp, -(ev?.amountIn ?? leg.amountInRaw), ev?.amountIn ?? leg.amountInRaw, out, out, r.hash);
          break;
        }
        case "return_to_vault": {
          const amount = leg.amountUsd === "all" ? await this.d.chain.deskUsdc() : leg.amountUsd;
          if (amount > 0n) await this.d.runner.run(encodeReturnToVault(amount), "ReturnToVault");
          break;
        }
        case "perp": {
          if (!this.d.perp) {
            this.d.log.warn({ notionalUsd: leg.notionalUsd.toString() }, "hedge: perp leg planned but no perp hedge venue is configured (VERIFY venue integration)");
            break;
          }
          await this.d.perp.hedge(leg.notionalUsd);
          break;
        }
      }
    }
  }
}
