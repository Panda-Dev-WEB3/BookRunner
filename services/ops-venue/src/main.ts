// ops-venue service entry: Orderly builder operations for every Orderly-venue book.
//   loops : book discovery + provisioning, chain logs (withdrawals, kills, re-mandates), adapter
//           reports every OPS_REPORT_INTERVAL_MS, builder fee sweeps per mark period
//   queue : BullMQ QUEUES.venueOps (create_symbol, fund_if, deposit_mm, execute_withdraw, report,
//           sweep_fees, revoke_key)
//   redis : CHANNELS.kill(*) -> revoke the book's venue trade key
// Idles (log + retry) until contracts/deployments/<chainId>.json exists.
import { createDb } from "@bookrunner/db";
import { CHANNELS, createLogger, QUEUES, roleAccount, tryLoadDeployment, type VenueOpsJob } from "@bookrunner/shared";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Address } from "viem";
import { ViemChain } from "./chain";
import { OrderlyBuilderClient, OrderlyVenue } from "./client";
import { loadOpsEnv } from "./config";
import { KeyStore, resolveKeysDir } from "./keys";
import { keyFromSecret } from "./orderly/auth";
import { orderlyAccountId } from "./orderly/convert";
import { FileSagaStore, PgOpsStore } from "./store";
import { errMsg, KeyedMutex, sleep } from "./util";
import type { OpsContext } from "./worker/context";
import { loadOrCreateBuilderKey, Provisioner } from "./worker/provision";
import { OpsService } from "./worker/service";

const env = loadOpsEnv();
const log = createLogger("ops-venue");
const abort = new AbortController();
const DAY = 86_400_000;
/** CHANNELS.kill(bookId) = "bkrn:risk:kill:<id>" -> pattern over all books. */
const KILL_PATTERN = `${CHANNELS.kill(0).slice(0, -1)}*`;

async function main() {
  log.info({ mode: env.ORDERLY_MODE, baseUrl: env.ORDERLY_BASE_URL, chainId: env.CHAIN_ID }, "ops-venue starting");
  const keys = new KeyStore(resolveKeysDir(env.OPS_KEYS_DIR));
  const sagas = new FileSagaStore(env.OPS_SAGA_FILE);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  redis.on("error", (err) => log.warn({ err: errMsg(err) }, "redis error"));
  const pg = createDb(env.DATABASE_URL, 5);
  const store = new PgOpsStore(pg.db, redis, env.RECEIPTS_INTERVAL_SECONDS);

  let dep = tryLoadDeployment(env.DEPLOYMENT_FILE);
  while (!dep && !abort.signal.aborted) {
    log.info({ file: env.DEPLOYMENT_FILE, retryMs: env.OPS_DEPLOYMENT_RETRY_MS }, "deployment file missing — idling until contracts are deployed");
    await sleep(env.OPS_DEPLOYMENT_RETRY_MS, abort.signal);
    dep = tryLoadDeployment(env.DEPLOYMENT_FILE);
  }
  if (!dep) return cleanup([], redis, pg.close);

  const ops = roleAccount("opsVenue");
  const chain = new ViemChain(dep, ops, log, { chainId: env.CHAIN_ID, rpcUrl: env.RPC_URL, confirmations: env.OPS_CONFIRMATIONS, fallbackMarkInterval: env.MARK_INTERVAL_SECONDS, txPollMs: env.OPS_TX_POLL_MS });
  const builderAccountId = (env.ORDERLY_BUILDER_ACCOUNT_ID ?? orderlyAccountId(ops.address, env.ORDERLY_BROKER_ID)).toLowerCase();
  const builderKey = await loadOrCreateBuilderKey(keys, builderAccountId, env.ORDERLY_BUILDER_KEY_SECRET, env.OPS_OPS_KEY_TTL_DAYS * DAY, keyFromSecret);
  const builder = new OrderlyBuilderClient({
    baseUrl: env.ORDERLY_BASE_URL,
    mode: env.ORDERLY_MODE,
    brokerId: env.ORDERLY_BROKER_ID,
    chainId: env.ORDERLY_EIP712_CHAIN_ID ?? env.CHAIN_ID,
    builderAccountId,
    builderKey: builderKey.key,
    keyFor: (id) => keys.opsKeyForAccount(id),
    signer: ops,
    ...(env.ORDERLY_LEDGER_ADDRESS ? { ledgerAddress: env.ORDERLY_LEDGER_ADDRESS as Address } : {}),
    ...(env.ORDERLY_ORACLE_WS_URL ? { oracleWsUrl: env.ORDERLY_ORACLE_WS_URL } : {}),
  });

  const ctx: OpsContext = {
    settings: {
      mode: env.ORDERLY_MODE,
      brokerId: env.ORDERLY_BROKER_ID,
      builderAccountId,
      tradeKeyTtlMs: env.OPS_TRADE_KEY_TTL_DAYS * DAY,
      opsKeyTtlMs: env.OPS_OPS_KEY_TTL_DAYS * DAY,
      feeGraceSec: env.OPS_FEE_SETTLE_GRACE_S,
      feeAuto: env.OPS_FEE_SWEEP_AUTO,
      withdrawMaxAttempts: env.OPS_WITHDRAW_MAX_ATTEMPTS,
      priceSource: env.ORDERLY_SYMBOL_PRICE_SOURCE,
      logMaxRange: BigInt(env.OPS_LOG_MAX_RANGE),
      reportMaxDropBps: env.OPS_REPORT_MAX_DROP_BPS,
      reportDropConfirmations: env.OPS_REPORT_DROP_CONFIRMATIONS,
      reportSettleSec: env.OPS_REPORT_SETTLE_S,
    },
    chain,
    store,
    sagas,
    keys,
    builder,
    readAccount: (accountId, symbol, key) => new OrderlyVenue({ baseUrl: env.ORDERLY_BASE_URL, accountId, symbol, tradeKey: key, mode: env.ORDERLY_MODE }).account(),
    cancelAll: (accountId, symbol, key) => new OrderlyVenue({ baseUrl: env.ORDERLY_BASE_URL, accountId, symbol, tradeKey: key, mode: env.ORDERLY_MODE }).cancelAll(),
    locks: new KeyedMutex(),
    log,
    now: Date.now,
  };
  const service = new OpsService(ctx, new Provisioner(ctx, builderKey));
  log.info({ ops: ops.address, builderAccountId, books: dep.books.length }, "deployment loaded");

  const worker = new Worker<VenueOpsJob>(
    QUEUES.venueOps,
    async (job) => {
      log.info({ jobId: job.id, kind: job.data.kind, bookId: job.data.bookId }, "venue-ops job");
      return service.handleJob(job.data);
    },
    { connection: { url: env.REDIS_URL, maxRetriesPerRequest: null }, concurrency: env.OPS_WORKER_CONCURRENCY },
  );
  worker.on("failed", (job, err) => log.warn({ jobId: job?.id, kind: job?.data.kind, err: errMsg(err) }, "venue-ops job failed"));
  worker.on("error", (err) => log.warn({ err: errMsg(err) }, "venue-ops worker error"));

  const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  sub.on("error", (err) => log.warn({ err: errMsg(err) }, "redis subscriber error"));
  sub.on("pmessage", (_pattern: string, _channel: string, message: string) => {
    service.onKillMessage(message).catch((err) => log.error({ err: errMsg(err) }, "kill handling failed"));
  });
  await sub.psubscribe(KILL_PATTERN).catch((err) => log.warn({ err: errMsg(err) }, "kill channel subscribe failed (redis down?) — revoke_key jobs and mandate Kill logs still apply"));

  await service.run(abort.signal, { bookPollMs: env.OPS_BOOK_POLL_MS, logPollMs: env.OPS_LOG_POLL_MS, reportMs: env.OPS_REPORT_INTERVAL_MS, feePollMs: env.OPS_FEE_POLL_MS });
  builder.close();
  await cleanup([() => worker.close(), () => sub.quit()], redis, pg.close);
}

async function cleanup(fns: Array<() => Promise<unknown>>, redis: Redis, closeDb: () => Promise<void>) {
  for (const f of fns) await f().catch(() => undefined);
  await redis.quit().catch(() => undefined);
  await closeDb().catch(() => undefined);
  log.info("ops-venue stopped");
}

let stopping = false;
const stop = (sig: string) => {
  if (stopping) return;
  stopping = true;
  log.info({ sig }, "shutting down");
  abort.abort();
  setTimeout(() => process.exit(0), 8000).unref();
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.fatal({ err: errMsg(err) }, "ops-venue crashed");
    process.exit(1);
  });
