// Jury queue wiring. Jobs (QUEUES.jury, {charterId}) are enqueued from three sources:
//   1. CHANNELS.domainEvents "charter.filed" (published by the indexer) — immediate;
//   2. DB poll: charters with status Filed and no posted verdict (restart safety);
//   3. chain poll: MarketCharter.count() scan (works even when the indexer is not running).
// jobId = jury-<id> dedupes while a job is waiting/active; finished jobs are removed so a later
// re-enqueue (e.g. after a devnet reset) is possible.
import { CHANNELS, type JuryJob, type Logger, QUEUES } from "@bookrunner/shared";
import { type Job, Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { CharterChain } from "../adapters/chain";
import type { CharterStore } from "../adapters/store";
import type { JuryOutcome } from "./pipeline";

export const JURY_JOB_ATTEMPTS = 6;

export interface SchedulerOptions {
  redisUrl: string;
  concurrency: number;
  pollMs: number;
  logger: Logger;
  store: CharterStore;
  chain: CharterChain;
  process: (charterId: number, finalAttempt: boolean) => Promise<JuryOutcome>;
}

export const juryJobId = (charterId: number) => `jury-${charterId}`;

/** Parses a domain-event message; returns the charter id for charter.filed events. */
export function filedCharterIdFrom(message: string): number | null {
  try {
    const m = JSON.parse(message) as { type?: unknown; data?: { charterId?: unknown } };
    if (m.type !== "charter.filed") return null;
    const id = Number(m.data?.charterId);
    return Number.isInteger(id) && id >= 0 ? id : null;
  } catch {
    return null;
  }
}

export class JuryScheduler {
  private queue: Queue<JuryJob> | null = null;
  private worker: Worker<JuryJob, JuryOutcome> | null = null;
  private sub: Redis | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** charters the jury is done with (posted / not Filed) — skipped by the pollers */
  private readonly settled = new Set<number>();

  constructor(private readonly o: SchedulerOptions) {}

  async start(): Promise<void> {
    const connection = { url: this.o.redisUrl, maxRetriesPerRequest: null };
    this.queue = new Queue<JuryJob>(QUEUES.jury, {
      connection,
      defaultJobOptions: {
        attempts: JURY_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: 15_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
    this.queue.on("error", (err) => this.o.logger.warn({ err }, "jury queue error"));

    this.worker = new Worker<JuryJob, JuryOutcome>(QUEUES.jury, (job) => this.handle(job), { connection, concurrency: this.o.concurrency });
    this.worker.on("error", (err) => this.o.logger.warn({ err }, "jury worker error"));
    this.worker.on("failed", (job, err) =>
      this.o.logger.error({ err, charterId: job?.data.charterId, attempts: job?.attemptsMade }, "jury job failed"),
    );

    this.sub = new Redis(this.o.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
    this.sub.on("error", (err) => this.o.logger.warn({ err: err.message }, "redis subscriber error"));
    this.sub.on("message", (_channel: string, message: string) => {
      const id = filedCharterIdFrom(message);
      if (id !== null) void this.enqueue(id, "charter.filed event");
    });
    // not awaited: while Redis is down the command waits in ioredis' offline queue; polling covers it
    this.sub.subscribe(CHANNELS.domainEvents).catch((err) => this.o.logger.warn({ err }, "subscribe failed; relying on polling"));

    this.schedulePoll(0);
    this.o.logger.info({ queue: QUEUES.jury, concurrency: this.o.concurrency }, "jury scheduler started");
  }

  private async handle(job: Job<JuryJob, JuryOutcome>): Promise<JuryOutcome> {
    const id = job.data.charterId;
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const outcome = await this.o.process(id, finalAttempt);
    if (outcome.status === "missing") throw new Error(`charter ${id} not found on-chain`);
    this.settled.add(id);
    this.o.logger.info({ charterId: id, outcome }, "jury job done");
    return outcome;
  }

  async enqueue(charterId: number, reason: string): Promise<void> {
    if (!this.queue || this.settled.has(charterId)) return;
    try {
      await this.queue.add("jury", { charterId }, { jobId: juryJobId(charterId) });
      this.o.logger.debug({ charterId, reason }, "jury job enqueued");
    } catch (err) {
      this.o.logger.warn({ err, charterId }, "enqueue failed");
    }
  }

  private schedulePoll(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.poll().finally(() => this.schedulePoll(this.o.pollMs));
    }, ms);
  }

  async poll(): Promise<void> {
    try {
      for (const r of await this.o.store.filedWithoutPostedVerdict()) await this.enqueue(r.id, "db poll");
    } catch (err) {
      this.o.logger.warn({ err: (err as Error).message }, "jury db poll failed");
    }
    let count: number;
    try {
      count = await this.o.chain.charterCount();
    } catch (err) {
      this.o.logger.warn({ err: (err as Error).message }, "jury chain poll failed");
      return;
    }
    // VERIFY: charter ids start at 1 (0..count covers a 0-based implementation too)
    for (let id = 0; id <= count && !this.stopped; id++) {
      if (this.settled.has(id)) continue;
      try {
        const rec = await this.o.chain.charterRecord(id);
        if (!rec || rec.status !== "Filed") {
          if (rec || id === 0) this.settled.add(id);
          continue;
        }
        const v = await this.o.chain.juryVerdict(id);
        if (v.posted) this.settled.add(id);
        else await this.enqueue(id, "chain poll");
      } catch (err) {
        if (id === 0) this.settled.add(0); // get(0) may revert when ids start at 1
        else this.o.logger.debug({ charterId: id, err: (err as Error).message }, "chain poll: charter read failed");
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled([this.worker?.close(), this.queue?.close(), this.sub?.quit()]);
  }
}
