// Decides, per book, when the mark of the latest closed period may run and enqueues it once.
import type { Logger, MarkJob } from "@bookrunner/shared";
import { type BookRef, type KeeperChain, dueAssets, periodEndAt, settlesUpToIndex } from "@bookrunner/waterfall";
import { type Readiness, liquidityShort, markReadiness } from "./domain/readiness";
import type { MarkStore } from "./ports";

export interface SchedulerDeps {
  books: { list(): Promise<BookRef[]> };
  /** Read-only use of the waterfall's chain adapter (state, idle, in-transit, pending redemptions). */
  chain: Pick<KeeperChain, "snapshot" | "pendingRedemptions"> & { findDistributed(ref: BookRef, period: number): Promise<unknown | null> };
  maxMarkAge: () => Promise<number>;
  store: Pick<MarkStore, "distribution">;
  enqueue: (job: MarkJob, generation: number) => Promise<void>;
  log: Logger;
  waitSeconds: number;
  safetySeconds: number;
  /** Re-enqueue generations allowed after a job exhausted its attempts. */
  maxGenerations?: number;
}

export interface TickResult {
  bookId: number;
  periodEnd: number;
  readiness: Readiness | { ready: false; reason: "queued" };
}

export class MarkScheduler {
  private queued = new Map<number, number>(); // bookId -> periodEnd enqueued
  private generation = new Map<string, number>();
  private lastReason = new Map<string, string>();
  private distributed = new Set<string>();

  constructor(private readonly d: SchedulerDeps) {}

  async tick(signal?: AbortSignal): Promise<TickResult[]> {
    const out: TickResult[] = [];
    const maxAge = await this.d.maxMarkAge();
    for (const ref of await this.d.books.list()) {
      if (signal?.aborted) break;
      try {
        const r = await this.evaluate(ref, maxAge);
        if (r) out.push(r);
      } catch (err) {
        this.d.log.warn({ bookId: ref.bookId, err: err instanceof Error ? err.message.split("\n")[0] : String(err) }, "mark scheduling failed for book");
      }
    }
    return out;
  }

  /** A job for (book, period) failed all its attempts: allow a fresh job while the period is still markable. */
  onJobExhausted(bookId: number, periodEnd: number) {
    const k = `${bookId}:${periodEnd}`;
    const g = (this.generation.get(k) ?? 0) + 1;
    if (g > (this.d.maxGenerations ?? 2)) {
      this.d.log.error({ bookId, periodEnd }, "mark job exhausted every generation; next period will mark");
      return;
    }
    this.generation.set(k, g);
    if (this.queued.get(bookId) === periodEnd) this.queued.delete(bookId);
  }

  private async evaluate(ref: BookRef, maxMarkAge: number): Promise<TickResult | null> {
    const s = await this.d.chain.snapshot(ref);
    const periodEnd = periodEndAt(s.nowSec, s.markInterval);
    if ((this.queued.get(ref.bookId) ?? 0) >= periodEnd) return { bookId: ref.bookId, periodEnd, readiness: { ready: false, reason: "queued" } };

    const base = { state: s.state, nowSec: s.nowSec, periodEnd, lastMarkPeriodEnd: s.lastMarkPeriodEnd, waitSeconds: this.d.waitSeconds, maxMarkAge, safetySeconds: this.d.safetySeconds };
    const pre = markReadiness({ ...base, distributed: false, liquidityShort: false });
    if (!pre.ready && (pre.reason === "state" || pre.reason === "marked" || pre.reason === "not_due" || pre.reason === "too_old")) {
      this.note(ref.bookId, periodEnd, pre.reason);
      return { bookId: ref.bookId, periodEnd, readiness: pre };
    }

    const k = `${ref.bookId}:${periodEnd}`;
    let distributed = this.distributed.has(k);
    if (!distributed) distributed = (await this.d.store.distribution(ref.bookId, periodEnd)) !== null || (await this.d.chain.findDistributed(ref, periodEnd)) !== null;
    if (distributed) this.distributed.add(k);

    let short = false;
    if (s.inTransit > 0n) {
      const shares = await this.d.chain.pendingRedemptions(ref, settlesUpToIndex(s.lastMarkPeriodEnd, s.markInterval), settlesUpToIndex(periodEnd, s.markInterval));
      short = liquidityShort(dueAssets(shares, s.sharePriceWad), s.unfundedClaims, s.vaultIdle, s.inTransit);
    }
    const readiness = markReadiness({ ...base, distributed, liquidityShort: short });
    if (readiness.ready) {
      await this.d.enqueue({ bookId: ref.bookId, periodEnd }, this.generation.get(k) ?? 0);
      this.queued.set(ref.bookId, periodEnd);
      this.d.log.info({ bookId: ref.bookId, periodEnd, reason: readiness.reason }, "mark enqueued");
    } else this.note(ref.bookId, periodEnd, readiness.reason);
    if (this.distributed.size > 10_000) this.distributed.clear();
    return { bookId: ref.bookId, periodEnd, readiness };
  }

  private note(bookId: number, periodEnd: number, reason: string) {
    const k = `${bookId}:${periodEnd}`;
    if (this.lastReason.get(k) === reason) return;
    this.lastReason.set(k, reason);
    if (this.lastReason.size > 10_000) this.lastReason.clear();
    this.d.log.debug({ bookId, periodEnd, reason }, "mark not ready");
  }
}

export const markJobId = (bookId: number, periodEnd: number, generation = 0) => `mark-${bookId}-${periodEnd}${generation ? `-g${generation}` : ""}`;
