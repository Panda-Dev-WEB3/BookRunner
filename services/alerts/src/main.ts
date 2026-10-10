// @bookrunner/alerts — watches the stack and alerts by email / webhook (scripts/dev.ts runs it).
//   bun src/main.ts            # loop every ALERT_INTERVAL_SECONDS (default 60)
//   bun src/main.ts --once     # one pass: print the active conditions, deliver nothing, change no state
//   bun src/main.ts --test     # send one test message through every configured channel, then exit
// Reads only: Postgres, Redis, the chain (no key, no transaction), the API's /health. Holds no signing key.
import { bkrnFeeRouterAbi, bookrunnerConfigAbi } from "@bookrunner/shared/abi";
import { tryLoadDeployment } from "@bookrunner/shared/deployments";
import { createLogger } from "@bookrunner/shared/logger";
import { redactUrl } from "@bookrunner/shared/redact";
import { Redis } from "ioredis";
import postgres from "postgres";
import { http, createPublicClient } from "viem";
import { type ChainPort, type DbPort, collect } from "./collect";
import { loadConfig } from "./config";
import { createDeliverer, pingHeartbeat } from "./deliver";
import { renderBatch } from "./format";
import { evaluate } from "./rules";
import { AlertService } from "./service";

const cfg = loadConfig();
const log = createLogger("alerts", cfg.logLevel);
const args = process.argv.slice(2);

const deliverer = createDeliverer(cfg.delivery);

if (args.includes("--test")) {
  const now = Date.now();
  const m = renderBatch(cfg.delivery.label, [{ kind: "firing", key: "test", rule: "test", severity: "warning", summary: "test message from services/alerts (--test): delivery works", at: now }], now);
  if (deliverer.channels.length === 0) {
    log.error("no channel configured: set ALERT_EMAIL_TO + ALERT_SMTP_USER + ALERT_SMTP_PASS and/or ALERT_WEBHOOK_URL");
    process.exit(1);
  }
  const res = await deliverer.deliver(m);
  for (const r of res) (r.ok ? log.info : log.error).call(log, { channel: r.channel, error: r.error }, r.ok ? "test message delivered" : "test message FAILED");
  process.exit(res.every((r) => r.ok) ? 0 : 1);
}

const sql = postgres(cfg.databaseUrl, { max: 2, idle_timeout: 60, connect_timeout: 10, onnotice: () => {} });
const db: DbPort = {
  books: () => sql<Array<{ id: number; name: string | null; symbol: string; state: string; venue: number; subscriptionEnds: Date | null }>>`
    select id::int8 as id, name, symbol, state, venue, subscription_ends as "subscriptionEnds" from books order by id`.then((r) => r.map((x) => ({ ...x, id: Number(x.id) }))),
  latestMarkPeriodEnds: () => sql<Array<{ bookId: number; periodEnd: Date }>>`
    select distinct on (book_id) book_id as "bookId", period_end as "periodEnd" from marks order by book_id, period_end desc`.then((r) => [...r]),
  killsSince: (since) => sql<Array<{ id: number; bookId: number; ts: Date; reason: string; breaches: unknown }>>`
    select id, book_id as "bookId", ts, reason, breaches from kill_events where ts > ${since} order by id`.then((r) => [...r]),
  cursors: () => sql<Array<{ name: string; block: number; updatedAt: Date }>>`
    select name, block_number as block, updated_at as "updatedAt" from chain_cursor`.then((r) => [...r]),
};

// fast-failing Redis: a read error is an infra condition, never a hang
const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
let lastRedisErr = 0;
redis.on("error", (err) => {
  if (Date.now() - lastRedisErr > 60_000) log.warn({ err: err.message }, "redis connection error");
  lastRedisErr = Date.now();
});

const client = createPublicClient({ transport: http(cfg.rpcUrl, { timeout: 10_000, retryCount: 0 }) });
const chain: ChainPort = {
  head: async () => {
    const b = await client.getBlock({ blockTag: "latest" });
    return { number: Number(b.number), timestamp: Number(b.timestamp) };
  },
  balance: (address) => client.getBalance({ address }),
  buybackPending: async () => {
    const dep = tryLoadDeployment(cfg.deploymentFile);
    if (!dep?.contracts.feeRouter) return null;
    return client.readContract({ address: dep.contracts.feeRouter, abi: bkrnFeeRouterAbi, functionName: "buybackPending" });
  },
  markInterval: async () => {
    const dep = tryLoadDeployment(cfg.deploymentFile);
    if (!dep?.contracts.config) return null;
    return Number(await client.readContract({ address: dep.contracts.config, abi: bookrunnerConfigAbi, functionName: "markInterval" }));
  },
};

const collectFn = (mem: Parameters<typeof collect>[2]) =>
  collect(
    { db, kv: { get: (k) => redis.get(k), mget: (ks) => redis.mget(...ks) }, chain, fetch, now: Date.now },
    { network: cfg.network, chainId: cfg.chainId, apiUrl: cfg.apiUrl, markIntervalSec: cfg.markIntervalSec, roles: cfg.roles, rpcWindowSec: cfg.rpcWindowSec },
    mem,
    cfg.rules.buybackGrowSec * 2 + 86_400,
  );

if (args.includes("--once")) {
  const { snapshot } = await collectFn({ rpcSamples: [], buybackSamples: [], markIntervalSec: null });
  const conds = evaluate(snapshot, { ...cfg.rules, rpcMinSamples: 1 });
  console.log(JSON.stringify({ network: cfg.network, books: snapshot.books?.length ?? null, roles: cfg.roles.length, conditions: conds }, null, 2));
  await sql.end({ timeout: 2 });
  redis.disconnect();
  process.exit(0);
}

const service = new AlertService({
  collect: collectFn,
  deliverer,
  store: { get: (k) => redis.get(k), set: async (k, v) => void (await redis.set(k, v)) },
  log,
  now: Date.now,
  heartbeat: () => pingHeartbeat(cfg.delivery.heartbeatUrl),
  rules: cfg.rules,
  delivery: cfg.delivery,
});

log.info(
  {
    network: cfg.network,
    rpc: redactUrl(cfg.rpcUrl),
    api: cfg.apiUrl,
    intervalSec: cfg.intervalSec,
    channels: deliverer.channels,
    roles: cfg.roles.map((r) => r.role),
    markGraceSec: cfg.rules.markGraceSec,
    disabled: [...cfg.rules.disabled],
    deadMansSwitch: cfg.delivery.heartbeatUrl !== null,
    digestHourUtc: cfg.delivery.digestHourUtc,
  },
  deliverer.channels.length ? "alerts service started" : "alerts service started WITHOUT a delivery channel (log only): set ALERT_EMAIL_TO + ALERT_SMTP_USER/PASS or ALERT_WEBHOOK_URL",
);

let stopping = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const loop = async () => {
  if (stopping) return;
  try {
    const r = await service.tick();
    log.debug({ active: r.conditions.length }, "pass done");
  } catch (err) {
    log.error({ err }, "alert pass failed");
  }
  if (!stopping) timer = setTimeout(loop, cfg.intervalSec * 1000);
};
// first pass after a short delay: the other services (risk, API) come up in parallel
timer = setTimeout(loop, 20_000);

const shutdown = async () => {
  stopping = true;
  if (timer) clearTimeout(timer);
  await sql.end({ timeout: 2 }).catch(() => undefined);
  redis.disconnect();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
