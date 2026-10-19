// ops-venue service entry: Orderly builder operations for every Orderly-venue book.
//   loops : book discovery + provisioning, chain logs (withdrawals, kills, re-mandates), venue reports
//           every OPS_REPORT_INTERVAL_MS (OPS_REPORT_MODE=signed: EIP-712 signed + published to Redis
//           bkrn:<ns>:venue:report:<bookId>, no tx; onchain: adapter.report tx), builder fee sweeps per mark period
//   queue : BullMQ QUEUES.venueOps (create_symbol, fund_if, deposit_mm, execute_withdraw, report,
//           sweep_fees, revoke_key)
//   redis : CHANNELS.kill(*) -> revoke the book's venue trade key
//   listing: ORDERLY_LISTING_MODE (api in mock mode, manual in live mode by default): manual = the admin lists each
//           market in Orderly One, ops-venue re-checks GET /v1/public/info/{symbol} with backoff (worker/listing.ts)
//   live builder prices (ORDERLY_MODE=live, ORDERLY_SYMBOL_PRICE_SOURCE=builder): the oracle's venue feed
//           (KEYS.oracleVenueFeed, key + channel) -> Orderly Builder Oracle WebSocket >= 1/s per builder market
//           (src/builderOracle), state -> KEYS.builderFeedStatus for alerts
// Idles (log + retry) until contracts/deployments/<chainId>.json exists.
import { createDb } from "@bookrunner/db";
import { assertVenueSymbolConfig, CHANNELS, createLogger, QUEUES, roleSigner, tryLoadDeployment, type VenueOpsJob } from "@bookrunner/shared";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Address } from "viem";
import { builderPushEnabled, startBuilderPriceFeed } from "./builderOracle/wire";
import { ViemChain } from "./chain";
import { OrderlyBuilderClient, OrderlyVenue } from "./client";
import { loadOpsEnv, resolveBuilderAccount, resolveListingMode } from "./config";
import { parseIfBuilderAccounts, resolveIfRequirementUsd } from "./domain/ifAccount";
import { KeyStore, resolveKeysDir } from "./keys";
import { keyFromSecret } from "./orderly/auth";
import { orderlyAccountId } from "./orderly/convert";
import { FileSagaStore, PgOpsStore } from "./store";
import { errMsg, KeyedMutex, sleep } from "./util";
import type { OpsContext } from "./worker/context";
import { loadOrCreateBuilderKey, Provisioner } from "./worker/provision";
import { accountReportSigner, RedisReportPublisher, RedisStatusPublisher } from "./worker/reportSink";
import { OpsService } from "./worker/service";

const env = loadOpsEnv();
const log = createLogger("ops-venue");
const abort = new AbortController();
const DAY = 86_400_000;
/** CHANNELS.kill(bookId) = "bkrn:<ns>:risk:kill:<id>" -> pattern over all books of THIS stack (bus namespace). */
const KILL_PATTERN = CHANNELS.killPattern;

async function main() {
  log.info({ mode: env.ORDERLY_MODE, baseUrl: env.ORDERLY_BASE_URL, chainId: env.CHAIN_ID, brokerId: env.ORDERLY_BROKER_ID }, "ops-venue starting");
  assertVenueSymbolConfig({ mode: env.ORDERLY_MODE, brokerId: env.ORDERLY_BROKER_ID }); // live: books trade PERP_<T>_USDC_<broker>
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

  const ops = await roleSigner("opsVenue"); // local key or KMS (shared/signer.ts)
  const chain = new ViemChain(dep, ops, log, { chainId: env.CHAIN_ID, rpcUrl: env.RPC_URL, confirmations: env.OPS_CONFIRMATIONS, fallbackMarkInterval: env.MARK_INTERVAL_SECONDS, txPollMs: env.OPS_TX_POLL_MS });
  // G6: an admin-owned builder account needs the admin-registered key (ORDERLY_BUILDER_KEY_SECRET) and has no automated fee sweep
  const builderAccount = resolveBuilderAccount(env, orderlyAccountId(ops.address, env.ORDERLY_BROKER_ID));
  if (builderAccount.notice) log.warn({ builderAccountId: builderAccount.accountId }, builderAccount.notice);
  const builderAccountId = builderAccount.accountId;
  const builderKey = await loadOrCreateBuilderKey(keys, builderAccountId, env.ORDERLY_BUILDER_KEY_SECRET, env.OPS_OPS_KEY_TTL_DAYS * DAY, keyFromSecret);
  const builder = new OrderlyBuilderClient({
    baseUrl: env.ORDERLY_BASE_URL,
    mode: env.ORDERLY_MODE,
    brokerId: env.ORDERLY_BROKER_ID,
    chainId: env.ORDERLY_EIP712_CHAIN_ID ?? env.CHAIN_ID,
    builderAccountId,
    builderKey: builderKey.key,
    token: env.ORDERLY_TOKEN,
    keyFor: (id) => keys.opsKeyForAccount(id),
    signer: ops,
    ...(env.ORDERLY_LEDGER_ADDRESS ? { ledgerAddress: env.ORDERLY_LEDGER_ADDRESS as Address } : {}),
  });

  const statusPublisher = new RedisStatusPublisher(redis);
  const listingMode = resolveListingMode(env);
  if (listingMode === "manual") log.info("ORDERLY_LISTING_MODE=manual: markets are listed in Orderly One; ops-venue checks /v1/public/info and calls no listing / symbol-status endpoint");
  else if (env.ORDERLY_MODE === "live") log.warn("ORDERLY_LISTING_MODE=api with ORDERLY_MODE=live: posts the unverified /v1/broker/listing/* bodies (VERIFY O13 / O20)");
  const ctx: OpsContext = {
    settings: {
      mode: env.ORDERLY_MODE,
      brokerId: env.ORDERLY_BROKER_ID,
      builderAccountId,
      tradeKeyTtlMs: env.OPS_TRADE_KEY_TTL_DAYS * DAY,
      opsKeyTtlMs: env.OPS_OPS_KEY_TTL_DAYS * DAY,
      feeGraceSec: env.OPS_FEE_SETTLE_GRACE_S,
      feeAuto: builderAccount.feeAuto,
      builderAdminOwned: builderAccount.adminOwned && env.ORDERLY_MODE === "live",
      withdrawMaxAttempts: env.OPS_WITHDRAW_MAX_ATTEMPTS,
      priceSource: env.ORDERLY_SYMBOL_PRICE_SOURCE,
      logMaxRange: BigInt(env.OPS_LOG_MAX_RANGE),
      reportMaxDropBps: env.OPS_REPORT_MAX_DROP_BPS,
      reportDropConfirmations: env.OPS_REPORT_DROP_CONFIRMATIONS,
      reportSettleSec: env.OPS_REPORT_SETTLE_S,
      reportMode: env.OPS_REPORT_MODE,
      builderPush: builderPushEnabled(env),
      listingMode,
      listingRecheck: { recheckMs: env.OPS_LISTING_RECHECK_MS, recheckMaxMs: env.OPS_LISTING_RECHECK_MAX_MS, timeoutMs: env.OPS_LISTING_CHECK_TIMEOUT_MS, concurrency: env.OPS_LISTING_CHECK_CONCURRENCY },
      delistWaitMaxMs: env.OPS_DELIST_WAIT_MAX_MS,
      ifMode: env.ORDERLY_IF_MODE,
      ifBuilderAccounts: parseIfBuilderAccounts(env.ORDERLY_IF_BUILDER_ACCOUNTS),
      ifRequirementUsd: resolveIfRequirementUsd(env.ORDERLY_BASE_URL, env.ORDERLY_IF_REQUIREMENT_USD),
      ifOperatorRecheckMs: env.OPS_IF_OPERATOR_RECHECK_MS,
      ifReturnWriteOffMs: env.OPS_IF_RETURN_WRITE_OFF_MS,
      ifUnadoptedGraceMs: env.OPS_IF_UNADOPTED_GRACE_MS,
      ifWithdrawAck: new Set(env.OPS_IF_WITHDRAW_ACK.split(",").map((x) => x.trim()).filter(Boolean)),
      ifDropToleranceUsd: env.OPS_IF_DROP_TOLERANCE_USD,
      ifDropAlertMs: env.OPS_IF_DROP_ALERT_MS,
      ifBindingRecheckMs: env.OPS_IF_BINDING_RECHECK_MS,
      ifReassignNoticeMs: env.OPS_IF_REASSIGN_NOTICE_MS,
      native: { topUpMaxWei: env.OPS_NATIVE_TOPUP_MAX_WEI, headroom: env.OPS_NATIVE_FEE_HEADROOM, cooldownMs: env.OPS_NATIVE_TOPUP_COOLDOWN_MS },
    },
    chain,
    store,
    sagas,
    keys,
    builder,
    readAccount: (accountId, symbol, key) => new OrderlyVenue({ baseUrl: env.ORDERLY_BASE_URL, accountId, symbol, tradeKey: key, mode: env.ORDERLY_MODE, token: env.ORDERLY_TOKEN }).account(),
    cancelAll: (accountId, symbol, key) => new OrderlyVenue({ baseUrl: env.ORDERLY_BASE_URL, accountId, symbol, tradeKey: key, mode: env.ORDERLY_MODE }).cancelAll(),
    locks: new KeyedMutex(),
    log,
    now: Date.now,
    reportSigner: accountReportSigner(ops, env.CHAIN_ID),
    reportPublisher: new RedisReportPublisher(redis),
    status: statusPublisher,
  };
  if (env.ORDERLY_IF_MODE === "builder") log.warn({ books: [...parseIfBuilderAccounts(env.ORDERLY_IF_BUILDER_ACCOUNTS).keys()] }, "ORDERLY_IF_MODE=builder (FALLBACK): IF accounts are operator-EOA accounts (adapter.setIfAccountOwner), i.e. IF custody with one operator key; the operator registers ops-venue's IF keys and performs IF withdrawals (VERIFY O10)");
  const service = new OpsService(ctx, new Provisioner(ctx, builderKey));
  log.info({ ops: ops.address, builderAccountId, books: dep.books.length, reportMode: env.OPS_REPORT_MODE }, "deployment loaded");

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

  // ---- live builder price push (docs/VERIFY.md O18)
  const builderFeed = await startBuilderPriceFeed({
    env,
    log,
    builderAccountId,
    builderKey: builderKey.key,
    keyFromSecret,
    books: () => service.registry.list(),
    redis,
    sub,
    publishStatus: (s) => statusPublisher.builderFeed(s),
    signal: abort.signal,
  });

  await service.run(abort.signal, { bookPollMs: env.OPS_BOOK_POLL_MS, logPollMs: env.OPS_LOG_POLL_MS, reportMs: env.OPS_REPORT_INTERVAL_MS, feePollMs: env.OPS_FEE_POLL_MS });
  await builderFeed?.stop();
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
