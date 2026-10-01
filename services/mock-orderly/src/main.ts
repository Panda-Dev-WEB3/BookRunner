// mock-orderly service entry: HTTP server (Hono on Bun.serve), taker-flow ticker, deposit indexer,
// periodic snapshot, graceful shutdown.
import { isAbsolute, resolve } from "node:path";
import { createLogger, REPO_ROOT, tryLoadDeployment } from "@bookrunner/shared";
import type { Address } from "viem";
import { createApp } from "./app";
import { DepositIndexer } from "./chain";
import { loadMockConfig } from "./config";
import { mulberry32, seedFrom } from "./rng";
import { loadSnapshot, saveSnapshot } from "./snapshot";
import { MockVenue } from "./venue";

const log = createLogger("mock-orderly");
const { env, venue: venueCfg, delegateSigners } = loadMockConfig();

const venue = new MockVenue(venueCfg);
const rng = mulberry32(seedFrom(env.MOCK_ORDERLY_SEED));
const snapshotPath = isAbsolute(env.MOCK_ORDERLY_SNAPSHOT_FILE) ? env.MOCK_ORDERLY_SNAPSHOT_FILE : resolve(REPO_ROOT, env.MOCK_ORDERLY_SNAPSHOT_FILE);

const fingerprint = () => {
  const d = tryLoadDeployment(env.DEPLOYMENT_FILE);
  return d ? `${d.chainId}:${d.contracts.orderlyVault.toLowerCase()}:${d.startBlock}` : null;
};

const indexer = new DepositIndexer({ venue, chainId: env.CHAIN_ID, rpcUrl: env.RPC_URL, deploymentFile: env.DEPLOYMENT_FILE, log });

if (env.MOCK_ORDERLY_SNAPSHOT) {
  try {
    const r = loadSnapshot(snapshotPath, venue, fingerprint());
    if (r.loaded) {
      indexer.cursor = r.cursor;
      log.info({ snapshotPath, accounts: venue.accounts.size, symbols: venue.symbols.size }, "snapshot restored");
    } else log.info({ reason: r.reason }, "starting with empty state");
  } catch (err) {
    log.warn({ err: String(err) }, "snapshot unreadable; starting with empty state");
  }
}

const app = createApp({
  venue,
  authMode: env.MOCK_ORDERLY_AUTH,
  brokerId: env.MOCK_ORDERLY_BROKER_ID,
  ledgerAddress: env.MOCK_ORDERLY_LEDGER as Address,
  delegateSigners,
  rng,
  log,
  extraState: () => ({ chain: indexer.status }),
});

const server = Bun.serve({ port: env.MOCK_ORDERLY_PORT, hostname: env.MOCK_ORDERLY_HOST, fetch: app.fetch });
log.info(
  { url: `http://${env.MOCK_ORDERLY_HOST}:${env.MOCK_ORDERLY_PORT}`, auth: env.MOCK_ORDERLY_AUTH, takerFeeBps: venueCfg.fees.takerFeeBps, settleIntervalSec: venueCfg.settleIntervalSec },
  "mock-orderly listening",
);

const abort = new AbortController();
let lastTick = Date.now();
const ticker = setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  try {
    const fills = venue.tick(dt, rng);
    if (fills.length) log.debug({ fills: fills.length }, "taker flow fills");
  } catch (err) {
    log.error({ err: String(err) }, "tick failed");
  }
}, env.MOCK_ORDERLY_TICK_MS);

const persist = () => {
  if (!env.MOCK_ORDERLY_SNAPSHOT || !venue.dirty) return;
  try {
    saveSnapshot(snapshotPath, venue, fingerprint(), indexer.cursor);
  } catch (err) {
    log.warn({ err: String(err) }, "snapshot save failed");
  }
};
const snapshotTimer = setInterval(persist, env.MOCK_ORDERLY_SNAPSHOT_MS);

const indexerDone = indexer.run(abort.signal, env.MOCK_ORDERLY_CHAIN_POLL_MS);

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log.info({ sig }, "shutting down");
  abort.abort();
  clearInterval(ticker);
  clearInterval(snapshotTimer);
  persist();
  await Promise.race([indexerDone, new Promise((r) => setTimeout(r, 2000))]);
  await server.stop(true);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
