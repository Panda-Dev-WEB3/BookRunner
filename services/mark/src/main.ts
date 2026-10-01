// mark service: per Live/Retiring book per period, after the waterfall distribution (or MARK_WAIT_SECONDS),
// one BullMQ job (QUEUES.marks) -> MarkPipeline (commit + applyMark).
import { type MarkJob, QUEUES, createLogger, publicClientFor } from "@bookrunner/shared";
import { onShutdown, retryUntil, startLoop, waitForDeployment } from "@bookrunner/waterfall";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { loadMarkConfig } from "./config";
import { RetryableMarkError } from "./pipeline";
import { MarkScheduler, markJobId } from "./scheduler";
import { wireMark } from "./wire";

const MARK_JOB_ATTEMPTS = 6;

export async function main() {
  const cfg = loadMarkConfig();
  const log = createLogger("mark", cfg.LOG_LEVEL);
  const ac = new AbortController();
  const cleanups: Array<() => Promise<unknown>> = [];
  onShutdown(log, async () => {
    ac.abort();
    for (const c of cleanups.reverse()) await c().catch((err) => log.warn({ err }, "cleanup step failed"));
  });

  const pc = publicClientFor(cfg.CHAIN_ID, cfg.RPC_URL);
  log.info({ chainId: cfg.CHAIN_ID, rpc: cfg.RPC_URL }, "mark service starting");
  const deployment = await waitForDeployment({ file: cfg.DEPLOYMENT_FILE, log, signal: ac.signal, publicClient: pc });
  if (!deployment) return;

  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 3 });
  redis.on("error", (err) => log.warn({ err: err.message }, "redis error"));
  cleanups.push(() => redis.quit());
  const ctx = await retryUntil("wire mark service", () => wireMark(cfg, log, deployment, pc, redis), { log, signal: ac.signal });
  if (!ctx) return;
  cleanups.push(ctx.close);

  const connection = { url: cfg.REDIS_URL, maxRetriesPerRequest: null };
  const queue = new Queue<MarkJob>(QUEUES.marks, { connection });
  queue.on("error", (err) => log.warn({ err: err.message }, "marks queue error"));
  cleanups.push(() => queue.close());

  const scheduler = new MarkScheduler({
    books: ctx.books,
    chain: ctx.readChain,
    maxMarkAge: () => ctx.markChain.maxMarkAge(),
    store: ctx.store,
    enqueue: async (job, generation) => {
      await queue.add("mark", job, {
        jobId: markJobId(job.bookId, job.periodEnd, generation),
        attempts: MARK_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { age: 86_400 },
        removeOnFail: { age: 86_400 },
      });
    },
    log,
    waitSeconds: cfg.MARK_WAIT_SECONDS,
    safetySeconds: cfg.MARK_SAFETY_SECONDS,
  });

  const worker = new Worker<MarkJob>(
    QUEUES.marks,
    async (job) => {
      const out = await ctx.pipeline.run(job.data, { signal: ac.signal });
      if (out.status === "applied") return { status: out.status, markId: out.markId.toString(), commitTx: out.commitTx, applyTx: out.applyTx };
      if (out.status === "unmarkable") log.error({ ...job.data, reason: out.reason }, "period cannot be marked");
      return { status: out.status, ...("reason" in out ? { reason: out.reason } : {}) };
    },
    { connection, concurrency: 1, lockDuration: 300_000 },
  );
  worker.on("failed", (job, err) => {
    const level = err instanceof RetryableMarkError ? "info" : "warn";
    log[level]({ job: job?.id, attempts: job?.attemptsMade, err: err.message }, "mark job attempt failed");
    if (job && job.attemptsMade >= MARK_JOB_ATTEMPTS) scheduler.onJobExhausted(job.data.bookId, job.data.periodEnd);
  });
  worker.on("error", (err) => log.warn({ err: err.message }, "mark worker error"));
  cleanups.push(() => worker.close());

  const loop = startLoop({
    name: "mark-scheduler",
    intervalMs: cfg.MARK_TICK_SECONDS * 1000,
    log,
    run: async (signal) => {
      const flushed = await ctx.spool.flush((r) => ctx.store.saveCommitted(r));
      if (flushed) log.info({ flushed }, "spooled marks rows written to Postgres");
      await scheduler.tick(signal);
    },
  });
  cleanups.push(() => loop.stop());
  log.info({ signer: ctx.account.address, markInterval: ctx.markInterval, waitSeconds: cfg.MARK_WAIT_SECONDS }, "mark service running");
}

if (import.meta.main) await main();
