// Per book per mark period: sweep fee flow into the RevenueRouter, then distribute(period, expenses).
// Idempotent per (book, period): settlements table first, then the router's Distributed(bookId, period)
// log, then a revert of distribute() re-checks the log ("already distributed").
//
// Skip empty work (docs/LOW_GAS.md §3/§4): no engine sweepFees tx when the engine accrued no fees, and no
// distribute tx when the router holds no fee flow (pendingGross == 0 after the sweeps: the venue settled
// nothing and no engine fees accrued) — a zero distribution is an on-chain no-op. The decision is
// recorded through SettlementSignals so the mark service marks the period at once instead of waiting
// for a distribution that will not happen. Fee flow arriving later rolls into the next period.
//
// Orderly: the FeesSwept earmark usually forwards nothing (the venue payout has not landed on the adapter
// yet); ops-venue's forwardPendingFees carries the USDC to the router seconds later. The runner waits for
// that forward (bounded, forwardWaitMs) so period P distributes P's own fees, not P-1's.
import { type DomainEventPayloads, type Logger, REVENUE_SOURCE, type SettlementJob, VENUE } from "@bookrunner/shared";
import type { Hex } from "viem";
import { amountsToSplit, conserves, parityCheck, previewDistribution, splitMismatches, type SplitResult } from "./domain/split";
import { distributes } from "./domain/keeper";
import type { DomainEventSink } from "./kit/events";
import { usd6 } from "./kit/fmt";
import { pollUntil, throwIfAborted } from "./kit/loop";
import type { SettlementSignals } from "./kit/signals";
import { describeRevert } from "./kit/tx";
import type { BookRef } from "./kit/books";
import type { BookLookup, DistributedLog, FeeForwarding, SettlementChain, SettlementStore, VenueOps } from "./ports";

export type SettlementOutcome =
  | { status: "already"; source: "db" | "chain"; txHash: string }
  | { status: "distributed"; txHash: Hex; split: SplitResult; previewMismatches: string[]; parityMismatches: string[] }
  | { status: "nothing_to_distribute"; reason: string }
  | { status: "skipped"; reason: string };

export interface SettlementDeps {
  books: BookLookup;
  chain: SettlementChain;
  store: SettlementStore;
  venueOps: VenueOps;
  events: DomainEventSink;
  /** expensesRequested for a book's next distribution (USD 6dp). */
  expensesFor: (bookId: number) => bigint;
  /** Called after a successful distribution with the expenses actually charged. */
  onDistributed?: (bookId: number, expensesCharged: bigint) => void;
  log: Logger;
  sweepWaitMs: number;
  /** Orderly: max wait, after the earmark, for the earmarked fees to reach the router (default 0: no wait). */
  forwardWaitMs?: number;
  pollMs: number;
  /** Where "nothing to distribute" decisions go (read by the mark scheduler). */
  signals?: SettlementSignals;
  /** Send distribute(period) even with pendingGross == 0 (pre-low-gas behaviour; default false). */
  distributeEmpty?: boolean;
  now?: () => number;
}

export const distributionDedupeKey = (bookId: number, period: number) => `distribution.paid:${bookId}:${period}`;

export function distributionPaidPayload(bookId: number, period: number, s: SplitResult, txHash: string): DomainEventPayloads["distribution.paid"] {
  return {
    bookId,
    period,
    grossUsd: usd6(s.gross),
    expensesUsd: usd6(s.expenses),
    carryUsd: usd6(s.carry),
    seniorUsd: usd6(s.senior),
    juniorUsd: usd6(s.junior),
    txHash,
  };
}

export class SettlementRunner {
  constructor(private readonly d: SettlementDeps) {}

  async run(job: SettlementJob, signal?: AbortSignal): Promise<SettlementOutcome> {
    const { bookId, period } = job;
    const log = this.d.log.child({ bookId, period });
    const ref = await this.d.books.get(bookId);
    if (!ref) return { status: "skipped", reason: "unknown book" };

    // 1. idempotency: DB, then chain
    const stored = await this.d.store.distributionFor(bookId, period);
    if (stored) {
      await this.publish(bookId, period, stored.amounts, stored.txHash);
      return { status: "already", source: "db", txHash: stored.txHash };
    }
    const onChain = await this.d.chain.findDistributed(ref, period);
    if (onChain) {
      await this.persist(onChain);
      log.info({ tx: onChain.txHash }, "distribution found on-chain; persisted");
      return { status: "already", source: "chain", txHash: onChain.txHash };
    }

    const state = await this.d.chain.bookState(ref);
    if (!distributes(state)) return { status: "skipped", reason: `book state ${state}` };

    // 2. sweep fee flow for the period
    throwIfAborted(signal);
    if (ref.venue === VENUE.ORDERLY) await this.sweepOrderly(ref, period, log, signal);
    else await this.sweepEngine(ref, period, log);

    // 3. distribute — only when there is fee flow to distribute
    throwIfAborted(signal);
    const params = await this.d.chain.splitParams(ref);
    if (params.pendingGross === 0n && !this.d.distributeEmpty) {
      const reason = "no fee flow this period (router pendingGross == 0)";
      try {
        await this.d.signals?.markNoDistribution({ bookId, period, reason, pendingGross: "0", at: (this.d.now ?? Date.now)() });
      } catch (err) {
        // the mark falls back to its bounded wait (MARK_WAIT_SECONDS); never fail the job on it
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "could not record the no-distribution decision");
      }
      log.info("no fee flow: distribute skipped (no tx); the mark is not held for it");
      return { status: "nothing_to_distribute", reason };
    }
    const expenses = this.d.expensesFor(bookId);
    const split = { expenseCapBps: params.expenseCapBps, carryBps: params.carryBps, seniorHurdleBps: params.seniorHurdleBps, seniorSupply: params.seniorSupply, juniorSupply: params.juniorSupply };
    const preview = previewDistribution({ ...split, gross: params.pendingGross, expensesRequested: expenses });
    const onchainPreview = await this.d.chain.previewOnChain(ref, params.pendingGross, expenses);
    if (onchainPreview && splitMismatches(preview, onchainPreview).length) {
      log.error({ preview: fmtSplit(preview), onchain: fmtSplit(onchainPreview) }, "router.previewSplit differs from normative splitDistribution");
    }
    log.info({ preview: fmtSplit(preview), expensesRequested: usd6(expenses) }, "distributing");

    let res: { hash: Hex; distributed: DistributedLog };
    try {
      res = await this.d.chain.distribute(ref, period, expenses);
    } catch (err) {
      const again = await this.d.chain.findDistributed(ref, period);
      if (again) {
        await this.persist(again);
        log.info({ tx: again.txHash }, "distribute reverted: period already distributed");
        return { status: "already", source: "chain", txHash: again.txHash };
      }
      log.error({ revert: describeRevert(err) }, "distribute failed");
      throw err;
    }

    const actual = res.distributed.amounts;
    const previewMismatches = splitMismatches(preview, actual);
    const parityMismatches = parityCheck(actual, split);
    if (parityMismatches.length || !conserves(actual)) {
      log.error({ actual: fmtSplit(actual), fields: parityMismatches }, "WATERFALL PARITY BREAK: on-chain Distributed amounts differ from splitDistribution");
    } else if (previewMismatches.length) {
      log.warn({ preview: fmtSplit(preview), actual: fmtSplit(actual), fields: previewMismatches }, "distribution differs from pre-tx preview (fee flow moved between preview and tx); parity holds");
    }
    await this.persist(res.distributed);
    this.d.onDistributed?.(bookId, actual.expenses);
    log.info({ tx: res.hash, split: fmtSplit(actual) }, "distribution paid");
    return { status: "distributed", txHash: res.hash, split: actual, previewMismatches, parityMismatches };
  }

  private async persist(d: DistributedLog) {
    await this.d.store.insertDistribution(d);
    await this.publish(d.bookId, d.period, d.amounts, d.txHash);
  }

  private async publish(bookId: number, period: number, s: SplitResult, txHash: string) {
    await this.d.events.publish("distribution.paid", bookId, distributionPaidPayload(bookId, period, s, txHash), distributionDedupeKey(bookId, period));
  }

  /** ops-venue performs adapter.sweepFees(period, amount) (OPS_VENUE); we enqueue and wait, bounded. */
  private async sweepOrderly(ref: BookRef, period: number, log: Logger, signal?: AbortSignal) {
    const swept = () => this.d.chain.feesSwept(ref, period);
    let tx = await swept();
    if (!tx) {
      await this.d.venueOps.enqueueSweep(ref.bookId, period);
      type Done = { kind: "swept"; tx: Hex } | { kind: "job"; job: "completed" | "failed" };
      const done = await pollUntil<Done>(
        async () => {
          const t = await swept();
          if (t) return { kind: "swept", tx: t };
          const s = await this.d.venueOps.sweepJobState(ref.bookId, period);
          return s === "completed" || s === "failed" ? { kind: "job", job: s } : undefined;
        },
        { timeoutMs: this.d.sweepWaitMs, everyMs: this.d.pollMs, signal },
      );
      if (done?.kind === "swept") tx = done.tx;
      else if (done?.job === "failed") log.warn("ops-venue sweep_fees job failed; distributing what the router holds (late fee flow rolls into the next period)");
      else if (done?.job === "completed") log.info("ops-venue completed sweep_fees without a sweep (no fee settlement this period)");
      else log.warn({ waitedMs: this.d.sweepWaitMs }, "no fee sweep within the wait; distributing what the router holds (late fee flow rolls into the next period)");
    }
    if (tx) await this.awaitForward(ref, period, tx, log, signal);
  }

  /**
   * After the earmark: wait (bounded) until the earmarked fees are on the router, then record the
   * SettlementReceived rows that carried them. Never blocks the mark beyond forwardWaitMs: what has not
   * landed by then is distributed by a later period (distribute() takes the router's whole pendingGross).
   */
  private async awaitForward(ref: BookRef, period: number, tx: Hex, log: Logger, signal?: AbortSignal) {
    let last: FeeForwarding | null = null;
    const landed = await pollUntil<FeeForwarding>(
      async () => {
        try {
          last = await this.d.chain.feeForwarding(ref, tx);
        } catch (err) {
          log.debug({ err: err instanceof Error ? err.message.split("\n")[0] : String(err), tx }, "could not read the earmark's forwarding state (retrying)");
          return undefined;
        }
        return forwardLanded(last) ? last : undefined;
      },
      { timeoutMs: this.d.forwardWaitMs ?? 0, everyMs: this.d.pollMs, signal },
    );
    const f: FeeForwarding | null = landed ?? last;
    if (!f) return this.recordReceived(ref, period, tx, log);
    if (!landed) {
      log.warn(
        { earmarked: usd6(f.earmarked), forwarded: usd6(venueForwarded(f)), pendingFees: usd6(f.pendingFees), waitedMs: this.d.forwardWaitMs ?? 0 },
        "earmarked fees not on the router within the wait; distributing what the router holds (the rest rolls into the next period)",
      );
    }
    try {
      await this.d.store.insertReceived(ref.bookId, period, f.received);
      log.info({ tx, earmarked: usd6(f.earmarked), received: f.received.map((r) => usd6(r.amount)) }, "fee settlement swept");
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), tx }, "could not record the sweep's SettlementReceived rows");
    }
  }

  private async sweepEngine(ref: BookRef, period: number, log: Logger) {
    const prior = await this.d.chain.feesSwept(ref, period);
    if (prior) return this.recordReceived(ref, period, prior, log);
    const accrued = await this.d.chain.engineFeesAccrued(ref);
    if (accrued === 0n) {
      log.debug("engine accrued no fees: sweepFees skipped (no tx)");
      return;
    }
    try {
      const { hash, received } = await this.d.chain.sweepEngineFees(ref, period);
      await this.d.store.insertReceived(ref.bookId, period, received);
      log.info({ tx: hash, received: received.map((r) => usd6(r.amount)) }, "engine fees swept");
    } catch (err) {
      log.warn({ revert: describeRevert(err) }, "engine sweepFees reverted; continuing with router balance");
    }
  }

  private async recordReceived(ref: BookRef, period: number, tx: Hex, log: Logger) {
    try {
      const received = await this.d.chain.receivedInTx(ref, tx);
      await this.d.store.insertReceived(ref.bookId, period, received);
      log.info({ tx, received: received.map((r) => usd6(r.amount)) }, "fee settlement swept");
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), tx }, "could not record the sweep's SettlementReceived rows");
    }
  }
}

/** Venue fee flow (SRC_VENUE_TAKER_SHARE) that reached the router after the earmark. */
export function venueForwarded(f: FeeForwarding): bigint {
  return f.received.filter((r) => r.source === REVENUE_SOURCE.VENUE_TAKER_SHARE).reduce((a, r) => a + r.amount, 0n);
}

/**
 * The earmark has landed when the router received at least the earmarked amount from the venue after it,
 * or when the adapter holds no pending earmark at all (forwarded, or cancelled: nothing more will come).
 */
export function forwardLanded(f: FeeForwarding): boolean {
  return f.pendingFees === 0n || venueForwarded(f) >= f.earmarked;
}

export function fmtSplit(s: SplitResult) {
  return { gross: usd6(s.gross), expenses: usd6(s.expenses), carry: usd6(s.carry), senior: usd6(s.senior), junior: usd6(s.junior) };
}

export { amountsToSplit };
