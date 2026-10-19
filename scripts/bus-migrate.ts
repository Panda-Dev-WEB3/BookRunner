// Migration of a stack's Redis to the per-stack bus namespace (packages/shared queues.ts): the shared keys `bkrn:<x>` ->
// `bkrn:<ns>:<x>` (risk state + journal meta, signed venue reports, oracle last / bundle / venue feed, agent quote /
// heartbeat, live NAV, ops-venue status keys, supervisor status) and the BullMQ queues `bull:bkrn-<q>:*` ->
// `bull:bkrn-<ns>-<q>:*` (pending / delayed jobs: revoke_key, sweep_fees, webhooks, marks, ...). Service-private keys
// (alerts state, API cache, waterfall no-distribution signals, the backup status) keep their names.
//
// scripts/dev.ts runs `migrateBus` at EVERY start, BEFORE it starts any service (update.sh, manual restarts, both testnet
// units, mainnet): idempotent, a no-op once the marker key `bkrn:<ns>:bus:migrated` exists. It never overwrites a newer
// value: a legacy key whose target is absent is renamed; when the target exists (a service already wrote the new name),
// the newer of the two wins where the value carries a timestamp (ts / asOf / publishedAt / updatedAt / meta.*), else the
// target is kept and the conflict logged. A BullMQ queue moves only while its new name has no keys.
// The CLI is for inspection (dry run by default):
//   sudo sh -c '. /usr/local/lib/bookrunner-deploy/.env.infra; REDIS_URL="redis://:$REDIS_PASSWORD@127.0.0.1:63790/1" \
//     /opt/bookrunner/app/node_modules/.bin/bun /opt/bookrunner/app/scripts/bus-migrate.ts --ns testnet [--apply]'
// (the password is expanded inside sh -c, never typed on the shell line).
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

/** Legacy BullMQ queue names (before the namespace) -> their suffix in `bkrn-<ns>-<suffix>`. */
export const LEGACY_QUEUES = ["jury", "venue-ops", "marks", "receipts", "settlements", "webhooks", "events"] as const;

/** Marker key: the namespace's migration is done (JSON {v, at, moved, kept, conflicts, queues}). */
export const migratedMarkerKey = (ns: string) => `bkrn:${ns}:bus:migrated`;

/** Pure: [from, to] renames for the keys present (only legacy shared keys; already namespaced ones untouched). */
export function migrationPlan(keys: readonly string[], ns: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const k of keys) {
    if (!LEGACY_PREFIXES.some((p) => k === p || (p.endsWith(":") && k.startsWith(p)))) continue;
    out.push([k, `bkrn:${ns}:${k.slice("bkrn:".length)}`]);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

/** Unix ms a stored JSON value carries (ts / asOf / publishedAt / updatedAt, also under meta), null when none. */
export function valueTimestampMs(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o === "number") return Number.isFinite(o) && o > 0 ? toMs(o) : null; // agent heartbeat: a bare unix ms
  const pick = (x: unknown): number | null => {
    if (!x || typeof x !== "object") return null;
    const r = x as Record<string, unknown>;
    for (const f of ["ts", "updatedAt", "asOf", "publishedAt", "at"]) {
      const v = r[f];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return toMs(v);
      if (typeof v === "string" && /^\d+$/.test(v)) return toMs(Number(v));
    }
    return null;
  };
  return pick(o) ?? pick((o as { meta?: unknown } | null)?.meta);
}
const toMs = (v: number) => (v < 1e12 ? v * 1000 : v);

/** The Redis commands the migration needs (Bun's RedisClient.send, or a fake in tests). */
export interface RedisSend {
  send(command: string, args: string[]): Promise<unknown>;
}

export interface MigrationResult {
  skipped: boolean; // the marker was there: nothing done
  moved: string[]; // legacy -> new, target absent
  replacedOlder: string[]; // target existed but was older: legacy value kept under the new name
  keptNewer: string[]; // target existed and was newer: legacy key deleted
  conflicts: string[]; // target existed, no timestamp to compare: both kept, target used
  queuesMoved: string[];
  queueConflicts: string[];
}

async function scanAll(r: RedisSend, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = (await r.send("SCAN", [cursor, "MATCH", pattern, "COUNT", "500"])) as [string, string[]];
    keys.push(...batch);
    cursor = String(next);
  } while (cursor !== "0");
  return keys;
}

/**
 * Idempotent namespace migration (see the header). `apply=false` computes the same result without writing. Runs before
 * any service of the stack starts, so a target that exists was written by an earlier start of the new code.
 */
export async function migrateBus(r: RedisSend, ns: string, opts: { apply?: boolean; now?: number } = {}): Promise<MigrationResult> {
  const apply = opts.apply ?? true;
  const res: MigrationResult = { skipped: false, moved: [], replacedOlder: [], keptNewer: [], conflicts: [], queuesMoved: [], queueConflicts: [] };
  if (Number(await r.send("EXISTS", [migratedMarkerKey(ns)])) === 1) return { ...res, skipped: true };

  for (const [from, to] of migrationPlan(await scanAll(r, "bkrn:*"), ns)) {
    if (Number(await r.send("EXISTS", [to])) === 0) {
      if (apply && Number(await r.send("RENAMENX", [from, to])) !== 1) {
        res.conflicts.push(`${from} -> ${to} (target appeared meanwhile)`);
        continue;
      }
      res.moved.push(`${from} -> ${to}`);
      continue;
    }
    // the new name exists already: keep the newer value where both carry a timestamp
    const [tFrom, tTo] = await Promise.all([r.send("TYPE", [from]), r.send("TYPE", [to])]);
    const oldTs = String(tFrom) === "string" ? valueTimestampMs(await r.send("GET", [from])) : null;
    const newTs = String(tTo) === "string" ? valueTimestampMs(await r.send("GET", [to])) : null;
    if (oldTs !== null && newTs !== null) {
      if (oldTs > newTs) {
        if (apply) await r.send("RENAME", [from, to]);
        res.replacedOlder.push(`${from} -> ${to} (legacy ${new Date(oldTs).toISOString()} newer than ${new Date(newTs).toISOString()})`);
      } else {
        if (apply) await r.send("DEL", [from]);
        res.keptNewer.push(`${to} (newer than legacy ${from})`);
      }
    } else {
      res.conflicts.push(`${from} -> ${to} (target exists, no timestamp to compare: target kept, legacy key left in place)`);
    }
  }

  for (const q of LEGACY_QUEUES) {
    const oldKeys = await scanAll(r, `bull:bkrn-${q}:*`);
    if (oldKeys.length === 0) continue;
    const newName = `bkrn-${ns}-${q}`;
    if ((await scanAll(r, `bull:${newName}:*`)).length > 0) {
      res.queueConflicts.push(`bull:bkrn-${q} (${oldKeys.length} keys) -> bull:${newName}: the new queue has keys already, legacy jobs left in place`);
      continue;
    }
    if (apply) for (const k of oldKeys) await r.send("RENAMENX", [k, `bull:${newName}:${k.slice(`bull:bkrn-${q}:`.length)}`]);
    res.queuesMoved.push(`bull:bkrn-${q} -> bull:${newName} (${oldKeys.length} keys)`);
  }

  if (apply) {
    const marker = { v: 1, at: opts.now ?? Date.now(), moved: res.moved.length, replacedOlder: res.replacedOlder.length, keptNewer: res.keptNewer.length, conflicts: res.conflicts.length, queues: res.queuesMoved.length };
    await r.send("SET", [migratedMarkerKey(ns), JSON.stringify(marker)]);
  }
  return res;
}

/** One log line per outcome (dev.ts / the CLI). */
export function describeMigration(ns: string, m: MigrationResult): string[] {
  if (m.skipped) return [`bus namespace "${ns}": already migrated (${migratedMarkerKey(ns)})`];
  const out = [
    `bus namespace "${ns}": moved ${m.moved.length} key(s), kept the newer of ${m.replacedOlder.length + m.keptNewer.length} existing pair(s), ${m.conflicts.length} conflict(s), ${m.queuesMoved.length} queue(s) moved, ${m.queueConflicts.length} queue conflict(s)`,
  ];
  for (const x of [...m.moved, ...m.replacedOlder, ...m.queuesMoved]) out.push(`  moved ${x}`);
  for (const x of m.keptNewer) out.push(`  kept ${x}`);
  for (const x of [...m.conflicts, ...m.queueConflicts]) out.push(`  CONFLICT ${x}`);
  return out;
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
  const m = await migrateBus(c, ns, { apply });
  for (const l of describeMigration(ns, m)) console.log(`[bus-migrate] ${l}`);
  if (!apply && !m.skipped) console.log("[bus-migrate] dry run: --apply to migrate (dev.ts does it at every start anyway)");
  c.close();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[bus-migrate] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
}
