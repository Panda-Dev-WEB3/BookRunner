// Local orchestrator: runs every Bookrunner service + one bookrunner agent per deployed book + web,
// with prefixed, coloured logs. Requires: docker compose up -d, db:migrate, deploy:local.
//   bun scripts/dev.ts                 # everything
//   bun scripts/dev.ts api web         # only some
//   bun scripts/dev.ts --no-sim        # without trader-sim
//   bun scripts/dev.ts --network testnet   # Robinhood Chain testnet profile (.env.testnet)
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

const env: Record<string, string> = { ...(process.env as Record<string, string>) };
function loadEnvFile(file: string, override: boolean) {
  const path = resolve(ROOT, file);
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#") && (override || env[m[1]!] === undefined)) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return true;
}

if (network === "testnet") {
  // Robinhood Chain testnet profile. Secrets (BKRN_TESTNET_MNEMONIC, optional RHC_TESTNET_RPC_URL,
  // ANTHROPIC_API_KEY) live in .env.testnet (gitignored). Separate DB / Redis db / state files so the
  // devnet stack's data is never mixed with testnet data.
  if (!loadEnvFile(".env.testnet", true)) {
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
    MARK_INTERVAL_SECONDS: "300",
    RECEIPTS_INTERVAL_SECONDS: "60",
    SESSIONS_MODE: "24x7",
    ORDERLY_MODE: "mock",
    // public RPC: fewer, larger calls
    ORACLE_PUSH_INTERVAL_MS: "15000",
    ORACLE_PUSH_DEVIATION_BPS: "50",
    ORACLE_TICK_MS: "2000",
    RISK_INTERVAL_MS: "5000",
    OPS_REPORT_INTERVAL_MS: "30000",
    OPS_LOG_POLL_MS: "5000",
    INDEXER_CONFIRMATIONS: "0",
    // separate local state
    MOCK_ORDERLY_SNAPSHOT_FILE: ".data/testnet/mock-orderly.json",
    OPS_KEYS_DIR: ".data/testnet/keys",
    OPS_SAGA_FILE: ".data/testnet/ops-venue/sagas.json",
  };
  for (const [k, v] of Object.entries(t)) if (env[k] === undefined || k === "CHAIN_ID" || k === "DEPLOYMENT_FILE") env[k] = v;
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
const svc = (name: string, dir = `services/${name}`, script = "start"): Proc | null =>
  existsSync(resolve(ROOT, dir, "package.json")) ? { name, cwd: resolve(ROOT, dir), cmd: [BUN, "run", script] } : null;

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
add(svc("web", "apps/web", "dev"));

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
  void child.exited.then((code) => process.stdout.write(`${prefix}\x1b[2mexited with code ${code}\x1b[0m\n`));
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
    start({ name: `agent:${b.name}`, cwd: agentDir, cmd: [BUN, "run", "start"], extraEnv: { BOOK_ID: String(b.bookId) } });
  }
  if (books.length > 0 && !simStarted && !noSim) {
    simStarted = true;
    start({ name: "trader-sim", cwd: agentDir, cmd: [BUN, "src/trader-sim.ts"] });
  }
}, 3000);

const shutdown = () => {
  for (const c of running) c.kill("SIGTERM");
  setTimeout(() => process.exit(0), 1500);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
