// risk service entry: wiring + graceful shutdown. See ARCHITECTURE.md §3 flow 4 and §4 (risk row).
import { createDb } from "@bookrunner/db";
import { createLogger, publicClientFor, roleAccount, tryLoadDeployment, walletClientFor } from "@bookrunner/shared";
import { Redis } from "ioredis";
import { type Hex, zeroHash } from "viem";
import { ViemChain } from "./adapters/chain";
import { RedisMarkFeeds, chainVerifier } from "../../mark/src/adapters/feeds";
import { DrizzleStore } from "./adapters/db";
import { CachedSignedFeeds } from "./adapters/feeds";
import { createOrderlySigner } from "./adapters/orderlyAuth";
import { BullVenueOpsQueue } from "./adapters/queue";
import { RedisBus } from "./adapters/redis";
import { OrderlyVenueProvider } from "./adapters/venue";
import { loadRiskEnv, parseBookIds, settingsFromEnv } from "./config";
import { systemClock } from "./ports";
import { type ChainGateway, RiskSupervisor } from "./supervisor";
import { errMsg, withTimeout } from "./util/async";

async function main(): Promise<void> {
  const env = loadRiskEnv();
  const log = createLogger("risk", env.LOG_LEVEL);
  const settings = settingsFromEnv(env);
  const account = roleAccount("risk", process.env);
  log.info(
    {
      chainId: env.CHAIN_ID,
      rpc: env.RPC_URL,
      deploymentFile: env.DEPLOYMENT_FILE,
      riskAccount: account.address,
      intervalMs: settings.intervalMs,
      killMode: settings.killMode,
      flattenMode: settings.flattenMode,
      breachConfirmTicks: settings.breachConfirmTicks,
      orderlyMode: env.ORDERLY_MODE,
    },
    "risk service starting",
  );

  const { db, close: closeDb } = createDb(env.DATABASE_URL, 4);
  const store = new DrizzleStore(db);

  let lastRedisErr = 0;
  const onRedisError = (err: Error) => {
    const now = Date.now();
    if (now - lastRedisErr > 30_000) log.warn({ err: errMsg(err) }, "redis connection error");
    lastRedisErr = now;
  };
  const retryStrategy = (times: number) => Math.min(500 * times, 10_000);
  // fail fast while disconnected: the risk loop must never hang on Redis
  const redis = new Redis(env.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1, retryStrategy });
  redis.on("error", onRedisError);
  const queueRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, retryStrategy });
  queueRedis.on("error", onRedisError);
  const bus = new RedisBus(redis, env.RISK_REDIS_TIMEOUT_MS);
  const queue = new BullVenueOpsQueue(queueRedis, 5_000, onRedisError);

  const signer = env.RISK_ORDERLY_SECRET ? await createOrderlySigner(env.RISK_ORDERLY_SECRET, env.RISK_ORDERLY_KEY) : null;
  const pub = publicClientFor(env.CHAIN_ID, env.RPC_URL);
  const wallet = walletClientFor(env.CHAIN_ID, env.RPC_URL, account);

  const supervisor = new RiskSupervisor({
    settings,
    log,
    store,
    bus,
    queue,
    clock: systemClock,
    refreshMs: env.RISK_BOOKS_REFRESH_MS,
    bookSource: env.RISK_BOOK_SOURCE,
    bookIds: parseBookIds(env.RISK_BOOK_IDS),
    chainId: env.CHAIN_ID,
    loadDeployment: () => tryLoadDeployment(env.DEPLOYMENT_FILE),
    makeChain: (dep) =>
      new ViemChain(pub, wallet, dep, {
        txTimeoutMs: env.RISK_TX_TIMEOUT_MS,
        killLogLookbackBlocks: env.RISK_KILL_LOG_LOOKBACK_BLOCKS,
        log,
      }),
    // LOW_GAS §1-§2: value from the oracle's signed prints + ops-venue's signed reports (Redis, verified)
    makeFeeds: (dep) =>
      new CachedSignedFeeds(new RedisMarkFeeds(redis, chainVerifier(pub, { config: dep.contracts.config, oracle: dep.contracts.oracle }, env.CHAIN_ID), log), {
        ttlMs: Math.max(250, Math.floor(settings.intervalMs / 2)),
        timeoutMs: env.RISK_REDIS_TIMEOUT_MS,
      }),
    makeVenues: (chain: ChainGateway) =>
      new OrderlyVenueProvider({
        mode: env.ORDERLY_MODE,
        baseUrl: env.ORDERLY_BASE_URL,
        signer,
        timeoutMs: env.RISK_VENUE_TIMEOUT_MS,
        log,
        accountIdOf: async (ref) => {
          try {
            const id: Hex | undefined = await chain.orderlyAccountId?.(ref);
            if (id && id !== zeroHash) return id;
          } catch (err) {
            log.debug({ bookId: ref.bookId, err: errMsg(err) }, "adapter.accountId read failed; trying venue_accounts");
          }
          return store.venueAccountId(ref.bookId, "mm");
        },
      }),
  });

  const ac = new AbortController();
  const shutdown = (signal: string) => {
    if (ac.signal.aborted) return;
    log.info({ signal }, "shutdown requested; finishing in-flight ticks");
    ac.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => log.error({ err: errMsg(err) }, "unhandled rejection"));

  const running = supervisor.run(ac.signal);
  await new Promise<void>((resolve) => ac.signal.addEventListener("abort", () => resolve(), { once: true }));
  try {
    await withTimeout(running, env.RISK_SHUTDOWN_GRACE_MS, "monitor shutdown");
  } catch (err) {
    log.error({ err: errMsg(err) }, "monitors did not stop within the grace period");
  }
  await Promise.allSettled([
    withTimeout(queue.close(), 3_000, "queue close"),
    withTimeout(redis.quit(), 3_000, "redis quit"),
    withTimeout(queueRedis.quit(), 3_000, "redis quit"),
    withTimeout(closeDb(), 5_000, "db close"),
  ]);
  log.info("risk service stopped");
  process.exit(0);
}

main().catch((err) => {
  console.error(`risk service failed to start: ${errMsg(err)}`);
  process.exit(1);
});
