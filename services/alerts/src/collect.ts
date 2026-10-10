// Snapshot collection: Postgres (books, newest marks, kill journal, indexer cursors), Redis (risk state,
// signed venue reports, supervisor heartbeat), the chain (head, role key balances, buybackPending,
// markInterval) and the API's /health. Each source fails independently: a failed source becomes an
// infra / rpc / api condition instead of blinding the other rules.
import { KEYS } from "@bookrunner/shared/queues";
import { SUPERVISOR_STATUS_KEY, parseSupervisorStatus } from "@bookrunner/shared/supervisor";
import type { BackupSnap, BookSnap, IndexerCursorSnap, KillEventSnap, RiskSnap, Sample, Snapshot } from "./types";

/** deploy/server/backup.sh records its outcome here (same Redis db as the stack). */
export const BACKUP_STATUS_KEY = "bkrn:backup:last";

// ------------------------------------------------------------------ ports
export interface BookRow {
  id: number;
  name: string | null;
  symbol: string;
  state: string;
  venue: number;
  subscriptionEnds: Date | null;
}

export interface DbPort {
  books(): Promise<BookRow[]>;
  /** newest mark period end per book */
  latestMarkPeriodEnds(): Promise<Array<{ bookId: number; periodEnd: Date }>>;
  killsSince(since: Date): Promise<Array<{ id: number; bookId: number; ts: Date; reason: string; breaches: unknown }>>;
  cursors(): Promise<Array<{ name: string; block: number; updatedAt: Date }>>;
}

export interface KvPort {
  get(key: string): Promise<string | null>;
  mget(keys: string[]): Promise<Array<string | null>>;
}

export interface ChainPort {
  head(): Promise<{ number: number; timestamp: number }>;
  balance(address: `0x${string}`): Promise<bigint>;
  /** BkrnFeeRouter.buybackPending (USDC 6dp); null when there is no fee router in the deployment */
  buybackPending(): Promise<bigint | null>;
  /** BookrunnerConfig.markInterval; null when unknown */
  markInterval(): Promise<number | null>;
}

export interface CollectDeps {
  db: DbPort;
  kv: KvPort;
  chain: ChainPort;
  fetch: typeof fetch;
  now: () => number;
}

export interface CollectSettings {
  network: string;
  chainId: number;
  apiUrl: string;
  markIntervalSec: number;
  roles: Array<{ role: string; address: `0x${string}` }>;
  /** how long rpc samples are kept */
  rpcWindowSec: number;
  /** kill_events lookback (one notification per kill) */
  killLookbackSec?: number;
}

/** State carried between passes (rolling samples), persisted next to the dedupe state. */
export interface Memory {
  rpcSamples: Sample[];
  buybackSamples: Sample[];
  /** last known on-chain markInterval (kept when a read fails) */
  markIntervalSec: number | null;
}

export const emptyMemory = (): Memory => ({ rpcSamples: [], buybackSamples: [], markIntervalSec: null });

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200);

// ------------------------------------------------------------------ pure parsers
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** KEYS.riskState JSON (services/risk RiskStatePayload): limits snapshot + meta (ts, killed, monitor.kill). */
export function parseRisk(raw: string | null): RiskSnap | null {
  if (!raw) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!o || typeof o.state !== "string") return null;
  const meta = (o.meta && typeof o.meta === "object" ? o.meta : {}) as Record<string, unknown>;
  const monitor = (meta.monitor && typeof meta.monitor === "object" ? meta.monitor : {}) as Record<string, unknown>;
  const k = monitor.kill && typeof monitor.kill === "object" ? (monitor.kill as Record<string, unknown>) : null;
  const ts = num(meta.ts ?? o.ts);
  return {
    state: o.state,
    breaches: Array.isArray(o.breaches) ? o.breaches.map(String) : [],
    ts: ts === null ? null : ts > 1e12 ? ts : ts * 1000,
    killed: meta.killed === true,
    killReason: typeof meta.killReason === "string" ? meta.killReason : null,
    journal: k
      ? {
          episodeId: String(k.episodeId ?? "?"),
          mode: String(k.mode ?? "?"),
          startedAt: num(k.startedAt) ?? 0,
          reason: String(k.reason ?? ""),
          done: Array.isArray(k.done) ? k.done.map(String) : [],
          failed: Object.fromEntries(Object.entries((k.failed ?? {}) as Record<string, unknown>).map(([s, n]) => [s, num(n) ?? 0])),
        }
      : null,
  };
}

/** KEYS.venueReport JSON (VenueReportMsg): asOf in unix seconds. */
export function parseVenueAsOf(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const v = num((JSON.parse(raw) as { asOf?: unknown }).asOf);
    return v === null ? null : v > 1e12 ? Math.floor(v / 1000) : v;
  } catch {
    return null;
  }
}

/** BACKUP_STATUS_KEY JSON written by backup.sh. */
export function parseBackup(raw: string | null): BackupSnap | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const ts = num(o.ts);
    if (ts === null) return null;
    return {
      ts,
      ok: o.ok === true,
      error: typeof o.error === "string" ? o.error : "",
      offsite: typeof o.offsite === "string" ? o.offsite : "off",
      bytes: num(o.bytes) ?? 0,
      dir: typeof o.dir === "string" ? o.dir : "",
    };
  } catch {
    return null;
  }
}

/** Appends a sample and drops those older than `windowMs`. */
export function pushSample(samples: Sample[], s: Sample, windowMs: number, max = 2000): Sample[] {
  const out = [...samples.filter((x) => s.ts - x.ts <= windowMs), s];
  return out.length > max ? out.slice(out.length - max) : out;
}

/**
 * Buyback series: one sample per `everyMs` (or on any change), kept for `keepMs`. Enough resolution to
 * see a decrease (a landed buyback) without growing without bound.
 */
export function pushBuyback(samples: Sample[], s: Sample, everyMs: number, keepMs: number): Sample[] {
  const last = samples[samples.length - 1];
  if (last && last.value === s.value && s.ts - last.ts < everyMs) return samples;
  return pushSample(samples, s, keepMs, 5000);
}

// ------------------------------------------------------------------ collection
export async function collect(d: CollectDeps, st: CollectSettings, mem: Memory, buybackKeepSec: number): Promise<{ snapshot: Snapshot; memory: Memory }> {
  const now = d.now();
  const infraErrors: Snapshot["infraErrors"] = [];

  // ---- Postgres
  let books: BookSnap[] | null = null;
  let kills: KillEventSnap[] = [];
  let indexer: IndexerCursorSnap[] | null = null;
  let bookRows: BookRow[] = [];
  let markBy = new Map<number, number>();
  try {
    const [rows, marks, k, cur] = await Promise.all([
      d.db.books(),
      d.db.latestMarkPeriodEnds(),
      d.db.killsSince(new Date(now - (st.killLookbackSec ?? 86_400) * 1000)),
      d.db.cursors(),
    ]);
    bookRows = rows;
    markBy = new Map(marks.map((m) => [Number(m.bookId), Math.floor(new Date(m.periodEnd).getTime() / 1000)]));
    kills = k.map((r) => ({
      id: Number(r.id),
      bookId: Number(r.bookId),
      ts: new Date(r.ts).getTime(),
      reason: r.reason,
      breaches: Array.isArray(r.breaches) ? r.breaches.map(String) : [],
    }));
    indexer = cur.map((c) => ({ name: c.name, block: Number(c.block), updatedAt: new Date(c.updatedAt).getTime() }));
  } catch (err) {
    infraErrors.push({ source: "db", error: errMsg(err) });
  }

  // ---- Redis (risk state, venue reports, supervisor heartbeat)
  let supervisor: Snapshot["supervisor"];
  let backup: Snapshot["backup"];
  let riskRaw: Array<string | null> = [];
  let venueRaw: Array<string | null> = [];
  try {
    const ids = bookRows.map((b) => b.id);
    const [sup, bk, risk, venue] = await Promise.all([
      d.kv.get(SUPERVISOR_STATUS_KEY),
      d.kv.get(BACKUP_STATUS_KEY),
      ids.length ? d.kv.mget(ids.map((id) => KEYS.riskState(id))) : Promise.resolve([]),
      ids.length ? d.kv.mget(ids.map((id) => KEYS.venueReport(id))) : Promise.resolve([]),
    ]);
    supervisor = parseSupervisorStatus(sup);
    backup = parseBackup(bk);
    riskRaw = risk;
    venueRaw = venue;
  } catch (err) {
    supervisor = undefined;
    backup = undefined;
    infraErrors.push({ source: "redis", error: errMsg(err) });
  }
  if (!infraErrors.some((e) => e.source === "db")) {
    books = bookRows.map((b, i) => ({
      bookId: Number(b.id),
      name: b.name,
      symbol: b.symbol,
      state: b.state,
      venue: b.venue === 1 ? "pool_engine" : "orderly",
      lastMarkPeriodEnd: markBy.get(Number(b.id)) ?? null,
      liveSince: b.subscriptionEnds ? Math.floor(new Date(b.subscriptionEnds).getTime() / 1000) : null,
      risk: parseRisk(riskRaw[i] ?? null),
      venueReportAsOf: parseVenueAsOf(venueRaw[i] ?? null),
    }));
  }

  // ---- chain
  let rpc: Snapshot["rpc"];
  try {
    const h = await d.chain.head();
    rpc = { ok: true, head: h.number, headTs: h.timestamp, error: null };
  } catch (err) {
    rpc = { ok: false, head: null, headTs: null, error: errMsg(err) };
  }
  const rpcSamples = pushSample(mem.rpcSamples, { ts: now, value: rpc.ok ? 1 : 0 }, st.rpcWindowSec * 1000);
  const balances = await Promise.all(
    st.roles.map(async (r) => {
      try {
        return { role: r.role, address: r.address, wei: await d.chain.balance(r.address) };
      } catch {
        return { role: r.role, address: r.address, wei: null };
      }
    }),
  );
  let buybackSamples = mem.buybackSamples;
  try {
    const pending = await d.chain.buybackPending();
    if (pending !== null) buybackSamples = pushBuyback(buybackSamples, { ts: now, value: Number(pending) / 1e6 }, 600_000, buybackKeepSec * 1000);
  } catch {
    // rpc problems are the rpc rule's business
  }
  let markIntervalSec = mem.markIntervalSec;
  try {
    markIntervalSec = (await d.chain.markInterval()) ?? markIntervalSec;
  } catch {
    // keep the last known value
  }

  // ---- API
  let api: Snapshot["api"];
  try {
    const res = await d.fetch(`${st.apiUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    const body = (await res.json().catch(() => null)) as { ok?: unknown; db?: unknown; redis?: unknown } | null;
    api = {
      ok: res.ok && body?.ok === true,
      httpStatus: res.status,
      db: typeof body?.db === "string" ? body.db : null,
      redis: typeof body?.redis === "string" ? body.redis : null,
      error: res.ok ? (body?.ok === true ? null : "unexpected body") : `HTTP ${res.status}`,
    };
  } catch (err) {
    api = { ok: false, httpStatus: null, db: null, redis: null, error: errMsg(err) };
  }

  const snapshot: Snapshot = {
    now,
    network: st.network,
    chainId: st.chainId,
    markIntervalSec: markIntervalSec ?? st.markIntervalSec,
    books,
    kills,
    supervisor,
    balances,
    rpc,
    rpcSamples,
    indexer,
    buybackSamples,
    api,
    backup,
    infraErrors,
  };
  return { snapshot, memory: { rpcSamples, buybackSamples, markIntervalSec } };
}
