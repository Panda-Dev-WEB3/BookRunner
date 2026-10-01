// charter service (port CHARTER_PORT=4430): intake API, model jury worker, committee upkeep.
// Starts and serves /health + drafts immediately; jury + committee loops start once
// contracts/deployments/<chainId>.json exists (polled every DEPLOYMENT_RETRY_MS).
import { createDb } from "@bookrunner/db";
import { type Deployment, createLogger, tryLoadDeployment } from "@bookrunner/shared";
import { Redis } from "ioredis";
import { CharterChain, parseLiquidityJson } from "./adapters/chain";
import { EventBus } from "./adapters/events";
import { CharterStore } from "./adapters/store";
import { syncCommittee } from "./committee/upkeep";
import { type CharterEnv, juryModels, loadCharterEnv } from "./config";
import { createApp } from "./http/app";
import { handleDraft } from "./http/draftService";
import { getCharterView, listCharterViews, lookupVerdict } from "./http/queries";
import { anthropicJuryCall, createAnthropicClient } from "./jury/modelJuror";
import { type JurorSetup, type JuryPorts, runJury } from "./jury/pipeline";
import { JuryScheduler } from "./jury/scheduler";

const env: CharterEnv = loadCharterEnv();
const logger = createLogger("charter", env.LOG_LEVEL);

const { db, close: closeDb } = createDb(env.DATABASE_URL, 5);
const store = new CharterStore(db, env.RECEIPTS_INTERVAL_SECONDS);
const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
redis.on("error", (err) => logger.warn({ err: err.message }, "redis error"));
redis.connect().catch((err) => logger.warn({ err: (err as Error).message }, "redis connect failed; will retry"));
const bus = new EventBus(store, redis, logger);

const jurors: JurorSetup = env.ANTHROPIC_API_KEY
  ? {
      kind: "models",
      models: juryModels(env),
      call: anthropicJuryCall(createAnthropicClient(env.ANTHROPIC_API_KEY), {
        maxTokens: env.JURY_MAX_TOKENS,
        temperature: env.JURY_TEMPERATURE,
        effort: env.JURY_EFFORT,
        fallbacks: env.JURY_FALLBACKS === "default",
        structuredOutput: env.JURY_STRUCTURED_OUTPUT,
        timeoutMs: env.JURY_TIMEOUT_MS,
      }),
    }
  : { kind: "rules" };
logger.info(
  { jury: jurors.kind, models: jurors.kind === "models" ? jurors.models : undefined },
  jurors.kind === "models" ? "model jury enabled" : "ANTHROPIC_API_KEY not set: deterministic rule-based jury",
);

let deployment: Deployment | null = null;
let chain: CharterChain | null = null;
let scheduler: JuryScheduler | null = null;
let committeeTimer: ReturnType<typeof setTimeout> | null = null;
let deploymentTimer: ReturnType<typeof setTimeout> | null = null;
let stopping = false;

const app = createApp({
  logger,
  draft: (body) => handleDraft(body, { chain, chainId: env.CHAIN_ID, tickers: deployment?.stockTokens ?? {}, logger }),
  getCharter: (id) => getCharterView(id, store, chain),
  listCharters: (status, limit) => listCharterViews(store, status, limit),
  getVerdict: (cid) => lookupVerdict(cid, store),
  health: async () => {
    const dbOk = await store.ping().catch(() => false);
    return { ok: dbOk, db: dbOk, redis: redis.status, deployment: deployment !== null, jury: jurors.kind };
  },
});
const server = Bun.serve({ port: env.CHARTER_PORT, fetch: app.fetch });
logger.info({ port: server.port }, "charter API listening");

function juryPorts(ch: CharterChain): JuryPorts {
  return {
    loadCharter: async (id) => {
      const r = await ch.charterRecord(id);
      return r ? { charterId: id, charter: r.charter, status: r.status, filedAt: r.filedAt } : null;
    },
    onChainVerdict: (id) => ch.juryVerdict(id),
    ruleContext: (c) => ch.ruleContext(c),
    findVerdict: (id) => store.latestVerdict(id),
    saveVerdict: (v) => store.insertVerdict(v),
    postVerdict: (id, digest, rec) => ch.postJuryVerdict(id, digest, rec),
    markPosted: (id, digest, tx) => store.markPosted(id, digest, tx),
    writeReceipt: (r) => store.insertReceipt(r),
    emit: async (e) => {
      await bus.emit(e);
    },
    committee: async () => {
      const c = await ch.committee();
      return { members: c.members.filter((m) => !/^0x0{40}$/i.test(m)), committeeWindowSec: c.committeeWindowSec };
    },
  };
}

function scheduleCommittee(ms: number) {
  if (stopping || !chain) return;
  const ch = chain;
  committeeTimer = setTimeout(async () => {
    try {
      await syncCommittee({ chain: ch, store, bus, warnSec: env.COMMITTEE_DEADLINE_WARN_SECONDS, now: new Date(), logger });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "committee sync failed; retrying");
    }
    scheduleCommittee(env.COMMITTEE_SYNC_MS);
  }, ms);
}

async function onDeployment(dep: Deployment) {
  if (dep.chainId !== env.CHAIN_ID) logger.warn({ deployment: dep.chainId, env: env.CHAIN_ID }, "deployment chainId differs from CHAIN_ID");
  deployment = dep;
  chain = new CharterChain(dep, { chainId: env.CHAIN_ID, rpcUrl: env.RPC_URL, logger, liquidity: parseLiquidityJson(env.JURY_LIQUIDITY_JSON, logger) });
  const ports = juryPorts(chain);
  scheduler = new JuryScheduler({
    redisUrl: env.REDIS_URL,
    concurrency: env.JURY_CONCURRENCY,
    pollMs: env.JURY_POLL_MS,
    logger,
    store,
    chain,
    process: (id, finalAttempt) => runJury(id, ports, { jurors, now: () => new Date(), finalAttempt }),
  });
  await scheduler.start();
  scheduleCommittee(0);
}

function waitForDeployment(attempt = 0) {
  if (stopping) return;
  const dep = tryLoadDeployment(env.DEPLOYMENT_FILE);
  if (dep) {
    logger.info({ chainId: dep.chainId, books: dep.books.length }, "deployment loaded");
    onDeployment(dep).catch(async (err) => {
      logger.error({ err }, "failed to start jury loops; retrying");
      if (committeeTimer) clearTimeout(committeeTimer);
      await scheduler?.stop().catch(() => undefined);
      scheduler = null;
      chain = null;
      deploymentTimer = setTimeout(() => waitForDeployment(attempt + 1), env.DEPLOYMENT_RETRY_MS);
    });
    return;
  }
  if (attempt === 0 || attempt % 30 === 0) {
    logger.warn({ file: env.DEPLOYMENT_FILE }, "deployment file missing; jury and committee loops idle (retrying)");
  }
  deploymentTimer = setTimeout(() => waitForDeployment(attempt + 1), env.DEPLOYMENT_RETRY_MS);
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  if (deploymentTimer) clearTimeout(deploymentTimer);
  if (committeeTimer) clearTimeout(committeeTimer);
  server.stop();
  await scheduler?.stop();
  await Promise.allSettled([redis.quit(), closeDb()]);
  logger.info("bye");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled rejection"));

waitForDeployment();
