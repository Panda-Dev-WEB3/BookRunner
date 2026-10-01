// Manual mark: bun run mark-now <bookId> [--period <periodEnd>] [--dry-run] [--enqueue] [--allow-incomplete-receipts]
//   default: computes, signs, commits and applies the mark of the latest closed period right now
//            (does not wait for the period's distribution).
//   --dry-run: prints the computed MarkInput + MarkPnl JSON; sends nothing.
//   --enqueue: hands the job to the running mark service (QUEUES.marks) instead.
import { type MarkJob, QUEUES, createLogger, loadDeployment, publicClientFor } from "@bookrunner/shared";
import { periodEndAt, toJsonSafe } from "@bookrunner/waterfall";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { loadMarkConfig } from "../config";
import { wireMark } from "../wire";

export interface MarkNowArgs {
  bookId: number;
  period?: number;
  dryRun: boolean;
  enqueue: boolean;
  allowIncompleteReceipts: boolean;
}

export function parseArgs(argv: string[]): MarkNowArgs {
  const args: MarkNowArgs = { bookId: Number.NaN, dryRun: false, enqueue: false, allowIncompleteReceipts: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--enqueue") args.enqueue = true;
    else if (a === "--allow-incomplete-receipts") args.allowIncompleteReceipts = true;
    else if (a === "--period") args.period = Number(argv[++i]);
    else if (/^\d+$/.test(a)) args.bookId = Number(a);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(args.bookId)) throw new Error("usage: bun run mark-now <bookId> [--period <periodEnd>] [--dry-run] [--enqueue] [--allow-incomplete-receipts]");
  if (args.period !== undefined && !Number.isInteger(args.period)) throw new Error("--period must be a unix timestamp (multiple of markInterval)");
  return args;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadMarkConfig();
  const log = createLogger("mark-now", cfg.LOG_LEVEL);
  const deployment = loadDeployment(cfg.DEPLOYMENT_FILE);
  const pc = publicClientFor(cfg.CHAIN_ID, cfg.RPC_URL);
  const head = await pc.getBlock();

  if (args.enqueue) {
    const connection = { url: cfg.REDIS_URL, maxRetriesPerRequest: null };
    const queue = new Queue<MarkJob>(QUEUES.marks, { connection });
    const periodEnd = args.period ?? periodEndAt(Number(head.timestamp), cfg.MARK_INTERVAL_SECONDS);
    const job = await queue.add("mark", { bookId: args.bookId, periodEnd }, { jobId: `mark-manual-${args.bookId}-${periodEnd}-${Date.now()}`, attempts: 3, backoff: { type: "exponential", delay: 5_000 } });
    console.log(JSON.stringify({ enqueued: job.id, bookId: args.bookId, periodEnd }));
    await queue.close();
    return;
  }

  const redis = args.dryRun ? null : new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 2 });
  redis?.on("error", () => {});
  const ctx = await wireMark(cfg, log, deployment, pc, redis);
  try {
    const periodEnd = args.period ?? periodEndAt(Number(head.timestamp), ctx.markInterval);
    const out = await ctx.pipeline.run({ bookId: args.bookId, periodEnd }, { dryRun: args.dryRun, allowIncompleteReceipts: args.allowIncompleteReceipts });
    if (out.status === "dry_run") {
      const c = out.computed;
      console.log(JSON.stringify(toJsonSafe({ status: out.status, block: c.snapshot.blockNumber, input: c.input, pnl: c.pnl, receipts: c.receipts, crossChecks: c.nav }), null, 2));
    } else console.log(JSON.stringify(toJsonSafe(out), null, 2));
    if (out.status === "unmarkable") process.exitCode = 2;
  } finally {
    await ctx.close();
    await redis?.quit().catch(() => undefined);
  }
}

if (import.meta.main) {
  run().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
