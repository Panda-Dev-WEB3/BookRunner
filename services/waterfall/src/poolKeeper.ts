// Protocol keeper duty, once per pass (2026-10 insurance pool): InsurancePool.processEpoch (anyone may call it) as
// soon as the oldest epoch is processable: ended, and every active pool-funded book marked after its end, or the
// grace passed (exits are never blocked). Several ended epochs are processed in one pass (bounded). The contracts need
// no other sync before an epoch ends: pool value moves only at book marks (Book.applyMark -> markBook), which the
// mark service sends every period; a retired book whose final mark failed is retried by the per-book keeper
// (Book.settleInsurance), so it leaves the epoch gate. Failure-tolerant: a failed read or tx is logged and retried
// after the cooldown.
import type { Logger } from "@bookrunner/shared";
import type { Hex } from "viem";
import type { Cooldowns } from "./domain/keeper";
import { type EpochPlan, type PoolQueueSnapshot, planEpoch } from "./domain/pool";
import { describeRevert } from "./kit/tx";

export interface PoolKeeperChain {
  /** The pool's queue at the latest block; null when the deployment has no InsurancePool. */
  poolQueue(): Promise<PoolQueueSnapshot | null>;
  processEpoch(): Promise<Hex>;
}

export interface PoolKeeperDeps {
  chain: PoolKeeperChain;
  cooldowns: Cooldowns;
  cooldownMs: number;
  log: Logger;
  /** Epochs processed per pass at most (default 4). */
  maxPerPass?: number;
}

export type PoolKeeperOutcome = { processed: Array<{ epoch: number; stale: boolean; tx: string }>; plan: EpochPlan | null; error?: string };

const KEY = "protocol:pool-epoch";

export class PoolKeeperRunner {
  /** last wait reason logged per epoch (logged once, not every pass) */
  private waitLogged = "";

  constructor(private readonly d: PoolKeeperDeps) {}

  async tick(): Promise<PoolKeeperOutcome> {
    const out: PoolKeeperOutcome = { processed: [], plan: null };
    if (!this.d.cooldowns.ready(KEY)) return out;
    const log = this.d.log.child({ duty: "pool-epoch" });
    for (let i = 0; i < (this.d.maxPerPass ?? 4); i++) {
      let snap: PoolQueueSnapshot | null;
      try {
        snap = await this.d.chain.poolQueue();
      } catch (err) {
        return this.fail(out, log, err, "pool queue read failed; retrying after the cooldown");
      }
      if (!snap) return out;
      const plan = planEpoch(snap);
      out.plan = plan;
      if (plan.kind === "wait") {
        const k = `${plan.epoch}:${plan.reason}`;
        if (plan.reason === "awaiting_marks" && this.waitLogged !== k) {
          this.waitLogged = k;
          log.info(
            { epoch: plan.epoch, endedAt: snap.procEndsAt, staleBooks: snap.staleBookIds, graceEndsAt: plan.until },
            "insurance pool epoch ended; waiting for the pool-funded books' marks after its end (or the grace)",
          );
        }
        return out;
      }
      try {
        const tx = await this.d.chain.processEpoch();
        out.processed.push({ epoch: plan.epoch, stale: plan.stale, tx });
        log[plan.stale ? "warn" : "info"](
          { epoch: plan.epoch, tx, stale: plan.stale, ...(plan.stale ? { staleBooks: snap.staleBookIds } : {}) },
          plan.stale ? "insurance pool epoch processed after the grace with books not marked since its end" : "insurance pool epoch processed",
        );
      } catch (err) {
        return this.fail(out, log, err, "processEpoch failed; retrying after the cooldown", { epoch: plan.epoch });
      }
    }
    return out;
  }

  private fail(out: PoolKeeperOutcome, log: Logger, err: unknown, msg: string, extra: Record<string, unknown> = {}): PoolKeeperOutcome {
    this.d.cooldowns.hold(KEY, this.d.cooldownMs);
    const info = describeRevert(err);
    log.warn({ ...extra, revert: info }, msg);
    return { ...out, error: info.reason ?? info.errorName ?? info.message };
  }
}
