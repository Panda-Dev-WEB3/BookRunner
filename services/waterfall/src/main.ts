// waterfall service: per Live/Retiring book per mark period -> fee sweep + RevenueRouter.distribute
// (BullMQ QUEUES.settlements, one job per (book, period)); keeper duties every tick.
import { createDb } from "@bookrunner/db";
import {
  QUEUES,
  RECEIPT_KIND,
  type SettlementJob,
  createLogger,
  publicClientFor,
  roleAccount,
  walletClientFor,
} from "@bookrunner/shared";
import { bookrunnerConfigAbi } from "@bookrunner/shared/abi";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { WaterfallChainAdapter } from "./adapters/chain";
import { RedeemLogIndex, UnionCandidates } from "./adapters/redemptions";
import { DbRedeemCandidates, PgSettlementStore } from "./adapters/store";
import { BullVenueOps } from "./adapters/venue-ops";
import { loadWaterfallConfig } from "./config";
import { GasMeter, expensesRequested } from "./domain/expenses";
import { Cooldowns, distributes } from "./domain/keeper";
import { KeeperRunner } from "./keeper";
import { BookDirectory } from "./kit/books";
import { waitForDeployment } from "./kit/deployment";
import { PgRedisEventSink } from "./kit/events";
import { onShutdown, startLoop } from "./kit/loop";
import { isNewPeriod, periodEndAt } from "./kit/period";
import { insertReceipt } from "./kit/receipts";
import { RedisSettlementSignals } from "./kit/signals";
import { TxSender } from "./kit/tx";
import { SettlementRunner } from "./settlement";

export const settleJobId = (bookId: number, period: number) => `settle-${bookId}-${period}`;

export async function main() {
  const cfg = loadWaterfallConfig();
  const log = createLogger("waterfall", cfg.LOG_LEVEL);
  const ac = new AbortController();
  const cleanups: Array<() => Promise<unknown>> = [];
  onShutdown(log, async () => {
    ac.abort();
    for (const c of cleanups.reverse()) await c().catch((err) => log.warn({ err }, "cleanup step failed"));
  });

  const pc = publicClientFor(cfg.CHAIN_ID, cfg.RPC_URL);
  log.info({ chainId: cfg.CHAIN_ID, rpc: cfg.RPC_URL }, "waterfall service starting");
  const deployment = await waitForDeployment({ file: cfg.DEPLOYMENT_FILE, log, signal: ac.signal, publicClient: pc });
  if (!deployment) return;

  const keeperAccount = roleAccount("keeper");
  const wallet = walletClientFor(cfg.CHAIN_ID, cfg.RPC_URL, keeperAccount);
  const sender = new TxSender(pc, wallet, log);
  const gas = new GasMeter();
  sender.onGas((e) => gas.add(e.bookId, e.costWei));
  try {
    const role = await pc.readContract({ address: deployment.contracts.config, abi: bookrunnerConfigAbi, functionName: "KEEPER_ROLE" });
    const ok = await pc.readContract({ address: deployment.contracts.config, abi: bookrunnerConfigAbi, functionName: "hasRole", args: [role, keeperAccount.address] });
    if (!ok) log.warn({ keeper: keeperAccount.address }, "keeper account lacks KEEPER_ROLE; distribute/recall will revert");
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message.split("\n")[0] : String(err) }, "could not verify KEEPER_ROLE");
  }

  const { db, close } = createDb(cfg.DATABASE_URL, 5);
  cleanups.push(close);
  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 3 });
  redis.on("error", (err) => log.warn({ err: err.message }, "redis error"));
  cleanups.push(() => redis.quit());
  const connection = { url: cfg.REDIS_URL, maxRetriesPerRequest: null };
  const venueQueue = new Queue(QUEUES.venueOps, { connection });
  const settleQueue = new Queue<SettlementJob>(QUEUES.settlements, { connection });
  for (const q of [venueQueue, settleQueue]) {
    q.on("error", (err) => log.warn({ err: err.message, queue: q.name }, "queue error"));
    cleanups.push(() => q.close());
  }

  const events = new PgRedisEventSink(db, redis, log);
  const books = new BookDirectory(pc, deployment, log);
  const candidates = new UnionCandidates([new RedeemLogIndex(pc, BigInt(deployment.startBlock ?? 0), cfg.WATERFALL_LOG_CHUNK_BLOCKS, log), new DbRedeemCandidates(db)], log);
  const chain = new WaterfallChainAdapter({ pc, sender, deployment, candidates, logChunk: cfg.WATERFALL_LOG_CHUNK_BLOCKS, logLookback: cfg.WATERFALL_LOG_LOOKBACK_BLOCKS });
  const expenseCfg = { mode: cfg.WATERFALL_EXPENSE_MODE, fixedUsd: cfg.WATERFALL_EXPENSES_USD, oracleCostUsd: cfg.WATERFALL_ORACLE_COST_USD, ethUsdWad: cfg.WATERFALL_ETH_USD };

  const runner = new SettlementRunner({
    books,
    chain,
    store: new PgSettlementStore(db),
    venueOps: new BullVenueOps(venueQueue),
    events,
    expensesFor: (bookId) => expensesRequested(expenseCfg, gas.pending(bookId)),
    onDistributed: (bookId) => gas.reset(bookId),
    log,
    sweepWaitMs: cfg.WATERFALL_SWEEP_WAIT_SECONDS * 1000,
    pollMs: 2_000,
    signals: new RedisSettlementSignals(redis),
    distributeEmpty: cfg.WATERFALL_DISTRIBUTE_EMPTY,
  });

  const worker = new Worker<SettlementJob>(
    QUEUES.settlements,
    async (job) => {
      const out = await runner.run(job.data, ac.signal);
      return { status: out.status, ...("txHash" in out ? { txHash: out.txHash } : {}), ...("reason" in out ? { reason: out.reason } : {}) };
    },
    { connection, concurrency: cfg.WATERFALL_CONCURRENCY, lockDuration: (cfg.WATERFALL_SWEEP_WAIT_SECONDS + 180) * 1000 },
  );
  worker.on("failed", (job, err) => log.warn({ job: job?.id, attempts: job?.attemptsMade, err: err.message }, "settlement job failed"));
  worker.on("error", (err) => log.warn({ err: err.message }, "settlement worker error"));
  cleanups.push(() => worker.close());

  const keeper = new KeeperRunner({
    chain,
    cooldowns: new Cooldowns(),
    cfg: {
      bufferBps: BigInt(cfg.WATERFALL_RECALL_BUFFER_BPS),
      minRecallUsd: cfg.WATERFALL_MIN_RECALL_USD,
      flatThresholdUsd: cfg.WATERFALL_FLAT_THRESHOLD_USD,
      recallAllWhenRetiring: cfg.WATERFALL_RETIRE_RECALL,
      cooldownMs: cfg.WATERFALL_ACTION_COOLDOWN_SECONDS * 1000,
    },
    log,
    recordDecision: async (bookId, payload) => {
      await insertReceipt(db, { bookId, kind: RECEIPT_KIND.DECISION, ts: new Date(), payload }, cfg.RECEIPTS_INTERVAL_SECONDS);
    },
  });

  const enqueued = new Map<number, number>();
  let intervalWarned = false;
  const loop = startLoop({
    name: "waterfall",
    intervalMs: cfg.WATERFALL_TICK_SECONDS * 1000,
    log,
    run: async (signal) => {
      const list = await books.list();
      const head = await pc.getBlock();
      const interval = await chain.getMarkInterval();
      if (interval !== cfg.MARK_INTERVAL_SECONDS && !intervalWarned) {
        intervalWarned = true;
        log.warn({ onchain: interval, env: cfg.MARK_INTERVAL_SECONDS }, "config.markInterval() differs from MARK_INTERVAL_SECONDS; using the on-chain value");
      }
      const period = periodEndAt(Number(head.timestamp), interval);
      for (const ref of list) {
        if (signal.aborted) return;
        try {
          const state = await chain.bookState(ref);
          if (distributes(state) && isNewPeriod(period, enqueued.get(ref.bookId))) {
            await settleQueue.add(
              "settle",
              { bookId: ref.bookId, period },
              { jobId: settleJobId(ref.bookId, period), attempts: 5, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: { age: 86_400 }, removeOnFail: { age: 86_400 } },
            );
            enqueued.set(ref.bookId, period);
            log.debug({ bookId: ref.bookId, period }, "settlement enqueued");
          }
          if (cfg.WATERFALL_KEEPER_ENABLED && state !== "Cancelled") await keeper.tick(ref);
        } catch (err) {
          log.warn({ bookId: ref.bookId, err: err instanceof Error ? err.message.split("\n")[0] : String(err) }, "book tick failed");
        }
      }
    },
  });
  cleanups.push(() => loop.stop());
  log.info({ books: (await books.list()).map((b) => b.bookId), keeper: keeperAccount.address }, "waterfall running");
}

if (import.meta.main) await main();
