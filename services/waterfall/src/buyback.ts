// Protocol keeper duty, once per pass (KEEPER role): BkrnFeeRouter.executeBuyback when buybackPending has
// reached the threshold, so carry's buyback half reaches BKRN stakers. Idempotent (it re-reads
// buybackPending every pass; a landed buyback drops it below the threshold, or by maxBuybackPerCall) and
// failure-tolerant (a failed read or tx is logged and retried after the cooldown). The fee router bounds
// the price on-chain (pinned pool fee, reference-price floor, per-call cap); the keeper reads that bound
// and only tightens it (domain/buyback.ts).
import type { Logger } from "@bookrunner/shared";
import { bkrnFeeRouterAbi } from "@bookrunner/shared/abi";
import { type BuybackPlan, type BuybackPolicy, type BuybackReferenceSource, V4_SIZE_DEPENDENT, backoffMs, buybackAmount, buybackDue, halveSize, planBuyback, v4MinOut } from "./domain/buyback";
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
  /** v4 venue: size cap after size-dependent failures (null = maxBuybackPerCall) and the consecutive failure count. */
  private v4Cap: bigint | null = null;
  private v4Failures = 0;

  constructor(private readonly d: BuybackDeps) {}

  /** Current v4 size cap (tests / logs). */
  get v4SizeCap(): bigint | null {
    return this.v4Cap;
  }

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
      if (v4.venue === 1 && this.d.chain.previewBuyback) return await this.tickV4(log, pending, b.maxPerCall);
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

  /**
   * Uniswap v4 venue (review 2026-10-23): size = min(pending, maxBuybackPerCall, the halving cap); the router's
   * previewBuyback simulates the exact swap; minBkrnOut = simulated x (1 - slippage) x amountIn / spent (never only
   * the fixed floor); a failed / below-floor simulation sends nothing. A size-dependent failure (InsufficientOutput,
   * V4HopPartialFill, BuybackV4Failed, a failed simulation) halves the next size down to the threshold, with a
   * growing cooldown; any other failure keeps the plain cooldown; a success resets both.
   */
  private async tickV4(log: Logger, pending: bigint, maxPerCall: bigint): Promise<BuybackOutcome> {
    const chain = this.d.chain;
    let amountIn = buybackAmount(pending, maxPerCall);
    if (this.v4Cap !== null && amountIn > this.v4Cap) amountIn = this.v4Cap;
    const reference = await this.referenceSource();
    let sim: { usdcIn: bigint; bkrnOut: bigint };
    let floor: bigint;
    try {
      sim = await (chain.previewBuyback as NonNullable<typeof chain.previewBuyback>)(amountIn);
      if (sim.usdcIn === 0n || sim.bkrnOut === 0n) return this.v4Fail(log, "simulation", amountIn, "v4 swap fails in simulation (caught in the unlock); not sent");
      floor = await chain.buybackFloor(sim.usdcIn);
    } catch (err) {
      return this.v4Fail(log, describeRevert(err, bkrnFeeRouterAbi).errorName ?? "error", amountIn, "v4 buyback simulation reverted; not sent", err);
    }
    if (sim.bkrnOut < floor) return this.v4Fail(log, "InsufficientOutput", amountIn, "simulated v4 output below the on-chain floor; not sent");
    const minOut = v4MinOut(sim.bkrnOut, sim.usdcIn, amountIn, this.d.policy.slippageBps);
    const plan = { kind: "buy" as const, amountIn, quote: sim.bkrnOut, minOut, floor, priceSource: "router" as const };
    try {
      const r = await chain.executeBuyback(amountIn, minOut);
      if (r.v4Outcome || r.bkrnOut === null) {
        // landed but did not swap: a caught hook / pool revert (size-dependent), no fill, or the route went away
        const kind = r.v4Outcome === "failed" ? "BuybackV4Failed" : (r.v4Outcome ?? "no BuybackExecuted");
        return this.v4Fail(log, kind, amountIn, "v4 buyback landed without swapping", undefined, r.hash, r.v4Reason ?? null);
      }
      this.v4Cap = null;
      this.v4Failures = 0;
      log.info({ tx: r.hash, usdcIn: usd6(r.usdcIn ?? 0n), bkrnOut: wad18(r.bkrnOut), simulated: wad18(sim.bkrnOut), minBkrnOut: wad18(minOut), floor: wad18(floor), reference }, "BKRN buyback executed (v4); streamed to stakers");
      return { status: "bought", tx: r.hash, plan, usdcIn: r.usdcIn, bkrnOut: r.bkrnOut, reference };
    } catch (err) {
      return this.v4Fail(log, describeRevert(err, bkrnFeeRouterAbi).errorName ?? "error", amountIn, "executeBuyback (v4) failed", err);
    }
  }

  private v4Fail(log: Logger, kind: string, amountIn: bigint, msg: string, err?: unknown, tx?: string, reason?: string | null): BuybackOutcome {
    this.v4Failures += 1;
    const sizeDependent = V4_SIZE_DEPENDENT.has(kind);
    if (sizeDependent) this.v4Cap = halveSize(amountIn, this.d.policy.thresholdUsd);
    const hold = sizeDependent ? backoffMs(this.d.cooldownMs, this.v4Failures) : this.d.cooldownMs;
    this.d.cooldowns.hold(KEY, hold);
    const info = err === undefined ? undefined : describeRevert(err, bkrnFeeRouterAbi);
    log.warn({ kind, tx: tx ?? null, reason: reason ?? null, revert: info ?? null, amountIn: usd6(amountIn), nextCap: this.v4Cap === null ? null : usd6(this.v4Cap), holdMs: hold }, msg);
    const why = info?.errorName ?? info?.reason ?? kind;
    return { status: "failed", error: kind === "BuybackV4Failed" && reason ? `v4 swap failed (${reason})` : `${msg}: ${why}` };
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
    const info = describeRevert(err, bkrnFeeRouterAbi);
    log.warn({ ...extra, revert: info }, msg);
    return { status: "failed", error: info.reason ?? info.errorName ?? info.message };
  }
}
