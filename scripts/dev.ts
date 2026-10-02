// Local orchestrator: runs every Bookrunner service + one bookrunner agent per deployed book + web,
// with prefixed, coloured logs. Requires: docker compose up -d, db:migrate, deploy:local.
//   bun scripts/dev.ts                 # everything
//   bun scripts/dev.ts api web         # only some
//   bun scripts/dev.ts --no-sim        # without trader-sim
//   bun scripts/dev.ts --network testnet   # Robinhood Chain testnet profile (.env.testnet)
//   bun scripts/dev.ts --no-web            # without the vite dev server (a server serves the built web app)
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Subprocess } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const BUN = process.execPath; // the bun running this script
const args = process.argv.slice(2);
const netIdx = args.indexOf("--network");
const network = (netIdx >= 0 ? args[netIdx + 1] : process.env.NETWORK) ?? "devnet";
if (netIdx >= 0) args.splice(netIdx, 2);
const only = args.filter((a) => !a.startsWith("--"));
const noSim = args.includes("--no-sim");
const noWeb = args.includes("--no-web");

const env: Record<string, string> = { ...(process.env as Record<string, string>) };
/** Loads KEY=VALUE lines; returns the keys it defined (null when the file is missing). */
function loadEnvFile(file: string, override: boolean): Set<string> | null {
  const path = resolve(ROOT, file);
  if (!existsSync(path)) return null;
  const keys = new Set<string>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#") && (override || env[m[1]!] === undefined)) {
      env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
      keys.add(m[1]!);
    }
  }
  return keys;
}

if (network === "testnet") {
  // Robinhood Chain testnet profile. Secrets (BKRN_TESTNET_MNEMONIC, optional RHC_TESTNET_RPC_URL,
  // ANTHROPIC_API_KEY) live in .env.testnet (gitignored). Separate DB / Redis db / state files so the
  // devnet stack's data is never mixed with testnet data.
  // NB: bun auto-loads the repo .env (devnet values) into process.env — this profile must OVERRIDE them.
  const testnetKeys = loadEnvFile(".env.testnet", true);
  if (!testnetKeys) {
    console.error("[dev] .env.testnet missing — run `bash scripts/deploy-testnet.sh` first");
    process.exit(1);
  }
  const t: Record<string, string> = {
    NETWORK: "testnet",
    CHAIN_ID: "46630",
    RPC_URL: env.RHC_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com",
    DEPLOYMENT_FILE: "contracts/deployments/46630.json",
    DATABASE_URL: "postgres://bookrunner:bookrunner@127.0.0.1:54400/bookrunner_testnet",
    REDIS_URL: "redis://127.0.0.1:63790/1",
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
    // signed venue reports (EIP-712, Redis bkrn:venue:report:<bookId>), relayed inside the mark's
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
  };
  // testnet defaults win over anything inherited; only keys set explicitly in .env.testnet override them
  for (const [k, v] of Object.entries(t)) if (!testnetKeys.has(k) || k === "CHAIN_ID" || k === "DEPLOYMENT_FILE") env[k] = v;
  if (/127\.0\.0\.1|localhost/.test(env.RPC_URL ?? "") || (env.DATABASE_URL ?? "").endsWith("/bookrunner")) {
    console.error(`[dev] refusing: testnet profile resolved to a local RPC or the devnet DB (${env.RPC_URL}, ${env.DATABASE_URL})`);
    process.exit(1);
  }
  console.log(`[dev] network: Robinhood Chain testnet (46630) via ${env.RPC_URL}`);
}
loadEnvFile(".env", false);
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
// public test chains: refill the role keys' gas from the deployer (scripts/gas-keeper.ts)
if (network === "testnet") add({ name: "gas-keeper", cwd: ROOT, cmd: [BUN, "scripts/gas-keeper.ts", "--loop"] });
if (!noWeb) add(svc("web", "apps/web", network === "testnet" ? "dev:testnet" : "dev"));

const depPath = resolve(ROOT, env.DEPLOYMENT_FILE);
const agentDir = resolve(ROOT, "services/bookrunner-agent");
const hasAgent = existsSync(resolve(agentDir, "package.json"));
const noLaunch = args.includes("--no-launch");
if (!existsSync(depPath)) console.warn(`[dev] ${env.DEPLOYMENT_FILE} not found — run \`bun run deploy:local\` first; agents start once books exist`);

if (procs.length === 0) {
  console.error("[dev] nothing to run");
  process.exit(1);
}

const running: Subprocess[] = [];
let shuttingDown = false;
const restarts = new Map<string, number>(); // service -> consecutive quick restarts (backoff)
let colorIdx = 0;
const width = 14;
function start(p: Proc) {
  const color = COLORS[colorIdx++ % COLORS.length];
  const prefix = `\x1b[${color}m${p.name.padEnd(width).slice(0, width)}\x1b[0m │ `;
  const child = Bun.spawn(p.cmd, { cwd: p.cwd, env: { ...env, ...p.extraEnv, FORCE_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  running.push(child);
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
    if (shuttingDown || code === 0 || p.name === "launch") return;
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
console.log(`[dev] started ${procs.length} processes: ${procs.map((p) => p.name).join(", ")}`);

// Agents: one per book in the deployment file, spawned as books appear (launch-devnet appends them).
const agentsStarted = new Set<number>();
let simStarted = false;
let launchStarted = false;
const wantAgents = only.length === 0 || only.includes("agent") || only.includes("trader-sim");
function readBooks(): Array<{ bookId: number; name: string }> | null {
  try {
    return (JSON.parse(readFileSync(depPath, "utf8")) as { books?: Array<{ bookId: number; name: string }> }).books ?? [];
  } catch {
    return null;
  }
}
setInterval(() => {
  const books = readBooks();
  if (books === null) return;
  if (books.length === 0 && !launchStarted && !noLaunch && only.length === 0) {
    launchStarted = true;
    console.log("[dev] no books deployed yet — running scripts/launch-devnet.ts (NVDA, TSLA, RHX5)");
    start({ name: "launch", cwd: ROOT, cmd: [BUN, "scripts/launch-devnet.ts"] });
  }
  if (!hasAgent || !wantAgents) return;
  for (const b of books) {
    if (agentsStarted.has(b.bookId)) continue;
    agentsStarted.add(b.bookId);
    start({ name: `agent:${b.name}`, cwd: agentDir, cmd: scriptCmd("services/bookrunner-agent", "start"), extraEnv: { BOOK_ID: String(b.bookId) } });
  }
  if (books.length > 0 && !simStarted && !noSim) {
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
