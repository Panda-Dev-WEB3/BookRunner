// Local orchestrator: runs every Bookrunner service + one bookrunner agent per deployed book + web,
// with prefixed, coloured logs. Requires: docker compose up -d, db:migrate, deploy:local.
//   bun scripts/dev.ts                 # everything
//   bun scripts/dev.ts api web         # only some
//   bun scripts/dev.ts --no-sim        # without trader-sim
//   bun scripts/dev.ts --network testnet   # Robinhood Chain testnet profile (.env.testnet)
//   bun scripts/dev.ts --network testnet-live   # live-Orderly rehearsal stack NEXT TO the public testnet: real Orderly
//                                          # testnet, own mnemonic (BKRN_TESTNET_LIVE_MNEMONIC), 46630.live.json, DB, own Redis (63791) + bus ns,
//                                          # .data/testnet-live, ports 4500/4510/4530; no mock-orderly / trader-sim / web
//                                          # (.env.testnet-live; scripts/network-profile.ts testnetLiveProfile; bookrunner@testnet-live)
//   bun scripts/dev.ts --network mainnet   # Robinhood Chain MAINNET (4663): scripts/network-profile.ts
//   bun scripts/dev.ts --no-web            # without the vite dev server (a server serves the built web app)
//
// Mainnet: env from the process only (systemd EnvironmentFile, deploy/server/MAINNET.md), never .env files;
// daily marks, live Orderly, real oracle sources, no trader-sim / mock-orderly / gas-keeper / launch / web;
// refuses to start while any required env, role signer or the DeployMainnet record is missing, or while a
// mnemonic is present.
//
// Secrets are scoped per child (packages/shared/src/childenv.ts): the API, indexer, receipts and web get
// no mnemonic / private key, only the signing services get the role mnemonic, ANTHROPIC_API_KEY goes to
// the charter service only, and the protocol-admin opt-in to the one-shot launch script only.
//
// Supervisor heartbeat: the state of every child (running / backoff / exited, recent exits) is published
// to Redis (packages/shared/src/supervisor.ts) every 15 s and on every exit, so services/alerts sees an
// exited or crash-looping service without reading the log file.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RedisClient, type Subprocess } from "bun";
import { childEnv } from "../packages/shared/src/childenv";
import { ADMIN_KEY_OPT_IN, type DevRole, hasDerivedKeys, roleAccount } from "../packages/shared/src/devkeys";
import { redactUrl } from "../packages/shared/src/redact";
import {
  SUPERVISOR_PUBLISH_MS,
  SUPERVISOR_TTL_MS,
  type SupervisedProc,
  newProc,
  parseSupervisorStatus,
  recordExit,
  recordStart,
  supervisorStatus,
} from "../packages/shared/src/supervisor";
import { roleSigner } from "../packages/shared/src/signer";
import { busNames, busNamespace } from "../packages/shared/src/queues";
import { describeMigration, migrateBus } from "./bus-migrate";
import { parseEnvText } from "./env-file";
import {
  LIVE_MNEMONIC_ENV,
  MAINNET_EXCLUDED,
  TESTNET_LIVE_EXCLUDED,
  type TestnetVariant,
  deskKeyEnvFor,
  liveUnitExplicitKeys,
  mainnetProfile,
  otherVariant,
  supervisorConflict,
  testnetLiveProfile,
  testnetOrderlyLive,
  variantDeployer,
  watchedRoleAddresses,
} from "./network-profile";

const ROOT = resolve(import.meta.dir, "..");
const BUN = process.execPath; // the bun running this script
const args = process.argv.slice(2);
const netIdx = args.indexOf("--network");
const network = (netIdx >= 0 ? args[netIdx + 1] : process.env.NETWORK) ?? "devnet";
if (netIdx >= 0) args.splice(netIdx, 2);
if (!["devnet", "testnet", "testnet-live", "mainnet"].includes(network)) {
  console.error(`[dev] unknown network "${network}" (devnet | testnet | testnet-live | mainnet)`);
  process.exit(1);
}
const mainnet = network === "mainnet";
const only = args.filter((a) => !a.startsWith("--"));
const noSim = mainnet || args.includes("--no-sim");
const noWeb = mainnet || args.includes("--no-web");

const env: Record<string, string> = { ...(process.env as Record<string, string>) };
/** --network testnet-live: the live-Orderly rehearsal stack next to the public testnet (scripts/network-profile.ts testnetLiveProfile) */
const liveVenue = network === "testnet-live";
const testnetLike = network === "testnet" || liveVenue;
/** Reads KEY=VALUE lines without applying them (null when the file is missing). */
function readEnvFile(file: string): Array<[string, string]> | null {
  const path = resolve(ROOT, file);
  if (!existsSync(path)) return null;
  // THE env-file rule (scripts/env-file.ts): a key defined twice refuses the file (no first-vs-last ambiguity)
  const f = parseEnvText(readFileSync(path, "utf8"));
  if (f.duplicates.length) {
    console.error(`[dev] refusing: ${file} defines ${f.duplicates.join(", ")} more than once (keep exactly one line per key)`);
    process.exit(1);
  }
  return Object.entries(f.values);
}
/** Loads KEY=VALUE lines; returns the keys it defined (null when the file is missing). */
function loadEnvFile(file: string, override: boolean): Set<string> | null {
  const lines = readEnvFile(file);
  if (!lines) return null;
  const keys = new Set<string>();
  for (const [k, v] of lines) {
    if (override || env[k] === undefined) {
      env[k] = v;
      keys.add(k);
    }
  }
  return keys;
}
/** The public testnet stack's .env.testnet as read (never applied), for the live stack's shared-key refusal. */
function publicTestnetEnv(): Record<string, string> | null {
  const lines = readEnvFile(".env.testnet");
  return lines ? Object.fromEntries(lines) : null;
}

if (testnetLike) {
  // Robinhood Chain testnet profile. Secrets (BKRN_TESTNET_MNEMONIC, optional RHC_TESTNET_RPC_URL,
  // ANTHROPIC_API_KEY) live in .env.testnet (gitignored). Separate DB / Redis db / state files so the
  // devnet stack's data is never mixed with testnet data.
  // NB: bun auto-loads the repo .env (devnet values) into process.env — this profile must OVERRIDE them.
  // testnet-live: its own env (.env.testnet-live over the process env, e.g. the unit's /etc/bookrunner/testnet-live.env);
  // the public stack's .env.testnet is only read, to refuse a shared key, never applied
  // live without .env.testnet-live (the server: the unit's root-owned /etc/bookrunner/testnet-live.env, parsed by systemd):
  // only the DOCUMENTED override names the unit set count as explicit (TESTNET_LIVE_UNIT_OVERRIDES), never every key
  const testnetKeys = liveVenue ? (loadEnvFile(".env.testnet-live", true) ?? liveUnitExplicitKeys(process.env)) : loadEnvFile(".env.testnet", true);
  if (!testnetKeys) {
    console.error("[dev] .env.testnet missing — run `bash scripts/deploy-testnet.sh` first");
    process.exit(1);
  }
  // Infra passwords (server: deploy/server/.env.infra via the unit's EnvironmentFile; generated by
  // install.sh). Unset = the historical local defaults (Postgres "bookrunner", Redis without auth).
  const pgPassword = env.POSTGRES_PASSWORD || "bookrunner";
  const redisAuth = env.REDIS_PASSWORD ? `:${encodeURIComponent(env.REDIS_PASSWORD)}@` : "";
  const t: Record<string, string> = {
    NETWORK: "testnet",
    BKRN_BUS_NS: "testnet", // bus namespace of the public testnet stack (the live variant pins testnet-live)
    CHAIN_ID: "46630",
    RPC_URL: env.RHC_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com",
    DEPLOYMENT_FILE: "contracts/deployments/46630.json",
    DATABASE_URL: `postgres://bookrunner:${encodeURIComponent(pgPassword)}@127.0.0.1:54400/bookrunner_testnet`,
    REDIS_URL: `redis://${redisAuth}127.0.0.1:63790/1`,
    // LOW-GAS profile (docs/LOW_GAS.md: one commitAndApply tx per book per period, no oracle / report
    // loops). MARK_INTERVAL must equal the on-chain markInterval set at deploy (scripts/deploy-testnet.sh
    // uses the same 3600; mainnet is daily = 86400) — the cadence is decided at deploy time.
    MARK_INTERVAL_SECONDS: "3600",
    RECEIPTS_INTERVAL_SECONDS: "300",
    SESSIONS_MODE: "24x7",
    ORDERLY_MODE: "mock",
    // docs/LOW_GAS.md: pull oracle — no timer pushes; consumers carry the signed bundle (Redis / GET
    // /prices/signed) in their own tx. The two push settings below only apply with ORACLE_PUSH_MODE=heartbeat.
    ORACLE_PUSH_MODE: "pull",
    ORACLE_PUSH_INTERVAL_MS: "180000",
    ORACLE_PUSH_DEVIATION_BPS: "50",
    ORACLE_TICK_MS: "2000",
    RISK_INTERVAL_MS: "5000",
    // signed venue reports (EIP-712, Redis bkrn:<ns>:venue:report:<bookId>), relayed inside the mark's
    // commitAndApply tx: no report txs, so a short interval costs no gas and keeps risk + marks fresh
    OPS_REPORT_MODE: "signed",
    OPS_REPORT_INTERVAL_MS: "60000",
    OPS_LOG_POLL_MS: "5000",
    // in-house quote: re-send at most once a minute, only on meaningful changes
    ENGINE_MIN_RESEND_MS: "300000", // quote = spread/skew around the price each trade carries: 5 min is plenty
    ENGINE_REFRESH_MS: "900000",
    ENGINE_SPREAD_THRESHOLD_BPS: "10",
    ENGINE_SKEW_THRESHOLD_BPS: "10",
    // simulated takers (demo activity; traders pay their own gas)
    TRADER_SIM_TRADES_PER_MIN: "1",
    INDEXER_CONFIRMATIONS: "0",
    // separate local state
    MOCK_ORDERLY_SNAPSHOT_FILE: ".data/testnet/mock-orderly.json",
    OPS_KEYS_DIR: ".data/testnet/keys",
    OPS_SAGA_FILE: ".data/testnet/ops-venue/sagas.json",
    // committed-mark rows waiting for Postgres: under .data (the unit's writable state), not the default tmpdir,
    // which is the unit's PrivateTmp and is emptied on every restart (HARDENING.md, audit 2026-10)
    MARK_SPOOL_DIR: ".data/testnet/mark-spool",
  };
  // testnet defaults win over anything inherited; only keys set explicitly in .env.testnet override them
  for (const [k, v] of Object.entries(t)) if (!testnetKeys.has(k) || k === "CHAIN_ID" || k === "DEPLOYMENT_FILE") env[k] = v;
  if (!liveVenue && testnetOrderlyLive(env)) {
    // the public stack never flips to live Orderly: the rehearsal is its own stack with its own keys
    console.error("[dev] ORDERLY_MODE=live in .env.testnet: the live-Orderly rehearsal is a separate stack, run `dev.ts --network testnet-live` (bookrunner@testnet-live) with its own .env.testnet-live");
    process.exit(1);
  }
  if (liveVenue) {
    // live-Orderly rehearsal: real Orderly testnet venue, own mnemonic / record / DB / Redis instance + bus namespace / state / ports
    const live = testnetLiveProfile(env, testnetKeys, ROOT, only, publicTestnetEnv());
    if (live.errors.length > 0) {
      console.error(`[dev] refusing to start the testnet-live stack (${live.errors.length} problem(s)):`);
      for (const e of live.errors) console.error(`[dev]   - ${e}`);
      process.exit(1);
    }
    Object.assign(env, live.env);
    delete env[LIVE_MNEMONIC_ENV]; // mapped to BKRN_TESTNET_MNEMONIC (the role mnemonic) above; never passed on twice
    delete env.REDIS_LIVE_URL; // folded into REDIS_URL (may carry the password: children get REDIS_URL only)
    env.MOCK_ORDERLY_SNAPSHOT_FILE = ".data/testnet-live/mock-orderly.json"; // unused (no mock venue), never the public file
    console.log(`[dev] venue: LIVE Orderly testnet (${env.ORDERLY_BASE_URL}, broker ${env.ORDERLY_BROKER_ID}, ${env.DEPLOYMENT_FILE}); API :${env.API_PORT}; no mock-orderly / trader-sim / web`);
  }
  if (/127\.0\.0\.1|localhost/.test(env.RPC_URL ?? "") || (env.DATABASE_URL ?? "").endsWith("/bookrunner")) {
    console.error(`[dev] refusing: testnet profile resolved to a local RPC or the devnet DB (${redactUrl(env.RPC_URL ?? "")}, ${redactUrl(env.DATABASE_URL ?? "")})`);
    process.exit(1);
  }
  console.log(`[dev] network: Robinhood Chain testnet (46630) via ${redactUrl(env.RPC_URL ?? "")}`);
}
if (mainnet) {
  const profile = mainnetProfile(env, ROOT, only);
  if (profile.errors.length > 0) {
    console.error(`[dev] refusing to start the MAINNET stack (${profile.errors.length} problem(s)):`);
    for (const e of profile.errors) console.error(`[dev]   - ${e}`);
    process.exit(1);
  }
  Object.assign(env, profile.env);
  // the WebSocket URL carries the provider key: only whether the log subscriptions are on is printed
  console.log(`[dev] network: Robinhood Chain MAINNET (4663) via ${redactUrl(env.RPC_URL ?? "")}; log subscriptions ${env.RPC_WS_URL ? "on (RPC_WS_URL)" : "off (polling: set RHC_WS_URL, or an Alchemy RHC_RPC_URL)"}`);
} else {
  loadEnvFile(".env", false);
}
env.DEPLOYMENT_FILE ??= "contracts/deployments/31337.json";

interface Proc {
  name: string;
  cwd: string;
  cmd: string[];
  extraEnv?: Record<string, string>;
}

const COLORS = [36, 33, 35, 32, 34, 91, 92, 93, 94, 95, 96, 31];
/** `bun <file>` scripts run directly (one process per service instead of a `bun run` wrapper + child). */
function scriptCmd(dir: string, script: string): string[] {
  try {
    const s = (JSON.parse(readFileSync(resolve(ROOT, dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts?.[script];
    const m = s?.match(/^bun (\S+\.tsx?)$/);
    if (m) return [BUN, m[1]!];
  } catch {
    // unreadable package.json: fall back to bun run
  }
  return [BUN, "run", script];
}
const svc = (name: string, dir = `services/${name}`, script = "start"): Proc | null =>
  existsSync(resolve(ROOT, dir, "package.json")) ? { name, cwd: resolve(ROOT, dir), cmd: scriptCmd(dir, script) } : null;

const procs: Proc[] = [];
const add = (p: Proc | null) => {
  if (p && mainnet && MAINNET_EXCLUDED.has(p.name)) return; // simulators / mocks / testnet helpers
  if (p && liveVenue && TESTNET_LIVE_EXCLUDED.has(p.name)) return; // no mock venue on the live-Orderly testnet profile
  if (p && (only.length === 0 || only.includes(p.name) || only.some((o) => p.name.startsWith(`${o}:`)))) procs.push(p);
};

// order matters only for readability; every service retries until its dependencies are up
add(svc("mock-orderly"));
add(svc("oracle"));
add(svc("indexer"));
add(svc("charter"));
add(svc("ops-venue"));
add(svc("risk"));
add(svc("receipts"));
add(svc("waterfall"));
add(svc("mark"));
add(svc("api"));
// read-only watcher: email / webhook alerts (marks, risk, kills, processes, gas, RPC, venue reports, API)
add(svc("alerts"));
// public test chains: refill the role keys' gas from the dedicated funder key (scripts/gas-keeper.ts)
if (testnetLike) add({ name: "gas-keeper", cwd: ROOT, cmd: [BUN, "scripts/gas-keeper.ts", "--loop"] });

// mock-orderly only needs ops-venue's ADDRESS (its delegate signer): derive it here, so it gets no mnemonic
if (env.MOCK_ORDERLY_DELEGATE_SIGNERS === undefined && hasDerivedKeys(env)) {
  try {
    env.MOCK_ORDERLY_DELEGATE_SIGNERS = roleAccount("opsVenue", env).address;
  } catch {
    // no derivable key: mock-orderly falls back to its own default
  }
}
// alerts watches the role keys' gas: hand it their ADDRESSES (derived here, so it never gets a key).
// Local keys and per-book desk keys (DESK_KEY_PRIVATE_KEY_<bookId>) are derived; KMS-signed roles (mainnet) are
// resolved through the role signer (one GetPublicKey each, best effort). The protocol-admin key is never derived
// for this; an explicit ALERT_ROLE_ADDRESSES wins.
const WATCHED_ROLES: DevRole[] = [
  "markSigner", "risk", "opsVenue", "keeper", "oracleSigner", "jury", "deskKeyIndex", "deskKeyNvda", "deskKeyTsla",
  "trader0", "trader1", "trader2", "trader3", "sponsor", "committee0", "committee1", "committee2", "agentOperator", "funder",
];
if (env.ALERT_ROLE_ADDRESSES === undefined && network !== "devnet" && procs.some((p) => p.name === "alerts")) {
  const { pairs, kmsRoles } = watchedRoleAddresses(env, WATCHED_ROLES);
  for (const role of kmsRoles) {
    try {
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000));
      pairs.push(`${role}=${(await Promise.race([roleSigner(role, env), timeout])).address}`);
    } catch (err) {
      console.warn(`[dev] alerts: no address for KMS role ${role} (${(err as Error).message}); set ALERT_ROLE_ADDRESSES to watch its gas`);
    }
  }
  if (pairs.length) env.ALERT_ROLE_ADDRESSES = pairs.join(",");
}
if (!noWeb) add(svc("web", "apps/web", network === "testnet" ? "dev:testnet" : "dev"));

const depPath = resolve(ROOT, env.DEPLOYMENT_FILE);
const agentDir = resolve(ROOT, "services/bookrunner-agent");
const hasAgent = existsSync(resolve(agentDir, "package.json"));
// mainnet books are chartered by the sponsor through MarketCharter (docs/RUNBOOK.md), never by launch-devnet
const noLaunch = mainnet || args.includes("--no-launch");
if (!existsSync(depPath)) console.warn(`[dev] ${env.DEPLOYMENT_FILE} not found — run \`bun run deploy:local\` first; agents start once books exist`);

if (procs.length === 0) {
  console.error("[dev] nothing to run");
  process.exit(1);
}

// Supervisor guard (testnet variants, belt and braces next to the separate mnemonics): refuse to start while the OTHER
// variant's supervisor (its own Redis instance and bus namespace) reports the same deployer address: the same keys
// never sign twice.
const myDeployer = testnetLike ? variantDeployer(env) : null;
/** this stack's supervisor status key: its bus namespace (env as resolved by the profile, not dev.ts's own process env) */
const supervisorKey = busNames(busNamespace(env)).KEYS.supervisorStatus;
if (testnetLike && myDeployer) {
  const other = otherVariant(env, network as TestnetVariant);
  let raw: string | null = null;
  try {
    const c = new RedisClient(other.redisUrl, { connectionTimeout: 5_000, enableOfflineQueue: false, autoReconnect: false });
    await c.connect();
    raw = (await c.send("GET", [other.statusKey])) as string | null;
    c.close();
  } catch (err) {
    console.warn(`[dev] supervisor guard: the other testnet variant's status is unreadable (${(err as Error).message}); continuing`);
  }
  const conflict = supervisorConflict(parseSupervisorStatus(raw), myDeployer, Date.now(), SUPERVISOR_TTL_MS);
  if (conflict) {
    console.error(`[dev] refusing to start ${network}: ${conflict}`);
    process.exit(1);
  }
}

// Bus namespace migration (scripts/bus-migrate.ts), BEFORE any service starts: the shared keys and BullMQ queues of
// code from before the per-stack namespace move to bkrn:<ns>:… / bkrn-<ns>-…, so no service ever starts on empty
// namespaced keys (risk state + journal meta, signed venue reports, queued jobs). Idempotent (marker key), never
// overwrites a newer value. Redis must answer: the stack does not start without it (systemd restarts dev.ts).
{
  const ns = busNamespace(env);
  const url = env.REDIS_URL || "redis://127.0.0.1:63790";
  let done = false;
  for (let attempt = 1; attempt <= 12 && !done; attempt++) {
    let c: RedisClient | null = null;
    try {
      c = new RedisClient(url, { connectionTimeout: 5_000, enableOfflineQueue: false, autoReconnect: false });
      await c.connect();
      const m = await migrateBus(c, ns);
      for (const line of describeMigration(ns, m)) console.log(`[dev] ${line}`);
      done = true; // an incomplete run (logged) starts the stack too: its marker is not written, the next start retries
    } catch (err) {
      console.warn(`[dev] bus namespace migration: Redis not ready (${(err as Error).message}), attempt ${attempt}/12`);
      await new Promise((r) => setTimeout(r, 5_000));
    } finally {
      try {
        c?.close();
      } catch {
        // already closed
      }
    }
  }
  if (!done) {
    console.error(`[dev] refusing to start: the bus namespace migration could not run on ${redactUrl(url)}`);
    process.exit(1);
  }
}

const running: Subprocess[] = [];
let shuttingDown = false;
const restarts = new Map<string, number>(); // service -> consecutive quick restarts (backoff)

// ---- supervisor heartbeat (Redis, best effort: a Redis outage never affects the stack)
const supervisorStarted = Date.now();
const supervised = new Map<string, SupervisedProc>();
let supRedis: RedisClient | null = null;
async function publishSupervisor(): Promise<void> {
  try {
    if (!supRedis) {
      const c = new RedisClient(env.REDIS_URL || "redis://127.0.0.1:63790", { connectionTimeout: 5_000, enableOfflineQueue: false, autoReconnect: false });
      c.onclose = () => {
        if (supRedis === c) supRedis = null; // reconnect on the next publish
      };
      supRedis = c;
    }
    if (!supRedis.connected) await supRedis.connect();
    const status = supervisorStatus(network, supervisorStarted, supervised.values(), Date.now(), myDeployer);
    await supRedis.send("SET", [supervisorKey, JSON.stringify(status), "PX", String(SUPERVISOR_TTL_MS)]);
  } catch {
    // Redis down or restarting: the next publish retries; alerts reports the heartbeat missing if it lasts
    try {
      supRedis?.close();
    } catch {
      // already closed
    }
    supRedis = null;
  }
}
setInterval(() => void publishSupervisor(), SUPERVISOR_PUBLISH_MS);
let colorIdx = 0;
const width = 14;
function start(p: Proc) {
  const color = COLORS[colorIdx++ % COLORS.length];
  const prefix = `\x1b[${color}m${p.name.padEnd(width).slice(0, width)}\x1b[0m │ `;
  // each child sees only the secrets on its allow-list (packages/shared/src/childenv.ts)
  const child = Bun.spawn(p.cmd, { cwd: p.cwd, env: childEnv(p.name, env, { ...p.extraEnv, FORCE_COLOR: "1" }), stdout: "pipe", stderr: "pipe" });
  running.push(child);
  const prev = supervised.get(p.name);
  supervised.set(p.name, prev ? recordStart(prev, Date.now()) : newProc(p.name, Date.now(), p.name === "launch"));
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) process.stdout.write(`${prefix}${l}\n`);
    }
    if (buf.trim()) process.stdout.write(`${prefix}${buf}\n`);
  };
  void pump(child.stdout);
  void pump(child.stderr);
  const startedAt = Date.now();
  void child.exited.then((code) => {
    process.stdout.write(`${prefix}\x1b[2mexited with code ${code}\x1b[0m\n`);
    // supervisor: long-running services restart after an unexpected exit, with backoff (2s..60s);
    // one-shot jobs (launch) and clean exits don't
    const restarting = !(shuttingDown || code === 0 || p.name === "launch");
    if (!shuttingDown) {
      const sp = supervised.get(p.name);
      if (sp) supervised.set(p.name, recordExit(sp, code, Date.now(), restarting));
      void publishSupervisor();
    }
    if (!restarting) return;
    const n = Date.now() - startedAt > 120_000 ? 0 : (restarts.get(p.name) ?? 0) + 1;
    restarts.set(p.name, n);
    const delay = Math.min(60_000, 2_000 * 2 ** n);
    process.stdout.write(`${prefix}\x1b[33mrestarting in ${Math.round(delay / 1000)}s (supervisor)\x1b[0m\n`);
    setTimeout(() => {
      if (!shuttingDown) start(p);
    }, delay);
  });
  return child;
}
procs.forEach(start);
void publishSupervisor();
console.log(`[dev] started ${procs.length} processes: ${procs.map((p) => p.name).join(", ")}`);

// Agents: one per book in the deployment file, spawned as books appear (launch-devnet appends them).
const agentsStarted = new Set<number>();
let simStarted = false;
let launchStarted = false;
const wantAgents = only.length === 0 || only.includes("agent") || only.includes("trader-sim");
/** Launch still to run: no books yet, or a launch that stopped part way (launch-devnet.ts writes launch.complete). */
let launchPending = false;
function readBooks(): Array<{ bookId: number; name: string }> | null {
  try {
    const d = JSON.parse(readFileSync(depPath, "utf8")) as { books?: Array<{ bookId: number; name: string }>; launch?: { complete?: boolean } };
    const books = d.books ?? [];
    launchPending = books.length === 0 || d.launch?.complete === false;
    return books;
  } catch {
    return null;
  }
}
setInterval(() => {
  const books = readBooks();
  if (books === null) return;
  if (launchPending && !launchStarted && !noLaunch && only.length === 0) {
    launchStarted = true;
    console.log(`[dev] ${books.length === 0 ? "no books deployed yet" : "launch incomplete"} — running scripts/launch-devnet.ts (resumes per book)`);
    // the one-shot launch acts as the deployer (gas distribution, committee setup): the only child that
    // may derive the protocol-admin key from the mnemonic (devkeys ADMIN_KEY_OPT_IN)
    start({ name: "launch", cwd: ROOT, cmd: [BUN, "scripts/launch-devnet.ts"], extraEnv: { [ADMIN_KEY_OPT_IN]: "1" } });
  }
  if (!hasAgent || !wantAgents) return;
  for (const b of books) {
    if (agentsStarted.has(b.bookId)) continue;
    agentsStarted.add(b.bookId);
    // a per-book desk key (DESK_KEY_PRIVATE_KEY_<bookId>) reaches that book's agent only
    start({ name: `agent:${b.name}`, cwd: agentDir, cmd: scriptCmd("services/bookrunner-agent", "start"), extraEnv: { BOOK_ID: String(b.bookId), ...deskKeyEnvFor(env, b.bookId) } });
  }
  if (books.length > 0 && !simStarted && !noSim && !liveVenue) {
    simStarted = true;
    start({ name: "trader-sim", cwd: agentDir, cmd: [BUN, "src/trader-sim.ts"] });
  }
}, 3000);

const shutdown = () => {
  shuttingDown = true;
  for (const c of running) c.kill("SIGTERM");
  // children finish an in-flight tx + bookkeeping first; systemd's TimeoutStopSec (30 s) is the hard stop
  setTimeout(() => process.exit(0), 10_000);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
