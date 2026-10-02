// @bookrunner/api — public API service (port API_PORT, default 4400).
// Run: `bun run start` (this file is the entry when executed directly).
import { createDb } from "@bookrunner/db";
import { type Logger, createLogger } from "@bookrunner/shared";
import { Redis } from "ioredis";
import { createApp } from "./app";
import { DeploymentWatcher } from "./chain/deployment";
import { HttpCharterServiceClient } from "./charterService";
import { type ApiConfig, loadApiConfig } from "./config";
import { DrizzleReadModel, DrizzleWebhookStore } from "./data/drizzle";
import type { ApiDeps } from "./deps";
import { RedisKv } from "./kv";
import { WebhookDispatcher } from "./webhooks/dispatcher";
import { createWebhookQueue, createWebhookWorker } from "./webhooks/queue";
import { dnsResolveHost, parseAllowHosts } from "./webhooks/target";

export { createApp } from "./app";
export type { ApiDeps } from "./deps";
export { appRouter, createCaller, type AppRouter } from "./router";
export { verifyWebhookSignature, signatureHeader, SIGNATURE_HEADER } from "./webhooks/signature";

/** Rate-limited logger for noisy connection errors (Redis reconnect loops). */
function throttled(log: Logger, msg: string, everyMs = 30_000) {
  let last = 0;
  return (err: unknown) => {
    if (Date.now() - last < everyMs) return;
    last = Date.now();
    log.warn({ err }, msg);
  };
}

export async function startApi(env: ApiConfig = loadApiConfig()) {
  const log = createLogger("api", env.LOG_LEVEL);
  const closers: Array<{ name: string; close: () => Promise<unknown> | unknown }> = [];

  // Redis: fast-failing connection for reads/cache (misses on outage), blocking-safe ones for BullMQ.
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
  redis.on("error", throttled(log, "redis (kv) connection error; live state degraded"));
  const kv = new RedisKv(redis, (err, op) => log.debug({ err, op }, "redis kv op failed"));

  const { db, close: closeDb } = createDb(env.DATABASE_URL);
  const data = new DrizzleReadModel(db);
  const webhooks = new DrizzleWebhookStore(db);

  const watcher = new DeploymentWatcher({
    file: env.DEPLOYMENT_FILE,
    chainId: env.CHAIN_ID,
    rpcUrl: env.RPC_URL,
    kv,
    cacheTtlSeconds: env.CHAIN_CACHE_TTL_SECONDS,
    log,
  });
  watcher.start();
  closers.push({ name: "deployment-watcher", close: () => watcher.stop() });

  const deps: ApiDeps = {
    settings: {
      chainId: env.CHAIN_ID,
      markIntervalSeconds: env.MARK_INTERVAL_SECONDS,
      receiptsIntervalSeconds: env.RECEIPTS_INTERVAL_SECONDS,
      maxPriceAgeSeconds: env.MAX_PRICE_AGE_SECONDS,
      adminToken: env.API_ADMIN_TOKEN,
      webhookAllowHosts: [...parseAllowHosts(env.WEBHOOK_ALLOW_HOSTS)],
    },
    log,
    data,
    webhooks,
    kv,
    chain: () => watcher.current,
    charterService: env.CHARTER_URL ? new HttpCharterServiceClient(env.CHARTER_URL, env.CHARTER_VALIDATE_PATH, log) : null,
    now: Date.now,
    health: async () => ({
      db: await Promise.race([data.ping().then(() => "up"), new Promise<string>((r) => setTimeout(() => r("timeout"), 1500))]).catch(() => "down"),
      redis: redis.status,
      webhooks: env.WEBHOOKS_ENABLED,
    }),
  };

  if (!env.API_ADMIN_TOKEN) log.warn("API_ADMIN_TOKEN is unset: webhook management (/v1/webhooks) is disabled");

  // HTTP first: serving DB-backed reads never waits on Redis, the chain or the webhook pipeline.
  const app = createApp(deps, { origins: env.webOrigins });
  const server = Bun.serve({ port: env.API_PORT, hostname: env.API_HOST, fetch: app.fetch, idleTimeout: 120 });
  log.info({ url: `http://${env.API_HOST}:${env.API_PORT}`, origins: env.webOrigins, chainId: env.CHAIN_ID }, "api listening (/trpc, /v1, /mcp, /health)");
  closers.unshift({ name: "http", close: () => server.stop() });

  // Webhooks: dispatcher (pub/sub + events-table sweep) -> BullMQ -> worker (signed HTTP POST).
  if (env.WEBHOOKS_ENABLED) {
    const bullConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    bullConn.on("error", throttled(log, "redis (queue) connection error"));
    const workerConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    workerConn.on("error", throttled(log, "redis (worker) connection error"));
    const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    subscriber.on("error", throttled(log, "redis (subscriber) connection error"));

    const { queue, enqueue } = createWebhookQueue(bullConn, env.WEBHOOK_BACKOFF_MS, undefined, log);
    const worker = createWebhookWorker(
      workerConn,
      { store: webhooks, fetch, now: Date.now, timeoutMs: env.WEBHOOK_TIMEOUT_MS, log, allowHosts: parseAllowHosts(env.WEBHOOK_ALLOW_HOSTS), resolveHost: dnsResolveHost },
      env.WEBHOOK_CONCURRENCY,
      log,
    );
    const dispatcher = new WebhookDispatcher({ store: webhooks, enqueue, log, now: Date.now });
    await dispatcher.start(subscriber);
    closers.push(
      { name: "dispatcher", close: () => dispatcher.stop() },
      { name: "worker", close: () => worker.close() },
      { name: "queue", close: () => queue.close() },
      { name: "redis-subscriber", close: () => subscriber.quit() },
      { name: "redis-queue", close: () => bullConn.quit() },
      { name: "redis-worker", close: () => workerConn.quit() },
    );
  } else {
    log.info("webhooks disabled (WEBHOOKS_ENABLED=false)");
  }

  closers.push({ name: "redis-kv", close: () => redis.quit() }, { name: "db", close: () => closeDb() });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    for (const c of closers) {
      try {
        await Promise.race([Promise.resolve(c.close()), new Promise((r) => setTimeout(r, 5_000))]);
      } catch (err) {
        log.warn({ err, name: c.name }, "error while closing");
      }
    }
    log.info("bye");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  return { app, server, deps, shutdown };
}

if (import.meta.main) {
  startApi().catch((err) => {
    createLogger("api").fatal({ err }, "api failed to start");
    process.exit(1);
  });
}
