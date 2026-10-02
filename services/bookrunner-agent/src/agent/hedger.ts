// Hedge executor: snapshot desk + registry + oracle state, run the pure planner, execute the legs as
// desk actions (InventoryToVault(MM) -> FundDesk -> Hedge buys, Hedge sells, Flatten, ReturnToVault),
// persist hedges rows + receipt leaves. A failed leg aborts the rest of the cycle; the next cycle
// re-plans from chain state.

import { ACCOUNT, HEDGE_VENUES, type Logger, type Mandate, bytes32ToStr } from "@bookrunner/shared";
import { bookrunnerDeskAbi } from "@bookrunner/shared/abi";
import { type Address, type Hex, type TransactionReceipt, parseEventLogs } from "viem";
import type { AgentStore } from "../adapters/store";
import type { OraclePoint, StockTokenInfo } from "../chain/book-chain";
import { encodeFlatten, encodeFundDesk, encodeHedge, encodeInventoryToVault, encodeReturnToVault } from "../chain/desk-actions";
import type { DeskRunner } from "../chain/desk-client";
import { type HedgeComponent, type HedgeMode, type HedgePlan, type HedgePlannerConfig, type MmRecallInfo, componentsValueUsd, planHedge } from "../domain/hedge-planner";
import type { HedgeUniverse } from "../domain/hedge-universe";
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

  async cycle(ctx: HedgeCycleContext): Promise<HedgePlan> {
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
    this.d.log.info(summary, "hedge: executing plan");
    await this.execute(plan, comps);
    return plan;
  }

  private async record(action: "buy" | "sell" | "flatten", comp: HedgeComponent, qtyRaw: bigint, amountIn: bigint, amountOut: bigint, valueUsd: bigint, txHash: Hex): Promise<void> {
    const ts = this.now();
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

  private async execute(plan: HedgePlan, comps: HedgeComponent[]): Promise<void> {
    const byToken = new Map(comps.map((c) => [c.token.toLowerCase(), c]));
    for (const leg of plan.legs) {
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
