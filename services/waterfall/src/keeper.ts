// Keeper duties per book per tick (KEEPER role): closeWindow when due, fundClaims when claims are
// unfunded and the vault has idle cash, recall-before-mark when queued redemptions exceed idle,
// finalizeRetirement when the last applied mark carried zero deployed value.
import type { Logger } from "@bookrunner/shared";
import { type Cooldowns, canFinalizeRetirement, shouldCloseWindow, shouldFundClaims } from "./domain/keeper";
import { type RecallPlan, planRecall } from "./domain/recall";
import { usd6 } from "./kit/fmt";
import { nextMarkPeriodEnd, settlesUpToIndex } from "./kit/period";
import { describeRevert } from "./kit/tx";
import type { BookRef } from "./kit/books";
import type { KeeperChain, KeeperSnapshot } from "./ports";

export interface KeeperConfig {
  bufferBps: bigint;
  minRecallUsd: bigint;
  flatThresholdUsd: bigint;
  recallAllWhenRetiring: boolean;
  /** Hold after a failed action, and after a recall (venue state may lag). */
  cooldownMs: number;
}

export interface KeeperDeps {
  chain: KeeperChain;
  cooldowns: Cooldowns;
  cfg: KeeperConfig;
  log: Logger;
  /** Records a DECISION receipt for capital-moving keeper actions. */
  recordDecision?: (bookId: number, payload: Record<string, unknown>) => Promise<void>;
}

export type KeeperAction =
  | { kind: "closeWindow"; tx?: string; error?: string }
  | { kind: "fundClaims"; tx?: string; error?: string }
  | { kind: "recall"; account: number; amount: bigint; reason: string; tx?: string; error?: string }
  | { kind: "finalizeRetirement"; tx?: string; error?: string };

export class KeeperRunner {
  constructor(private readonly d: KeeperDeps) {}

  async tick(ref: BookRef): Promise<{ snapshot: KeeperSnapshot; plan: RecallPlan | null; actions: KeeperAction[] }> {
    const s = await this.d.chain.snapshot(ref);
    const actions: KeeperAction[] = [];
    const log = this.d.log.child({ bookId: ref.bookId });

    if (shouldCloseWindow(s.state, s.subscriptionEnds, s.nowSec)) {
      actions.push(await this.act(ref, "closeWindow", () => this.d.chain.closeWindow(ref), { kind: "closeWindow" }));
      return { snapshot: s, plan: null, actions }; // state changes; re-evaluate next tick
    }

    if (shouldFundClaims(s.state, s.unfundedClaims, s.vaultIdle)) {
      actions.push(await this.act(ref, "fundClaims", () => this.d.chain.fundClaims(ref), { kind: "fundClaims" }));
    }

    let plan: RecallPlan | null = null;
    if (s.state === "Live" || s.state === "Retiring") {
      const next = nextMarkPeriodEnd(s.nowSec, s.markInterval, s.lastMarkPeriodEnd);
      const dueShares = await this.d.chain.pendingRedemptions(ref, settlesUpToIndex(s.lastMarkPeriodEnd, s.markInterval), settlesUpToIndex(next, s.markInterval));
      plan = planRecall({
        state: s.state,
        dueShares,
        sharePriceWad: s.sharePriceWad,
        unfundedClaims: s.unfundedClaims,
        vaultIdle: s.vaultIdle,
        inTransit: s.inTransit,
        pendingWithdraw: s.pendingWithdraw,
        mmWithdrawable: s.mmWithdrawable,
        insuranceEquity: s.insuranceEquity,
        marginEquity: s.marginEquity,
        netExposure: s.netExposure,
        bufferBps: this.d.cfg.bufferBps,
        minRecallUsd: this.d.cfg.minRecallUsd,
        flatThresholdUsd: this.d.cfg.flatThresholdUsd,
        recallAllWhenRetiring: this.d.cfg.recallAllWhenRetiring,
      });
      if (plan.uncovered > 0n) {
        log.warn(
          { uncovered: usd6(plan.uncovered), due: usd6(plan.dueAssets), idle: usd6(s.vaultIdle), inTransit: usd6(s.inTransit), pendingWithdraw: usd6(s.pendingWithdraw), mmWithdrawable: s.mmWithdrawable === null ? null : usd6(s.mmWithdrawable) },
          "redemption liquidity short after recall capacity; claims are funded as capital comes back to the vault",
        );
      }
      for (const r of plan.recalls) {
        const key = `${ref.bookId}:recall:${r.account}`;
        if (!this.d.cooldowns.ready(key)) continue;
        const action = await this.act(ref, `recall:${r.account}`, () => this.d.chain.recall(ref, r.account, r.amount), { kind: "recall", account: r.account, amount: r.amount, reason: r.reason });
        this.d.cooldowns.hold(key, this.d.cfg.cooldownMs);
        actions.push(action);
        if (action.tx && this.d.recordDecision) {
          await this.d.recordDecision(ref.bookId, {
            type: "keeper.recall",
            bookId: ref.bookId,
            account: r.account === 0 ? "IF" : "MM",
            amountUsd: usd6(r.amount),
            reason: r.reason,
            nextMarkPeriodEnd: next,
            dueAssetsUsd: usd6(plan.dueAssets),
            bufferBps: Number(this.d.cfg.bufferBps),
            vaultIdleUsd: usd6(s.vaultIdle),
            inTransitUsd: usd6(s.inTransit),
            pendingWithdrawUsd: usd6(s.pendingWithdraw),
            unfundedClaimsUsd: usd6(s.unfundedClaims),
            txHash: action.tx,
          }).catch((err) => log.warn({ err }, "failed to record recall decision receipt"));
        }
      }
    }

    if (canFinalizeRetirement(s.state, s.lastMark)) {
      actions.push(await this.act(ref, "finalizeRetirement", () => this.d.chain.finalizeRetirement(ref), { kind: "finalizeRetirement" }));
    }
    return { snapshot: s, plan, actions };
  }

  private async act<A extends KeeperAction>(ref: BookRef, name: string, fn: () => Promise<string>, action: A): Promise<A & { tx?: string; error?: string }> {
    const key = `${ref.bookId}:${name}`;
    if (!this.d.cooldowns.ready(key)) return { ...action, error: "cooldown" };
    try {
      const tx = await fn();
      return { ...action, tx };
    } catch (err) {
      this.d.cooldowns.hold(key, this.d.cfg.cooldownMs);
      const info = describeRevert(err);
      this.d.log.warn({ bookId: ref.bookId, action: name, revert: info }, "keeper action failed; cooling down");
      return { ...action, error: info.reason ?? info.errorName ?? info.message };
    }
  }
}
