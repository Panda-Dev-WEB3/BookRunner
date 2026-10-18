// One-off migration of a running stack's Redis keys to the per-stack bus namespace (packages/shared queues.ts):
// `bkrn:<x>` -> `bkrn:<ns>:<x>` for the shared keys (risk state + journal meta, signed venue reports, oracle last /
// bundle / venue feed, agent quote / heartbeat, live NAV, ops-venue status keys, supervisor status). Service-private keys
// (alerts state, API cache, waterfall no-distribution signals, the backup status) keep their names. BullMQ jobs of the
// old queue names (bull:bkrn-<queue>:*) are not moved: the schedulers re-enqueue from chain state (mark, settlements),
// so drain or ignore them (docs/RUNBOOK.md "Bus namespace").
//   REDIS_URL=redis://:<pw>@127.0.0.1:63790/1 bun scripts/bus-migrate.ts --ns testnet            # dry run: the plan
//   REDIS_URL=... bun scripts/bus-migrate.ts --ns testnet --apply                                 # RENAMENX each key
// Run it with the stack STOPPED, once, right before starting the new code. Never overwrites a key (RENAMENX).
import { RedisClient } from "bun";

/** Old (pre-namespace) key prefixes of the shared KEYS, as they were named before the bus namespace. */
export const LEGACY_PREFIXES = [
  "bkrn:oracle:last:",
  "bkrn:oracle:bundle",
  "bkrn:oracle:venue-feed",
  "bkrn:venue:report:",
  "bkrn:risk:state:",
  "bkrn:agent:hb:",
  "bkrn:agent:quote:",
  "bkrn:nav:live:",
  "bkrn:ops-venue:symbol-issues",
  "bkrn:ops-venue:builder-feed",
  "bkrn:supervisor:status",
] as const;

/** Pure: [from, to] renames for the keys present (only legacy shared keys; already namespaced ones untouched). */
export function migrationPlan(keys: readonly string[], ns: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const k of keys) {
    if (!LEGACY_PREFIXES.some((p) => k === p || (p.endsWith(":") && k.startsWith(p)))) continue;
    out.push([k, `bkrn:${ns}:${k.slice("bkrn:".length)}`]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--ns");
  const ns = i >= 0 ? argv[i + 1] : undefined;
  if (!ns || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(ns)) throw new Error("--ns <namespace> is required (devnet | testnet | testnet-live | mainnet)");
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set (the stack's Redis and db, e.g. redis://:<pw>@127.0.0.1:63790/1)");
  const apply = argv.includes("--apply");
  const c = new RedisClient(url, { connectionTimeout: 5_000, autoReconnect: false });
  await c.connect();
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = (await c.send("SCAN", [cursor, "MATCH", "bkrn:*", "COUNT", "500"])) as [string, string[]];
    keys.push(...batch);
    cursor = next;
  } while (cursor !== "0");
  const plan = migrationPlan(keys, ns);
  console.log(`[bus-migrate] ${plan.length} key(s) to rename into namespace "${ns}"${apply ? "" : " (dry run: --apply to rename)"}`);
  let done = 0;
  for (const [from, to] of plan) {
    if (!apply) {
      console.log(`  ${from} -> ${to}`);
      continue;
    }
    const ok = Number(await c.send("RENAMENX", [from, to])) === 1;
    if (ok) done++;
    else console.log(`  skipped ${from}: ${to} already exists`);
  }
  if (apply) console.log(`[bus-migrate] renamed ${done} / ${plan.length}`);
  c.close();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[bus-migrate] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
}
