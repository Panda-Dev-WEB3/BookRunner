// Oracle service entry: attested multi-source prices -> Redis (per price + the signed pull bundle) +
// oracle_prices (+ AttestedOracle.pushMany in ORACLE_PUSH_MODE=heartbeat only), builder prices to the
// venue, HTTP on ORACLE_PORT (default 4410).
import { createDb } from "@bookrunner/db";
import { createLogger, roleSigner } from "@bookrunner/shared";
import type { LocalAccount } from "viem";
import { DrizzlePriceStore } from "./adapters/db";
import { type AttestationDocument, loadAttestationDocument } from "./attestation";
import { RedisPricePublisher, createRedis } from "./adapters/redis";
import { builderPriceClient } from "./adapters/venue";
import { loadOracleConfig } from "./config";
import { MAX_SAFE_PUSH_DEVIATION_BPS, createApp, serveOptions } from "./http";
import { startLoop } from "./loop";
import { Runtime } from "./runtime";
import { isProductionChain, productionProblems } from "./production";
import { OracleService } from "./service";
import { accountSigner } from "./signing";
import { buildSources } from "./sources/index";

const cfg = loadOracleConfig();
const log = createLogger("oracle", cfg.LOG_LEVEL);

/** Local key or KMS (shared/signer.ts); exits when no signer is configured for this chain. */
async function loadSignerAccount(): Promise<LocalAccount> {
  try {
    return await roleSigner("oracleSigner");
  } catch (err) {
    log.fatal({ err: (err as Error).message }, "oracle signer key unavailable");
    process.exit(1);
  }
}
const account = await loadSignerAccount();

process.on("unhandledRejection", (err) => log.error({ err: err instanceof Error ? err.message : String(err) }, "unhandled rejection"));

const redis = createRedis(cfg.REDIS_URL, log);
const database = createDb(cfg.DATABASE_URL, 3);
const store = new DrizzlePriceStore(database.db);
const { sources, market, syntheticRefused } = buildSources(cfg, log);
if (syntheticRefused) {
  // never sign predictable synthetic prices on a public chain: fail loudly instead of running source-less
  log.fatal({ chainId: cfg.CHAIN_ID }, `refusing to start: ${syntheticRefused}`);
  process.exit(1);
}
const production = isProductionChain(cfg.CHAIN_ID);
const problems = productionProblems(cfg, sources);
if (problems.length > 0) {
  // mainnet: Chainlink + an independent source, >= the minimum sources, no synthetic prices, calendar holds
  log.fatal({ chainId: cfg.CHAIN_ID, problems }, "refusing to start: mainnet oracle configuration is not production-ready");
  process.exit(1);
}

const service = new OracleService({
  log,
  sources,
  signer: accountSigner(account),
  publisher: new RedisPricePublisher(redis),
  store,
  venue: cfg.ORACLE_VENUE_PRICES ? builderPriceClient(cfg.ORDERLY_MODE, cfg.ORDERLY_BASE_URL, cfg.ORACLE_SOURCE_TIMEOUT_MS) : null,
  settings: {
    outlierBps: cfg.ORACLE_OUTLIER_BPS,
    minSources: cfg.ORACLE_MIN_SOURCES,
    maxSourceAgeMs: cfg.ORACLE_MAX_SOURCE_AGE_MS,
    sourceTimeoutMs: cfg.ORACLE_SOURCE_TIMEOUT_MS,
    pushIntervalMs: cfg.ORACLE_PUSH_INTERVAL_MS,
    pushDeviationBps: cfg.ORACLE_PUSH_DEVIATION_BPS,
    sessionsMode: cfg.SESSIONS_MODE,
    venuePrices: cfg.ORACLE_VENUE_PRICES,
    pushMode: cfg.ORACLE_PUSH_MODE,
    bundleMaxAgeMs: cfg.ORACLE_BUNDLE_MAX_AGE_MS,
    production,
  },
});

const runtime = new Runtime(cfg, log, service, account, store, market);
const loops = [
  startLoop("universe", cfg.ORACLE_UNIVERSE_REFRESH_MS, () => runtime.refresh(), log),
  startLoop("tick", cfg.ORACLE_TICK_MS, async () => void (await service.tick()), log),
];

let attestation: AttestationDocument | null = null;
if (cfg.ORACLE_ATTESTATION_FILE) {
  try {
    attestation = loadAttestationDocument(cfg.ORACLE_ATTESTATION_FILE);
  } catch (err) {
    log.fatal({ err: (err as Error).message }, "ORACLE_ATTESTATION_FILE unreadable");
    process.exit(1);
  }
} else if (production) {
  log.warn("no ORACLE_ATTESTATION_FILE: GET /attestation serves no quote (the signer must be registered with AttestedOracle.setAttestedSigner)");
}
const server = Bun.serve(serveOptions(cfg, createApp(service, attestation).fetch));
log.info(
  {
    host: cfg.ORACLE_HOST,
    port: server.port,
    signer: account.address,
    chainId: cfg.CHAIN_ID,
    pushMode: cfg.ORACLE_PUSH_MODE,
    sessionsMode: cfg.SESSIONS_MODE,
    orderlyMode: cfg.ORDERLY_MODE,
  },
  cfg.ORACLE_PUSH_MODE === "pull" ? "oracle service started (pull: no timer pushes, signed bundle in Redis + /prices/signed)" : "oracle service started (heartbeat pushes)",
);
if (cfg.ORACLE_PUSH_MODE === "heartbeat" && cfg.ORACLE_PUSH_DEVIATION_BPS > MAX_SAFE_PUSH_DEVIATION_BPS) {
  log.warn(
    { pushDeviationBps: cfg.ORACLE_PUSH_DEVIATION_BPS, maxSafeBps: MAX_SAFE_PUSH_DEVIATION_BPS },
    "ORACLE_PUSH_DEVIATION_BPS exceeds the cheapest in-house round trip: on-chain prices may lag by an arbitrageable move",
  );
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  const force = setTimeout(() => {
    log.warn("forced exit after shutdown timeout");
    process.exit(1);
  }, 15_000);
  try {
    await Promise.all(loops.map((l) => l.stop()));
    await service.idle();
    server.stop();
    await redis.quit().catch(() => redis.disconnect());
    await database.close();
  } catch (err) {
    log.error({ err: (err as Error).message }, "shutdown error");
  }
  clearTimeout(force);
  log.info("bye");
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
