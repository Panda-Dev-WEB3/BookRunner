// Snapshot collection: Postgres (books, newest marks, kill journal, indexer cursors), Redis (risk state,
// signed venue reports, supervisor heartbeat), the chain (head, role key balances, buybackPending,
// markInterval, the InsurancePool) and the API's /health. Each source fails independently: a failed source becomes an
// infra / rpc / api condition instead of blinding the other rules.
import { KEYS } from "@bookrunner/shared/queues";
import { SESSIONS_24X7, type Sessions, effectiveSessions } from "@bookrunner/shared/sessions";
import { parseVenueMarkets, type VenueMarketMsg } from "@bookrunner/shared/venueMarket";
import { SUPERVISOR_STATUS_KEY, parseSupervisorStatus } from "@bookrunner/shared/supervisor";
import type {
  BackupSnap,
  BookSnap,
  BuilderFeedSnap,
  VenueOpsSnap,
  IndexerCursorSnap,
  KillEventSnap,
  OracleConfirmSnap,
  OraclePolicy,
  OracleProbe,
  OracleSourceRole,
  OracleSourceSnap,
  PoolBookSnap,
  PoolSnap,
  RiskSnap,
  Sample,
  Snapshot,
} from "./types";

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
  /** the charter's sessions (bytes32 hex, charters.struct_json); absent / null = unknown */
  sessions?: string | null;
}

/** How many of each book's newest marks the held-mark rule looks at. */
export const RECENT_MARKS = 48;

export interface DbPort {
  books(): Promise<BookRow[]>;
  /** newest mark period end per book */
  latestMarkPeriodEnds(): Promise<Array<{ bookId: number; periodEnd: Date }>>;
  killsSince(since: Date): Promise<Array<{ id: number; bookId: number; ts: Date; reason: string; breaches: unknown }>>;
  cursors(): Promise<Array<{ name: string; block: number; updatedAt: Date }>>;
  /** the newest `perBook` marks of every book with their pnl_json.held (null on marks older than audit M-1) */
  recentMarks?(perBook: number): Promise<Array<{ bookId: number; periodEnd: Date; held: boolean | null }>>;
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
  /** BkrnFeeRouter.v4BlockedHop (0 none, 1 / 2 the blocked hop); null when unknown. Absent port = not read. */
  buybackV4BlockedHop?(): Promise<number | null>;
  /** BookrunnerConfig.markInterval; null when unknown */
  markInterval(): Promise<number | null>;
  /**
   * The InsurancePool (readPool), with the positions of `bookIds` plus its active books; null when the deployment has
   * no insurancePool. Absent port = no pool.
   */
  pool?(bookIds: number[]): Promise<PoolSnap | null>;
}

/** One InsurancePool view call (main.ts: viem readContract with insurancePoolAbi). */
export type PoolRead = (functionName: string, args?: readonly unknown[]) => Promise<unknown>;

/** settlement-token units (6dp) -> dollars; Number is exact below 2^53 units (~9e9 USD) */
const usd6 = (v: unknown) => Number(BigInt(v as bigint)) / 1e6;
const SHARE_UNIT = 1e12; // pool shares: 6 decimals + DECIMALS_OFFSET 6
const ZERO_ADDRESS = /^0x0{40}$/i;

/**
 * Reads the InsurancePool views in parallel. The core views (value, queue, params, activeBooks) must all succeed or
 * this throws (collect turns it into pool = undefined); epochInfo, staleBooks and each bookPosition fail on their own
 * (null / dropped), so one bad read never blinds the rest. Reads per call: 10 + 2 + one per book id.
 */
export async function readPool(read: PoolRead, address: string, bookIds: number[]): Promise<PoolSnap> {
  const [assets, free, claims, fl, util, flBps, params, queue, ledger, active] = await Promise.all([
    read("poolAssets"),
    read("freeLiquidity"),
    read("claimsTotal"),
    read("firstLossAssets"),
    read("utilisationBps"),
    read("firstLossBps"),
    read("params"),
    read("queue"),
    read("ledger"),
    read("activeBooks"),
  ]);
  const p = params as readonly [number, number, number, number, number, number, number, number];
  const q = queue as readonly [bigint, bigint, bigint, bigint, bigint];
  const l = ledger as readonly [bigint, bigint, bigint, bigint, bigint];
  const activeBookIds = (active as readonly bigint[]).map(Number);
  const ids = [...new Set([...bookIds.filter((x) => Number.isSafeInteger(x) && x >= 0), ...activeBookIds])].sort((a, b) => a - b);
  const [epochR, staleR, ...posR] = await Promise.allSettled([read("epochInfo", [q[0]]), read("staleBooks", [q[1]]), ...ids.map((id) => read("bookPosition", [BigInt(id)]))]);
  const ep = epochR!.status === "fulfilled" ? (epochR.value as { shares: bigint; depositAssets: bigint; processed: boolean }) : null;
  const books: PoolBookSnap[] = [];
  posR.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    const x = r.value as { book: string; market: string; allocation: bigint; claim: bigint; lossFirstLoss: bigint; lossDepositors: bigint; lastMarkAt: bigint | number; active: boolean };
    if (!x || typeof x.book !== "string" || ZERO_ADDRESS.test(x.book)) return;
    books.push({
      bookId: ids[i]!,
      market: String(x.market).toLowerCase(),
      allocationUsd: usd6(x.allocation),
      claimUsd: usd6(x.claim),
      lossFirstLossUsd: usd6(x.lossFirstLoss),
      lossDepositorsUsd: usd6(x.lossDepositors),
      lastMarkAt: Number(x.lastMarkAt),
      active: x.active === true,
    });
  });
  return {
    address,
    poolAssetsUsd: usd6(assets),
    freeLiquidityUsd: usd6(free),
    claimsUsd: usd6(claims),
    firstLossUsd: usd6(fl),
    utilisationBps: Number(util),
    firstLossBps: Number(flBps),
    firstLossTargetBps: Number(p[3]),
    epochLengthSec: Number(p[5]),
    processGraceSec: Number(p[6]),
    procEpoch: Number(q[0]),
    procEndsAt: Number(q[1]),
    fillEpoch: Number(q[2]),
    pendingShares: Number(q[3]) / SHARE_UNIT,
    depositsPendingUsd: usd6(l[2]),
    epoch: ep ? { withdrawShares: Number(BigInt(ep.shares)) / SHARE_UNIT, depositUsd: usd6(ep.depositAssets), processed: ep.processed === true } : null,
    staleBooks: staleR!.status === "fulfilled" ? Number(staleR.value) : null,
    activeBookIds,
    books,
  };
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
  /** the oracle's HTTP base URL (GET /health: per-source health); unset = not probed */
  oracleUrl?: string;
  markIntervalSec: number;
  roles: Array<{ role: string; address: `0x${string}` }>;
  /** how long rpc samples are kept */
  rpcWindowSec: number;
  /** kill_events lookback (one notification per kill) */
  killLookbackSec?: number;
  /** SESSIONS_MODE (24x7 overrides every charter's sessions) */
  sessionsMode?: string | undefined;
}

/** State carried between passes (rolling samples), persisted next to the dedupe state. */
export interface Memory {
  rpcSamples: Sample[];
  buybackSamples: Sample[];
  /** last known on-chain markInterval (kept when a read fails) */
  markIntervalSec: number | null;
  /** InsurancePool positions of fully settled books (poolPositionSettled): final, never read again, reused as last read */
  poolSettled?: PoolBookSnap[];
}

export const emptyMemory = (): Memory => ({ rpcSamples: [], buybackSamples: [], markIntervalSec: null, poolSettled: [] });

/**
 * A pool position that can no longer change (insurance-pool follow-ups: alerts stop reading every retired book): the book
 * is Retired (terminal), its final pool mark landed (position closed: `active` false, never reopened) and it owes the pool
 * nothing (claim 0: no repayment, recovery or write-off can follow). A closed position with a claim (a failed repayment,
 * retried by settleInsurance) or a retired book whose final mark is stuck (still active) keeps being read.
 */
export function poolPositionSettled(b: PoolBookSnap, bookState: string | undefined): boolean {
  return bookState === "Retired" && !b.active && b.claimUsd === 0;
}

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
  const lb = meta.lossBudget && typeof meta.lossBudget === "object" ? (meta.lossBudget as Record<string, unknown>) : null;
  const lossBudget =
    lb && typeof lb.blocked === "boolean"
      ? { blocked: lb.blocked, lossUsd: num(lb.lossUsd) ?? 0, budgetUsd: num(lb.budgetUsd) ?? 0, budgetBps: num(lb.budgetBps) ?? 0, period: num(lb.period) ?? 0 }
      : null;
  return {
    state: o.state,
    breaches: Array.isArray(o.breaches) ? o.breaches.map(String) : [],
    ts: ts === null ? null : ts > 1e12 ? ts : ts * 1000,
    killed: meta.killed === true,
    killReason: typeof meta.killReason === "string" ? meta.killReason : null,
    ...(meta.quoteUnverified === true ? { quoteUnverified: true } : {}),
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
    ...(lossBudget ? { lossBudget } : {}),
    ...("lossBudget" in meta && !lossBudget ? { lossBudgetUnreadable: true as const } : {}),
  };
}

/** KEYS.agentDeskRejects JSON (DeskRejectsMsg, the book's agent) -> StaleTradePrice refusal times (unix ms); malformed -> []. */
export function parseDeskRejects(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const o = JSON.parse(raw) as { staleTradePrice?: unknown };
    return Array.isArray(o.staleTradePrice) ? o.staleTradePrice.map(num).filter((t): t is number => t !== null).slice(-1_000) : [];
  } catch {
    return [];
  }
}

/** KEYS.busForged JSON (BusForgedMsg) -> events (unix ms); malformed -> null. */
export function parseBusForged(raw: string | null): { source: string; events: Array<{ at: number; kind: string; reason: string }> } | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { source?: unknown; events?: unknown };
    if (typeof o.source !== "string" || !Array.isArray(o.events)) return null;
    const events = (o.events as Array<Record<string, unknown> | null>).flatMap((e) => {
      const at = num(e?.at);
      return at === null ? [] : [{ at, kind: String(e?.kind ?? "?").slice(0, 16), reason: String(e?.reason ?? "").slice(0, 160) }];
    });
    return { source: o.source.slice(0, 40), events: events.slice(-200) };
  } catch {
    return null;
  }
}

/** KEYS.agentStatus JSON (AgentStatusMsg); malformed -> null. */
export function parseAgentStatus(raw: string | null): NonNullable<BookSnap["agentStatus"]> | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const ts = num(o.ts);
    const deskKey = o.deskKey;
    if (ts === null || (deskKey !== "active" && deskKey !== "inactive" && deskKey !== "missing")) return null;
    return { ts, deskKey, deskKeySince: num(o.deskKeySince), riskStateUnverifiedSince: num(o.riskStateUnverifiedSince) };
  } catch {
    return null;
  }
}

/** The charter's sessions (bytes32 hex), SESSIONS_MODE applied; null when absent or undecodable. */
export function sessionsOf(hex: string | null | undefined, mode: string | undefined): Sessions | null {
  if (mode === "24x7") return SESSIONS_24X7;
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(hex)) return null;
  try {
    return effectiveSessions(hex as `0x${string}`, mode);
  } catch {
    return null;
  }
}

/** KEYS.venueSymbolIssues JSON (VenueSymbolIssuesMsg, ops-venue) -> bookId -> error; malformed -> empty. */
export function parseVenueSymbolIssues(raw: string | null): Map<number, string> {
  const out = new Map<number, string>();
  if (!raw) return out;
  try {
    const o = JSON.parse(raw) as { books?: unknown };
    for (const b of Array.isArray(o.books) ? o.books : []) {
      const id = num((b as { bookId?: unknown })?.bookId);
      const err = (b as { error?: unknown })?.error;
      if (id !== null && typeof err === "string") out.set(id, err);
    }
  } catch {
    // ignore: an unreadable status is not an alert of its own
  }
  return out;
}

/** KEYS.venueSymbolIssues JSON markets -> bookId -> market (shared parseVenueMarkets: malformed entries dropped). */
export function parseMarketsByBook(raw: string | null): Map<number, VenueMarketMsg> {
  const out = new Map<number, VenueMarketMsg>();
  for (const m of parseVenueMarkets(raw)) for (const id of m.bookIds) out.set(id, m);
  return out;
}

/** KEYS.venueSymbolIssues JSON delistWaits -> bookId -> since (unix ms); malformed entries dropped. */
export function parseDelistWaits(raw: string | null): Map<number, number> {
  const out = new Map<number, number>();
  if (!raw) return out;
  try {
    const o = JSON.parse(raw) as { delistWaits?: unknown };
    for (const x of Array.isArray(o.delistWaits) ? (o.delistWaits as Array<Record<string, unknown> | null>) : []) {
      const id = num(x?.bookId);
      const since = num(x?.since);
      if (id !== null && since !== null) out.set(id, since);
    }
  } catch {
    // ignore: an unreadable status is not an alert of its own
  }
  return out;
}

/** KEYS.venueSymbolIssues JSON ifAccounts / ifOperatorWaits -> per book (ORDERLY_IF_MODE, VERIFY O10); malformed entries dropped. */
export function parseIfAccounts(raw: string | null): {
  issues: Map<number, NonNullable<BookSnap["ifAccountIssue"]>>;
  waits: Map<number, NonNullable<BookSnap["ifOperatorWaits"]>>;
  unadopted: Map<number, NonNullable<BookSnap["ifUnadopted"]>>;
  drops: Map<number, NonNullable<BookSnap["ifEquityDrop"]>>;
  failed: Map<number, NonNullable<BookSnap["failedWithdrawals"]>>;
} {
  const issues = new Map<number, NonNullable<BookSnap["ifAccountIssue"]>>();
  const waits = new Map<number, NonNullable<BookSnap["ifOperatorWaits"]>>();
  const unadopted = new Map<number, NonNullable<BookSnap["ifUnadopted"]>>();
  const drops = new Map<number, NonNullable<BookSnap["ifEquityDrop"]>>();
  const failed = new Map<number, NonNullable<BookSnap["failedWithdrawals"]>>();
  if (!raw) return { issues, waits, unadopted, drops, failed };
  try {
    const o = JSON.parse(raw) as { ifAccounts?: unknown; ifOperatorWaits?: unknown; ifUnadopted?: unknown; ifEquityDrops?: unknown; failedWithdrawals?: unknown };
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    const ISSUES = new Set(["mismatch", "key_pending", "prior_equity", "reassign"]);
    for (const x of Array.isArray(o.ifAccounts) ? (o.ifAccounts as Array<Record<string, unknown> | null>) : []) {
      const id = num(x?.bookId);
      if (id === null || !ISSUES.has(x?.issue as string) || typeof x?.detail !== "string") continue;
      const issue = { issue: x.issue as NonNullable<BookSnap["ifAccountIssue"]>["issue"], detail: x.detail, accountId: s(x.accountId), since: num(x.since) };
      // one per book: a mismatch / prior equity outranks a pending key or a re-assign notice
      const cur = issues.get(id);
      const rank = (i: string) => (i === "mismatch" || i === "prior_equity" ? 2 : 1);
      if (!cur || rank(issue.issue) > rank(cur.issue)) issues.set(id, issue);
    }
    for (const x of Array.isArray(o.ifOperatorWaits) ? (o.ifOperatorWaits as Array<Record<string, unknown> | null>) : []) {
      const id = num(x?.bookId);
      const since = num(x?.since);
      if (id === null || since === null || (x?.step !== "withdraw" && x?.step !== "payout" && x?.step !== "return")) continue;
      waits.set(id, [...(waits.get(id) ?? []), { nonce: s(x.nonce), step: x.step, amount: s(x.amount), owner: s(x.owner), adapter: s(x.adapter), since, writtenOffAt: num(x.writtenOffAt) }]);
    }
    for (const x of Array.isArray(o.ifUnadopted) ? (o.ifUnadopted as Array<Record<string, unknown> | null>) : []) {
      const id = num(x?.bookId);
      if (id === null || typeof x?.id !== "string") continue;
      unadopted.set(id, [...(unadopted.get(id) ?? []), { id: x.id, amount: s(x.amount), status: s(x.status), createdAt: num(x.createdAt) }]);
    }
    for (const x of Array.isArray(o.failedWithdrawals) ? (o.failedWithdrawals as Array<Record<string, unknown> | null>) : []) {
      const id = num(x?.bookId);
      const account = num(x?.account);
      const at = num(x?.at);
      if (id === null || account === null || at === null) continue;
      failed.set(id, [...(failed.get(id) ?? []), { nonce: s(x?.nonce), account, amount: s(x?.amount), error: s(x?.error), at }]);
    }
    for (const x of Array.isArray(o.ifEquityDrops) ? (o.ifEquityDrops as Array<Record<string, unknown> | null>) : []) {
      const id = num(x?.bookId);
      const at = num(x?.at);
      if (id === null || at === null) continue;
      drops.set(id, { expectedUsd: s(x?.expectedUsd), venueUsd: s(x?.venueUsd), at });
    }
  } catch {
    // ignore: an unreadable status is not an alert of its own
  }
  return { issues, waits, unadopted, drops, failed };
}

/** KEYS.venueSymbolIssues JSON -> ops-venue mode + builder push flag + listing mode; malformed / absent -> null. */
export function parseVenueOps(raw: string | null): VenueOpsSnap | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const ts = num(o.ts);
    if (ts === null || (o.mode !== "live" && o.mode !== "mock")) return null;
    return { ts, mode: o.mode, builderPush: o.builderPush === true, listingMode: o.listingMode === "manual" ? "manual" : "api" };
  } catch {
    return null;
  }
}

/** KEYS.builderFeedStatus JSON (BuilderFeedStatusMsg, ops-venue); malformed -> null. */
export function parseBuilderFeed(raw: string | null): BuilderFeedSnap | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const ts = num(o.ts);
    if (ts === null || !Array.isArray(o.symbols)) return null;
    const sock = (o.socket ?? {}) as Record<string, unknown>;
    return {
      ts,
      socket: { state: String(sock.state ?? "?"), lastError: typeof sock.lastError === "string" ? sock.lastError : null },
      symbols: o.symbols
        .filter((x): x is Record<string, unknown> => !!x && typeof (x as { symbol?: unknown }).symbol === "string")
        .map((x) => ({
          symbol: x.symbol as string,
          bookIds: Array.isArray(x.bookIds) ? x.bookIds.map(Number).filter(Number.isFinite) : [],
          state: String(x.state ?? "?"),
          lastPushAt: num(x.lastPushAt),
          failingSince: num(x.failingSince),
          error: typeof x.error === "string" ? x.error : null,
          preListing: x.preListing === true,
        })),
    };
  } catch {
    return null;
  }
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

/** An oracle probe that saw no usable body (unreachable, HTTP error, unknown shape). */
export const oracleDown = (error: string): OracleProbe => ({ ok: false, error, policy: "median", confirmBps: null, primaryLagBps: null, sources: [], confirm: [], minSourcesProblem: null, unpublished: [] });

const ROLES = new Set<OracleSourceRole>(["primary", "confirm", "median"]);
const CONFIRM_STATUS = new Set<OracleConfirmSnap["status"]>(["ok", "diverged", "unavailable", "closed", "no-primary"]);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** GET /health `confirm[]` (primary-confirm): entries without a priceId or with an unknown status are dropped. */
function parseConfirm(raw: unknown): OracleConfirmSnap[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): OracleConfirmSnap[] => {
    if (!isObj(x) || typeof x.priceId !== "string" || x.priceId === "") return [];
    const status = x.status as OracleConfirmSnap["status"];
    if (!CONFIRM_STATUS.has(status)) return [];
    const confirmers = Array.isArray(x.confirmers)
      ? x.confirmers.flatMap((c) => {
          if (!isObj(c) || typeof c.name !== "string") return [];
          const price = num(c.price);
          const diffBps = num(c.diffBps);
          return price === null || diffBps === null ? [] : [{ name: c.name.slice(0, 64), price, diffBps }];
        })
      : [];
    return [
      {
        priceId: x.priceId.slice(0, 64),
        status,
        diffBps: num(x.diffBps),
        since: num(x.since),
        checkedAt: num(x.checkedAt),
        primaryPrice: num(x.primaryPrice),
        primaryTs: num(x.primaryTs),
        lagSince: num(x.lagSince),
        confirmers: confirmers.slice(0, 8),
      },
    ];
  });
}

/** The oracle's GET /health body -> policy + per-source health + confirm status (unknown shapes -> not ok). */
export function parseOracleHealth(body: unknown): OracleProbe {
  if (!body || typeof body !== "object") return oracleDown("unexpected body");
  const o = body as { policy?: unknown; confirmBps?: unknown; primaryLagBps?: unknown; sources?: unknown; confirm?: unknown; onchain?: { minSourcesProblem?: unknown }; unpublished?: unknown };
  const policy: OraclePolicy = o.policy === "primary-confirm" ? "primary-confirm" : "median";
  const sources: OracleSourceSnap[] = Array.isArray(o.sources)
    ? o.sources
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string")
        .map((x) => ({
          name: String(x.name),
          kind: typeof x.kind === "string" ? x.kind : "?",
          role: ROLES.has(x.role as OracleSourceRole) ? (x.role as OracleSourceRole) : "median",
          lastOkAt: num(x.lastOkAt),
          failingSince: num(x.failingSince),
          failingTickers: Array.isArray(x.failingTickers) ? x.failingTickers.map(String) : [],
          lastError: typeof x.lastError === "string" ? x.lastError.slice(0, 200) : null,
          lastErrorAt: num(x.lastErrorAt),
        }))
    : [];
  const msp = o.onchain?.minSourcesProblem;
  const unpublished = Array.isArray(o.unpublished)
    ? o.unpublished
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as { priceId?: unknown }).priceId === "string")
        .flatMap((x) => {
          const since = num(x.since);
          return since === null ? [] : [{ priceId: String(x.priceId), since, reason: typeof x.reason === "string" ? x.reason.slice(0, 200) : "?", lastSeenAt: num(x.lastSeenAt) }];
        })
    : [];
  return {
    ok: true,
    error: null,
    policy,
    confirmBps: num(o.confirmBps),
    primaryLagBps: num(o.primaryLagBps),
    sources,
    confirm: parseConfirm(o.confirm),
    minSourcesProblem: typeof msp === "string" ? msp : null,
    unpublished,
  };
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
  const recentBy = new Map<number, Array<{ periodEnd: number; held: boolean }>>();
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
  // recent marks on their own: a failure here only blinds held_marks_in_session (books keep recentMarks = [])
  if (d.db.recentMarks && !infraErrors.some((e) => e.source === "db")) {
    try {
      const recent = await d.db.recentMarks(RECENT_MARKS);
      for (const m of [...recent].sort((a, b) => new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime())) {
        const id = Number(m.bookId);
        recentBy.set(id, [...(recentBy.get(id) ?? []), { periodEnd: Math.floor(new Date(m.periodEnd).getTime() / 1000), held: m.held === true }]);
      }
    } catch {
      // held_marks_in_session is skipped this pass
    }
  }

  // ---- Redis (risk state, venue reports, supervisor heartbeat)
  let supervisor: Snapshot["supervisor"];
  let backup: Snapshot["backup"];
  let riskRaw: Array<string | null> = [];
  let venueRaw: Array<string | null> = [];
  let rejectsRaw: Array<string | null> = [];
  let busForged: Snapshot["busForged"] = [];
  let statusRaw: Array<string | null> = [];
  let symbolIssues = new Map<number, string>();
  let markets = new Map<number, VenueMarketMsg>();
  let delistWaits = new Map<number, number>();
  let ifAccounts: ReturnType<typeof parseIfAccounts> = { issues: new Map(), waits: new Map(), unadopted: new Map(), drops: new Map(), failed: new Map() };
  let builderFeed: Snapshot["builderFeed"];
  let venueOps: Snapshot["venueOps"];
  try {
    const ids = bookRows.map((b) => b.id);
    const forgedSources = ["ops-venue", "risk", ...ids.map((id) => `agent-${id}`)];
    const [sup, bk, risk, venue, issues, feed, rejects, forged, status] = await Promise.all([
      d.kv.get(SUPERVISOR_STATUS_KEY),
      d.kv.get(BACKUP_STATUS_KEY),
      ids.length ? d.kv.mget(ids.map((id) => KEYS.riskState(id))) : Promise.resolve([]),
      ids.length ? d.kv.mget(ids.map((id) => KEYS.venueReport(id))) : Promise.resolve([]),
      d.kv.get(KEYS.venueSymbolIssues),
      d.kv.get(KEYS.builderFeedStatus),
      ids.length ? d.kv.mget(ids.map((id) => KEYS.agentDeskRejects(id))) : Promise.resolve([]),
      d.kv.mget(forgedSources.map((src) => KEYS.busForged(src))),
      ids.length ? d.kv.mget(ids.map((id) => KEYS.agentStatus(id))) : Promise.resolve([]),
    ]);
    statusRaw = status;
    rejectsRaw = rejects;
    busForged = forged.map(parseBusForged).filter((x): x is NonNullable<typeof x> => x !== null);
    symbolIssues = parseVenueSymbolIssues(issues);
    markets = parseMarketsByBook(issues);
    delistWaits = parseDelistWaits(issues);
    ifAccounts = parseIfAccounts(issues);
    builderFeed = parseBuilderFeed(feed);
    venueOps = parseVenueOps(issues);
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
      venueSymbolError: symbolIssues.get(Number(b.id)) ?? null,
      venueMarket: markets.get(Number(b.id)) ?? null,
      delistWaitSince: delistWaits.get(Number(b.id)) ?? null,
      ifAccountIssue: ifAccounts.issues.get(Number(b.id)) ?? null,
      ifOperatorWaits: ifAccounts.waits.get(Number(b.id)) ?? [],
      ifUnadopted: ifAccounts.unadopted.get(Number(b.id)) ?? [],
      ifEquityDrop: ifAccounts.drops.get(Number(b.id)) ?? null,
      failedWithdrawals: ifAccounts.failed.get(Number(b.id)) ?? [],
      sessions: sessionsOf(b.sessions, st.sessionsMode),
      recentMarks: recentBy.get(Number(b.id)) ?? [],
      deskStaleTradePrice: parseDeskRejects(rejectsRaw[i] ?? null),
      agentStatus: parseAgentStatus(statusRaw[i] ?? null),
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
  let buybackV4BlockedHop: number | null = null;
  try {
    buybackV4BlockedHop = d.chain.buybackV4BlockedHop ? await d.chain.buybackV4BlockedHop() : null;
  } catch {
    buybackV4BlockedHop = null; // an old router without the read, or a stale reference (the keeper logs that)
  }
  let markIntervalSec = mem.markIntervalSec;
  try {
    markIntervalSec = (await d.chain.markInterval()) ?? markIntervalSec;
  } catch {
    // keep the last known value
  }
  // InsurancePool: null = none in the deployment; undefined = a core read failed (rpc problems are the rpc rule's business)
  let pool: Snapshot["pool"] = null;
  const poolSettled = new Map((Array.isArray(mem.poolSettled) ? mem.poolSettled : []).map((b) => [b.bookId, b]));
  if (d.chain.pool) {
    try {
      // review m-2: only books that can hold a pool position (a window closed): never Subscription / Cancelled ones
      const withPosition = bookRows.filter((b) => b.state !== "Subscription" && b.state !== "Cancelled").map((b) => Number(b.id));
      // fully settled positions are final: not read again, their last read stands in (the rules still see them)
      pool = await d.chain.pool(withPosition.filter((id) => !poolSettled.has(id)));
      if (pool) {
        const stateOf = new Map(bookRows.map((b) => [Number(b.id), b.state]));
        for (const b of pool.books) if (poolPositionSettled(b, stateOf.get(b.bookId))) poolSettled.set(b.bookId, b);
        const read = new Set(pool.books.map((b) => b.bookId));
        const kept = withPosition.flatMap((id) => (read.has(id) ? [] : (poolSettled.get(id) ?? [])));
        pool = { ...pool, books: [...pool.books, ...kept].sort((a, b) => a.bookId - b.bookId) };
      }
    } catch {
      pool = undefined;
    }
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

  // ---- oracle (policy, per-source health, primary-confirm status: see rules.ts oracle)
  let oracle: Snapshot["oracle"] = null;
  if (st.oracleUrl) {
    try {
      const res = await d.fetch(`${st.oracleUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      oracle = res.ok ? parseOracleHealth(await res.json().catch(() => null)) : oracleDown(`HTTP ${res.status}`);
    } catch (err) {
      oracle = oracleDown(errMsg(err));
    }
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
    buybackV4BlockedHop,
    api,
    oracle,
    backup,
    builderFeed,
    venueOps,
    busForged,
    pool,
    infraErrors,
  };
  return { snapshot, memory: { rpcSamples, buybackSamples, markIntervalSec, poolSettled: [...poolSettled.values()] } };
}
