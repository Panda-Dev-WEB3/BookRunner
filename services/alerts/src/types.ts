// What the alert rules see: one Snapshot per pass (collected from Postgres, Redis, the chain and the API by
// collect.ts), plus the rolling samples the runner keeps between passes. Rules are pure functions of these.
import type { SupervisorStatus } from "@bookrunner/shared/supervisor";

export type Severity = "warning" | "critical";

/** One active condition reported by a rule. Same `key` across passes = the same alert (dedupe). */
export interface Condition {
  /** stable identity, e.g. "mark_overdue:3" */
  key: string;
  /** rule name, e.g. "mark_overdue" */
  rule: string;
  severity: Severity;
  /** one line, human readable */
  summary: string;
  /** must stay active this long before it is notified (anti-flap); 0 = at once */
  forSec?: number;
  /** false: a one-off event (e.g. a kill) — no "resolved" message when it ages out */
  notifyResolve?: boolean;
}

export interface RiskJournalSnap {
  episodeId: string;
  mode: string;
  startedAt: number; // unix s
  reason: string;
  done: string[];
  failed: Record<string, number>;
}

export interface RiskSnap {
  /** LimitState: ok | warn | reduce_only | breach | killed */
  state: string;
  breaches: string[];
  /** unix ms of the risk service's last write (meta.ts), null when absent */
  ts: number | null;
  killed: boolean;
  killReason: string | null;
  /** open kill journal (meta.monitor.kill): a kill sequence in progress or stuck */
  journal: RiskJournalSnap | null;
}

export interface BookSnap {
  bookId: number;
  name: string | null;
  symbol: string;
  /** BookState: Subscription | Cancelled | Live | Retiring | Retired */
  state: string;
  venue: "orderly" | "pool_engine";
  /** unix s: period end of the newest mark (null: never marked) */
  lastMarkPeriodEnd: number | null;
  /** unix s: when the book went live (subscription end), the reference before the first mark */
  liveSince: number | null;
  risk: RiskSnap | null;
  /** unix s: asOf of the latest signed venue report in Redis (Orderly books), null when absent */
  venueReportAsOf: number | null;
}

export interface KillEventSnap {
  id: number;
  bookId: number;
  ts: number; // unix ms
  reason: string;
  breaches: string[];
}

export interface BalanceSnap {
  role: string;
  address: string;
  /** null: the read failed (counted by the RPC rule, not alerted as low) */
  wei: bigint | null;
}

export interface RpcProbe {
  ok: boolean;
  /** latest block number / timestamp (unix s) when ok */
  head: number | null;
  headTs: number | null;
  error: string | null;
}

export interface IndexerCursorSnap {
  name: string;
  block: number;
  updatedAt: number; // unix ms
}

export interface ApiProbe {
  ok: boolean;
  httpStatus: number | null;
  db: string | null;
  redis: string | null;
  error: string | null;
}

/** A timestamped sample kept across passes (rpc probe outcome, buyback pending). */
export interface Sample {
  ts: number; // unix ms
  value: number;
}

/** deploy/server/backup.sh outcome (Redis bkrn:backup:last). */
export interface BackupSnap {
  ts: number; // unix ms
  ok: boolean;
  error: string;
  /** off | ok | failed */
  offsite: string;
  bytes: number;
  dir: string;
}

export interface Snapshot {
  now: number; // unix ms
  network: string;
  chainId: number;
  /** on-chain config.markInterval (falls back to MARK_INTERVAL_SECONDS) */
  markIntervalSec: number;
  /** null: the DB read failed (the books rules are skipped, an infra condition is raised instead) */
  books: BookSnap[] | null;
  kills: KillEventSnap[];
  /** null: no heartbeat (supervisor down or Redis unreachable), undefined: Redis read failed */
  supervisor: SupervisorStatus | null | undefined;
  balances: BalanceSnap[];
  rpc: RpcProbe;
  /** rolling rpc outcomes: value 1 = ok, 0 = error */
  rpcSamples: Sample[];
  indexer: IndexerCursorSnap[] | null;
  /** rolling buybackPending in USD (null samples are skipped) */
  buybackSamples: Sample[];
  api: ApiProbe;
  /** null: no backup recorded, undefined: Redis read failed */
  backup: BackupSnap | null | undefined;
  /** collection failures that are themselves worth an alert (db / redis unreachable) */
  infraErrors: Array<{ source: "db" | "redis"; error: string }>;
}
