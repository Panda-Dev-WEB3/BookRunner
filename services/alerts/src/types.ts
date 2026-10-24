// What the alert rules see: one Snapshot per pass (collected from Postgres, Redis, the chain and the API by
// collect.ts), plus the rolling samples the runner keeps between passes. Rules are pure functions of these.
import type { VenueMarketMsg } from "@bookrunner/shared/venueMarket";
import type { Sessions } from "@bookrunner/shared/sessions";
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
  /** engine books (meta.lossBudget, Task 7): the pool's per-period loss budget; absent when not published */
  lossBudget?: { blocked: boolean; lossUsd: number; budgetUsd: number; budgetBps: number; period: number };
  /**
   * meta.lossBudget published but unusable (null or malformed): risk could not read PoolEngine.lossBudget this tick. Risk
   * publishes null for every Orderly book too, so only an engine book's flag means something (engine_loss_budget_unreadable).
   * Absent when the key is absent (an older risk service) or the budget parsed.
   */
  lossBudgetUnreadable?: true;
  /** meta.quoteUnverified (audit M-3): the book is held reduce-only, its live quote has no fresh attested price to check against */
  quoteUnverified?: boolean;
  /** meta.capitalShort (pool audit 2026-10-23 fix round 2 Info 4): a pool-funded book's own capital is below the pool's minimum */
  capitalShort?: boolean;
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
  /** ops-venue (KEYS.venueSymbolIssues): why the book's charter symbol has no Orderly market (not listed / traded); null = fine or unknown */
  venueSymbolError?: string | null;
  /** ops-venue (KEYS.venueSymbolIssues markets): the Orderly market state of the book's venue symbol; null = not checked / not an Orderly book */
  venueMarket?: VenueMarketMsg | null;
  /** ops-venue (KEYS.venueSymbolIssues delistWaits): unix ms since the book's IF withdrawal waits for the admin's delisting in Orderly One */
  delistWaitSince?: number | null;
  /** ops-venue (KEYS.venueSymbolIssues ifAccounts): the book's IF account cannot be provisioned (ORDERLY_IF_MODE, VERIFY O10) */
  ifAccountIssue?: { issue: "mismatch" | "key_pending" | "prior_equity" | "reassign"; detail: string; accountId: string; since: number | null } | null;
  /** ops-venue (KEYS.venueSymbolIssues ifOperatorWaits): builder IF mode, IF withdrawals waiting for the operator */
  ifOperatorWaits?: Array<{ nonce: string; step: "withdraw" | "payout" | "return"; amount: string; owner: string; adapter: string; since: number; writtenOffAt?: number | null }>;
  /** ops-venue (KEYS.venueSymbolIssues failedWithdrawals): withdraw sagas that FAILED (manual action) */
  failedWithdrawals?: Array<{ nonce: string; account: number; amount: string; error: string; at: number }>;
  /** ops-venue (KEYS.venueSymbolIssues ifUnadopted): builder IF withdrawals no on-chain request asked for */
  ifUnadopted?: Array<{ id: string; amount: string; status: string; createdAt: number | null }>;
  /** ops-venue (KEYS.venueSymbolIssues ifEquityDrops): builder IF equity below the adapter's insurance */
  ifEquityDrop?: { expectedUsd: string; venueUsd: string; at: number } | null;
  /** the charter's trading sessions (charters.struct_json, SESSIONS_MODE=24x7 applied); null = unknown */
  sessions?: Sessions | null;
  /** the newest marks (Postgres marks, pnl_json.held), newest first; periodEnd unix s */
  recentMarks?: Array<{ periodEnd: number; held: boolean }>;
  /** agent (KEYS.agentDeskRejects): unix ms of the desk's StaleTradePrice refusals of the last hour */
  deskStaleTradePrice?: number[];
  /** agent (KEYS.agentStatus): desk key and risk-state verification status; null = no status (agent down / older) */
  agentStatus?: { ts: number; deskKey: "active" | "inactive" | "missing"; deskKeySince: number | null; riskStateUnverifiedSince: number | null } | null;
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

/**
 * How the oracle turns sources into a price (GET /health `policy`; absent on older oracles = "median").
 * median: N live sources, M required, the median of those within the band (devnet / testnet).
 * primary-confirm: the primary (Chainlink) alone sets and signs each price; confirm sources (DEX TWAP, Pyth) are
 * only compared against it and never substitute (mainnet).
 */
export type OraclePolicy = "median" | "primary-confirm";

/** A source's part in the policy (GET /health `sources[].role`; absent = "median"). */
export type OracleSourceRole = "primary" | "confirm" | "median";

/** One live price source as the oracle reports it (GET /health `sources`, services/oracle SourceHealth). */
export interface OracleSourceSnap {
  name: string;
  kind: string;
  role: OracleSourceRole;
  /** unix ms of the last fresh observation */
  lastOkAt: number | null;
  /** unix ms since when it fails in-session tickers; null = healthy */
  failingSince: number | null;
  failingTickers: string[];
  /** failure class, e.g. "HTTP 401", "timeout" (never a key) */
  lastError: string | null;
  /**
   * unix ms of the latest failed tick. The oracle keeps a run (failingSince) for its hysteresis after recovery, so the
   * rules measure the OBSERVED failing span lastErrorAt - failingSince, never now - failingSince (a one-tick blip must
   * not age into an alert while the source is healthy). Absent (older oracle) = now.
   */
  lastErrorAt?: number | null;
}

/**
 * primary-confirm: one ticker's comparison of the primary price with its confirm sources (GET /health `confirm`).
 * "closed" = the ticker is off-hours (not evaluated); diverged / unavailable are only reported in session.
 * "no-primary" = in session but the primary itself has no fresh observation (the primary source alert and
 * oracle_price_missing cover it; never a confirm alert).
 */
export interface OracleConfirmSnap {
  priceId: string;
  status: "ok" | "diverged" | "unavailable" | "closed" | "no-primary";
  /** max |confirmer - primary| / primary in bps among fresh confirmers; null when there is none */
  diffBps: number | null;
  /** unix ms: start of the current run of this status (in session) */
  since: number | null;
  /** unix ms of the last evaluation */
  checkedAt: number | null;
  primaryPrice: number | null;
  /** unix ms: updatedAt of the Chainlink round behind primaryPrice */
  primaryTs: number | null;
  /** unix ms: start of the run in which the confirm gap exceeds the oracle's primaryLagBps (null = none) */
  lagSince: number | null;
  confirmers: Array<{ name: string; price: number; diffBps: number }>;
}

export interface OracleProbe {
  ok: boolean;
  error: string | null;
  /** "median" when the oracle does not report one (older oracles) */
  policy: OraclePolicy;
  /** primary-confirm: ORACLE_CONFIRM_BPS (divergence threshold); null when absent (median) */
  confirmBps: number | null;
  /** primary-confirm: ORACLE_PRIMARY_LAG_BPS (stalled-feed gap); null when absent */
  primaryLagBps: number | null;
  sources: OracleSourceSnap[];
  /** primary-confirm: per-ticker confirmation status; [] under median */
  confirm: OracleConfirmSnap[];
  /** the oracle's on-chain minSources problem (minSources() above the live sources), if any */
  minSourcesProblem: string | null;
  /** in-session price ids without a publishable price (since = unix ms of the start of the run) */
  /** lastSeenAt: unix ms of the latest tick without a price (the run lingers for the hysteresis; absent = now) */
  unpublished: Array<{ priceId: string; since: number; reason: string; lastSeenAt?: number | null }>;
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

/**
 * ops-venue's live builder price push (Redis bkrn:<ns>:ops-venue:builder-feed, BuilderFeedStatusMsg): the oracle's signed
 * price per Orderly builder market, pushed >= 1/s to Orderly's Builder Oracle in session (docs/VERIFY.md O18).
 */
export interface BuilderFeedSnap {
  /** unix ms of ops-venue's status write */
  ts: number;
  socket: { state: string; lastError: string | null };
  symbols: Array<{
    symbol: string;
    bookIds: number[];
    /** pushing | held | stale | no-price | invalid | disconnected | rejected | not-configured */
    state: string;
    lastPushAt: number | null;
    /** unix ms: start of the failing run (null = pushing or held) */
    failingSince: number | null;
    error: string | null;
    /** the market is not listed on Orderly yet (ops-venue listing check; before it: every book in Subscription): not paged */
    preListing: boolean;
  }>;
}

/** ops-venue status (KEYS.venueSymbolIssues, every book poll, TTL 600 s): venue mode and whether the live builder price push runs. */
export interface VenueOpsSnap {
  ts: number;
  mode: "mock" | "live";
  /** the live builder price push is enabled: its status (builderFeed) must exist */
  builderPush: boolean;
  /** ORDERLY_LISTING_MODE (an older ops-venue: api) */
  listingMode: "api" | "manual";
}

/** One book's position in the InsurancePool (bookPosition(bookId)); USD figures are settlement-token dollars (6dp / 1e6). */
export interface PoolBookSnap {
  bookId: number;
  /** bytes32 underlying (lowercase hex): the per-market cap's key */
  market: string;
  /** debt principal outstanding (reduced by repayments) */
  allocationUsd: number;
  /** the pool's valuation of the debt at the book's last mark (<= allocation) */
  claimUsd: number;
  lossFirstLossUsd: number;
  lossDepositorsUsd: number;
  /** unix s: periodEnd of the book's last mark reported to the pool (allocation time at first) */
  lastMarkAt: number;
  /** counted in the epoch freshness gate until the book's final mark */
  active: boolean;
}

/** The protocol-wide InsurancePool (docs/ARCHITECTURE.md §2.10), read once per pass. */
export interface PoolSnap {
  address: string;
  poolAssetsUsd: number;
  freeLiquidityUsd: number;
  claimsUsd: number;
  firstLossUsd: number;
  utilisationBps: number;
  firstLossBps: number;
  firstLossTargetBps: number;
  epochLengthSec: number;
  processGraceSec: number;
  /** queue(): oldest unprocessed epoch, its end (unix s), oldest epoch with unfilled withdrawals, escrowed shares (whole shares) */
  procEpoch: number;
  procEndsAt: number;
  fillEpoch: number;
  pendingShares: number;
  depositsPendingUsd: number;
  /** epochInfo(procEpoch) content; null = the read failed */
  epoch: { withdrawShares: number; depositUsd: number; processed: boolean } | null;
  /** staleBooks(procEndsAt): active books whose last mark predates the epoch end; null = the read failed */
  staleBooks: number | null;
  activeBookIds: number[];
  /** positions of activeBooks() plus every book of the snapshot (zero-address positions skipped; failed reads dropped) */
  books: PoolBookSnap[];
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
  /**
   * BkrnFeeRouter.v4BlockedHop(): the v4 buyback hop sitting past its price limit (1 the first hop / direct pool,
   * 2 the ETH -> BKRN hop), 0 none / venue v3; null = not read (no fee router, an old router, a read failure).
   */
  buybackV4BlockedHop?: number | null;
  api: ApiProbe;
  /** the oracle's /health (per-source health); null = not probed (no oracle URL) */
  oracle: OracleProbe | null;
  /** null: no backup recorded, undefined: Redis read failed */
  backup: BackupSnap | null | undefined;
  /** null/absent: no live builder price push status (mock mode, or ops-venue not pushing); undefined: Redis read failed */
  builderFeed?: BuilderFeedSnap | null;
  /** null/absent: no ops-venue status (or an older ops-venue) */
  venueOps?: VenueOpsSnap | null;
  /** forged bus messages each service refused (KEYS.busForged: agent-<bookId>, ops-venue, risk) */
  busForged?: Array<{ source: string; events: Array<{ at: number; kind: string; reason: string }> }>;
  /**
   * the InsurancePool: null = the deployment has no insurancePool (older deployments) or no pool port; undefined = a
   * core read failed this pass (the rpc rule reports RPC trouble). Either way the pool rules raise nothing.
   */
  pool?: PoolSnap | null;
  /** collection failures that are themselves worth an alert (db / redis unreachable) */
  infraErrors: Array<{ source: "db" | "redis"; error: string }>;
}
