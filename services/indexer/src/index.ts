// indexer service: chain -> DB (ARCHITECTURE §4). Idles (log + retry) until the deployment file
// exists; transient RPC/DB errors back off exponentially; SIGINT/SIGTERM stop between steps.
import { createDb } from "@bookrunner/db";
import { type Deployment, createLogger, tryLoadDeployment } from "@bookrunner/shared";
import { Redis } from "ioredis";
import { ViemIndexerChain } from "./chain";
import { loadIndexerEnv } from "./config";
import { PgIndexerStore } from "./pgStore";
import { Indexer } from "./runner";
import { WatchSet } from "./watch";

const env = loadIndexerEnv();
const logger = createLogger("indexer", env.LOG_LEVEL);
const { db, close: closeDb } = createDb(env.DATABASE_URL, 4);
const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
redis.on("error", (err) => logger.warn({ err: err.message }, "redis error"));
redis.connect().catch((err) => logger.warn({ err: (err as Error).message }, "redis connect failed; will retry"));

let stopping = false;
let wake: (() => void) | null = null;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(t);
      wake = null;
      resolve();
    };
  });

async function waitForDeployment(): Promise<Deployment | null> {
  let attempt = 0;
  while (!stopping) {
    const dep = tryLoadDeployment(env.DEPLOYMENT_FILE);
    if (dep) return dep;
    if (attempt++ % 30 === 0) logger.warn({ file: env.DEPLOYMENT_FILE }, "deployment file missing; indexer idle (retrying)");
    await sleep(env.DEPLOYMENT_RETRY_MS);
  }
  return null;
}

async function main() {
  const dep = await waitForDeployment();
  if (!dep) return;
  if (dep.chainId !== env.CHAIN_ID) logger.warn({ deployment: dep.chainId, env: env.CHAIN_ID }, "deployment chainId differs from CHAIN_ID");
  const startBlock = env.INDEXER_START_BLOCK ?? dep.startBlock;
  logger.info({ chainId: dep.chainId, startBlock, confirmations: env.INDEXER_CONFIRMATIONS, batch: env.INDEXER_BATCH_BLOCKS }, "indexer starting");

  const indexer = new Indexer({
    store: PgIndexerStore.create(db),
    chain: new ViemIndexerChain(env.CHAIN_ID, env.RPC_URL, { charter: dep.contracts.charter, markRegistry: dep.contracts.markRegistry }, env.INDEXER_ADDRESS_CHUNK),
    watch: new WatchSet(dep),
    deployment: dep,
    publisher: redis,
    logger,
    config: { confirmations: env.INDEXER_CONFIRMATIONS, batchBlocks: env.INDEXER_BATCH_BLOCKS, poisonAttempts: env.INDEXER_POISON_ATTEMPTS, startBlock },
  });

  let backoff = env.INDEXER_POLL_MS;
  let initialised = false;
  while (!stopping) {
    try {
      if (!initialised) {
        await indexer.init();
        initialised = true;
      }
      const r = await indexer.step();
      backoff = env.INDEXER_POLL_MS;
      if (r.status === "idle") {
        await sleep(env.INDEXER_POLL_MS);
        continue;
      }
      logger.info(
        { from: Number(r.from), to: Number(r.to), logs: r.logs, applied: r.applied, skipped: r.skipped, events: r.events.length, isolated: r.isolated || undefined },
        "range indexed",
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message, retryInMs: backoff }, "indexer step failed; backing off");
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  wake?.();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled rejection"));

main()
  .catch((err) => logger.error({ err }, "indexer crashed"))
  .finally(async () => {
    await Promise.allSettled([redis.quit(), closeDb()]);
    logger.info("bye");
    process.exit(0);
  });
