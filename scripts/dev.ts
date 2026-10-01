// Local orchestrator: runs every Bookrunner service + one bookrunner agent per deployed book + web,
// with prefixed, coloured logs. Requires: docker compose up -d, db:migrate, deploy:local.
//   bun scripts/dev.ts                 # everything
//   bun scripts/dev.ts api web         # only some
//   bun scripts/dev.ts --no-sim        # without trader-sim
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Subprocess } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const BUN = process.execPath; // the bun running this script
const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith("--"));
const noSim = args.includes("--no-sim");

const env: Record<string, string> = { ...(process.env as Record<string, string>) };
const envFile = resolve(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#") && env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
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

// one agent per book from the deployment file
const depPath = resolve(ROOT, env.DEPLOYMENT_FILE);
if (existsSync(depPath) && existsSync(resolve(ROOT, "services/bookrunner-agent/package.json"))) {
  const dep = JSON.parse(readFileSync(depPath, "utf8")) as { books?: Array<{ bookId: number; name: string }> };
  for (const b of dep.books ?? []) {
    add({ name: `agent:${b.name}`, cwd: resolve(ROOT, "services/bookrunner-agent"), cmd: [BUN, "run", "start"], extraEnv: { BOOK_ID: String(b.bookId) } });
  }
  if (!noSim) add({ name: "trader-sim", cwd: resolve(ROOT, "services/bookrunner-agent"), cmd: [BUN, "src/trader-sim.ts"] });
} else if (!existsSync(depPath)) {
  console.warn(`[dev] ${env.DEPLOYMENT_FILE} not found — run \`bun run deploy:local\`; agents and trader-sim skipped`);
}

if (procs.length === 0) {
  console.error("[dev] nothing to run");
  process.exit(1);
}

const running: Subprocess[] = [];
const width = Math.max(...procs.map((p) => p.name.length));
procs.forEach((p, i) => {
  const color = COLORS[i % COLORS.length];
  const prefix = `\x1b[${color}m${p.name.padEnd(width)}\x1b[0m │ `;
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
});
console.log(`[dev] started ${procs.length} processes: ${procs.map((p) => p.name).join(", ")}`);

const shutdown = () => {
  for (const c of running) c.kill("SIGTERM");
  setTimeout(() => process.exit(0), 1500);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
