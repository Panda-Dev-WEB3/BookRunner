// Protocol keeper duty, once per pass (KEEPER role): BkrnFeeRouter.executeBuyback when buybackPending has
// reached the threshold, so carry's buyback half reaches BKRN stakers. Idempotent (it re-reads
// buybackPending every pass; a landed buyback drops it below the threshold, or by maxBuybackPerCall) and
// failure-tolerant (a failed read or tx is logged and retried after the cooldown). The fee router bounds
// the price on-chain (pinned pool fee, reference-price floor, per-call cap); the keeper reads that bound
// and only tightens it (domain/buyback.ts).
import type { Logger } from "@bookrunner/shared";
import { type BuybackPlan, type BuybackPolicy, type BuybackReferenceSource, buybackAmount, buybackDue, planBuyback } from "./domain/buyback";
import type { Cooldowns } from "./domain/keeper";
import { usd6, wad18 } from "./kit/fmt";
import { describeRevert } from "./kit/tx";
import type { BuybackChain } from "./ports";

export interface BuybackDeps {
  chain: BuybackChain;
  policy: BuybackPolicy;
  cooldowns: Cooldowns;
  /** Hold after a failed read or tx. */
  cooldownMs: number;
  log: Logger;
}

export type BuybackOutcome =
  | { status: "skipped"; reason: string }
  | { status: "bought"; tx: string; plan: Extract<BuybackPlan, { kind: "buy" }>; usdcIn: bigint | null; bkrnOut: bigint | null; reference: BuybackReferenceSource }
  | { status: "failed"; error: string };

const KEY = "protocol:buyback";

export class BuybackRunner {
  constructor(private readonly d: BuybackDeps) {}

  async tick(): Promise<BuybackOutcome> {
    if (!this.d.cooldowns.ready(KEY)) return { status: "skipped", reason: "cooldown" };
    const log = this.d.log.child({ duty: "buyback" });
    let plan: BuybackPlan;
    let legacy = false;
    let reference: BuybackReferenceSource = "unknown";
    try {
      const pending = await this.d.chain.buybackPending();
      if (!buybackDue(pending, this.d.policy.thresholdUsd)) return { status: "skipped", reason: "below threshold" };
      const v4 = this.d.chain.buybackV4State ? await this.d.chain.buybackV4State() : { venue: 0, ready: false };
      if (v4.venue === 1 && !v4.ready) {
        // Uniswap v4 venue before BKRN graduates (no route / pool yet): the router would defer; send nothing
        this.d.cooldowns.hold(KEY, this.d.cooldownMs);
        log.info({ pending: usd6(pending) }, "buyback deferred: v4 venue without a live route (BKRN not graduated yet)");
        return { status: "skipped", reason: "v4 route not live" };
      }
      const b = await this.d.chain.buybackBounds();
      legacy = b.legacy;
      const amountIn = buybackAmount(pending, b.maxPerCall);
      let quote: bigint | null = null;
      try {
        quote = await this.d.chain.quoteBuyback(amountIn);
      } catch (err) {
        log.debug({ err: err instanceof Error ? err.message.split("\n")[0] : String(err) }, "buyback router quote failed; trying the fallback price");
      }
      // reverts (-> failed + cooldown) when the router's reference price is unset, the oracle is stale, or
      // (TWAP source) the pool's spot tick deviates from the mean / its history is shorter than the window
      const floor = legacy ? 0n : await this.d.chain.buybackFloor(amountIn);
      reference = legacy ? "legacy" : await this.referenceSource();
      plan = planBuyback(pending, quote, this.d.policy, { maxPerCall: b.maxPerCall, floor });
    } catch (err) {
      return this.fail(log, err, "buyback check failed; retrying after the cooldown");
    }
    if (plan.kind === "skip") {
      if (plan.reason !== "below threshold") {
        this.d.cooldowns.hold(KEY, this.d.cooldownMs);
        log.warn({ reason: plan.reason, reference }, "buyback due but not sent");
      }
      return { status: "skipped", reason: plan.reason };
    }
    try {
      const r = await this.d.chain.executeBuyback(plan.amountIn, plan.minOut, legacy ? this.d.policy.poolFee : undefined);
      if (r.v4Outcome) {
        // the tx landed but nothing swapped (a hook / pool revert caught on-chain, or the route went away)
        this.d.cooldowns.hold(KEY, this.d.cooldownMs);
        log.warn({ tx: r.hash, outcome: r.v4Outcome, reason: r.v4Reason ?? null, amountIn: usd6(plan.amountIn) }, "v4 buyback did not swap; retrying after the cooldown");
        return { status: "failed", error: r.v4Outcome === "failed" ? `v4 swap failed${r.v4Reason ? ` (${r.v4Reason})` : ""}` : "v4 buyback deferred" };
      }
      log.info(
        { tx: r.hash, usdcIn: usd6(r.usdcIn ?? plan.amountIn), bkrnOut: r.bkrnOut === null ? null : wad18(r.bkrnOut), minBkrnOut: wad18(plan.minOut), floor: wad18(plan.floor), priceSource: plan.priceSource, reference, legacy },
        "BKRN buyback executed; streamed to stakers",
      );
      return { status: "bought", tx: r.hash, plan, usdcIn: r.usdcIn, bkrnOut: r.bkrnOut, reference };
    } catch (err) {
      return this.fail(log, err, "executeBuyback failed; retrying after the cooldown", { amountIn: usd6(plan.amountIn), minBkrnOut: wad18(plan.minOut) });
    }
  }

  /** The router's reference source; a read failure (or a chain without the read) is "unknown", never fatal. */
  private async referenceSource(): Promise<BuybackReferenceSource> {
    const read = this.d.chain.buybackReferenceSource;
    if (!read) return "unknown";
    try {
      return await read.call(this.d.chain);
    } catch {
      return "unknown";
    }
  }

  private fail(log: Logger, err: unknown, msg: string, extra: Record<string, unknown> = {}): BuybackOutcome {
    this.d.cooldowns.hold(KEY, this.d.cooldownMs);
    const info = describeRevert(err);
    log.warn({ ...extra, revert: info }, msg);
    return { status: "failed", error: info.reason ?? info.errorName ?? info.message };
  }
}
