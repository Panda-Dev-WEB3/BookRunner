// services/alerts configuration: thresholds (with per-network defaults) and delivery channels.
// Every threshold is an env var; the defaults below are what the rules use when it is unset.
import { baseEnvSchema } from "@bookrunner/shared/env";
import { z } from "zod";

export type Network = "devnet" | "testnet" | "mainnet";

export function networkOf(env: Record<string, string | undefined>): Network {
  const n = (env.NETWORK ?? "").toLowerCase();
  if (n === "testnet" || n === "mainnet" || n === "devnet") return n;
  const chainId = Number(env.CHAIN_ID ?? 31337);
  return chainId === 4663 ? "mainnet" : chainId === 46630 ? "testnet" : "devnet";
}

/** Per-network defaults: marks are hourly on testnet, daily on mainnet (scripts/dev.ts, docs/LOW_GAS.md). */
const NETWORK_DEFAULTS: Record<Network, { markGraceSec: number; venueReportMaxAgeSec: number; headLagSec: number; funderMinEth: string }> = {
  devnet: { markGraceSec: 120, venueReportMaxAgeSec: 600, headLagSec: 3600, funderMinEth: "0" },
  testnet: { markGraceSec: 900, venueReportMaxAgeSec: 900, headLagSec: 600, funderMinEth: "0.1" },
  mainnet: { markGraceSec: 3600, venueReportMaxAgeSec: 900, headLagSec: 300, funderMinEth: "0" },
};

/**
 * Minimum ETH per role key. testnet: half of the gas keeper's refill trigger (scripts/gas-keeper.ts GAS_PLAN),
 * so a key only alerts once the keeper has failed to top it up. mainnet: conservative starting points for
 * keys nobody refills automatically: set ALERT_BALANCE_MIN_ETH from the measured burn before launch.
 */
const ROLE_MIN_ETH: Record<Network, Record<string, string>> = {
  devnet: { "*": "0.1" },
  testnet: {
    "*": "0.0005",
    deskKeyIndex: "0.004",
    deskKeyNvda: "0.002",
    deskKeyTsla: "0.002",
    trader0: "0.0015",
    trader1: "0.0015",
    trader2: "0.0015",
    trader3: "0.0015",
    markSigner: "0.0015",
    keeper: "0.001",
    opsVenue: "0.001",
    risk: "0.0005",
    oracleSigner: "0.0005",
    jury: "0.00025",
    sponsor: "0.00025",
    committee0: "0.00025",
    committee1: "0.00025",
    committee2: "0.00025",
    agentOperator: "0.00025",
  },
  mainnet: {
    "*": "0.002",
    markSigner: "0.01",
    keeper: "0.01",
    opsVenue: "0.005",
    risk: "0.005",
    oracleSigner: "0.005",
    deskKeyIndex: "0.01",
    deskKeyNvda: "0.01",
    deskKeyTsla: "0.01",
  },
};

/** "a=1,b=2" -> {a: "1", b: "2"} (blank entries ignored). */
export function parsePairs(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? "").split(/[,;\s]+/)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

const num = (d: number) => z.coerce.number().min(0).default(d);
const int = (d: number) => z.coerce.number().int().min(0).default(d);
const bool = (d: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? d : v === "1" || v.toLowerCase() === "true"));

const shape = {
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().default("postgres://bookrunner:bookrunner@127.0.0.1:54400/bookrunner"),
  REDIS_URL: z.string().default("redis://127.0.0.1:63790"),
  CHAIN_ID: z.coerce.number().int().default(31337),
  RPC_URL: z.string().default("http://127.0.0.1:8547"),
  DEPLOYMENT_FILE: z.string().default("contracts/deployments/31337.json"),
  MARK_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(300),
  API_PORT: z.coerce.number().int().default(4400),
  ORACLE_PORT: z.coerce.number().int().default(4410),

  ALERT_INTERVAL_SECONDS: int(60),
  ALERT_API_URL: z.string().optional(),
  /** the oracle's HTTP base URL (GET /health); default http://127.0.0.1:ORACLE_PORT */
  ALERT_ORACLE_URL: z.string().optional(),
  /**
   * a live oracle source failing in-session tickers this long alerts. median policy: warning, critical when 2+ fail
   * on one ticker. primary-confirm: the primary is critical; a confirm source waits for the longer of this and
   * ALERT_ORACLE_CONFIRM_UNAVAILABLE_SECONDS and is a warning
   */
  ALERT_ORACLE_SOURCE_FAIL_SECONDS: int(60),
  /** an in-session price id with no publishable price this long alerts (critical) */
  ALERT_ORACLE_PRICE_MISSING_SECONDS: int(120),
  /** primary-confirm: a ticker whose confirm sources disagree with the primary beyond ORACLE_CONFIRM_BPS this long alerts */
  ALERT_ORACLE_CONFIRM_DIVERGENCE_SECONDS: int(120),
  /** primary-confirm: an in-session ticker with no fresh confirm source this long alerts (published unconfirmed) */
  ALERT_ORACLE_CONFIRM_UNAVAILABLE_SECONDS: int(600),
  /** comma-separated tickers for oracle_confirm_unavailable (empty = every ticker). A quiet DEX pool on a ticker no
   *  market uses only means "published unconfirmed": list the tickers of the live markets (e.g. NVDA). Divergence
   *  alerts stay on for every ticker. */
  ALERT_ORACLE_CONFIRM_TICKERS: z.string().default(""),
  /** primary-confirm: this many tickers diverged at once makes every divergence alert critical */
  ALERT_ORACLE_CONFIRM_CRITICAL_TICKERS: z.coerce.number().int().min(1).default(3),
  /**
   * primary-confirm: a confirm gap above the oracle's ORACLE_PRIMARY_LAG_BPS lasting this long in session with no new
   * Chainlink round for this long (clock from the later of lagSince and the round) = oracle_primary_suspect_stale
   */
  ALERT_ORACLE_PRIMARY_LAG_SECONDS: int(600),
  /** default: on for testnet / mainnet, off on devnet */
  ALERT_ORACLE_EXPECTED: z.string().optional(),
  ALERT_LABEL: z.string().optional(),
  /** comma-separated rule names to switch off, e.g. "buyback_growing,role_balance_low" */
  ALERT_DISABLE: z.string().default(""),

  ALERT_MARK_GRACE_SECONDS: z.coerce.number().int().min(0).optional(),
  ALERT_RISK_STALE_SECONDS: int(300),
  /** a live Orderly builder market whose price ops-venue has not pushed this long in session (Orderly: >= 1/s) alerts (critical) */
  ALERT_BUILDER_PUSH_FAIL_SECONDS: int(30),
  /** venue_listing_pending: a Live book whose Orderly market is not listed pages critical after this long Live (warning before) */
  ALERT_LISTING_LIVE_GRACE_SECONDS: int(1800),
  /** venue_listing_check: consecutive failed listing checks of a market before a warning */
  ALERT_LISTING_CHECK_FAILURES: int(5),
  /** venue_delist_pending: an IF withdrawal waiting this long for the admin's delisting pages critical (warning before) */
  ALERT_DELIST_WAIT_CRITICAL_SECONDS: int(21_600),
  /** venue_if_operator_pending: a builder-IF withdrawal waiting this long for the operator pages critical (warning before) */
  ALERT_IF_OPERATOR_WAIT_CRITICAL_SECONDS: int(21_600),
  /**
   * The agents' AGENT_VENUE_POST_ONLY_QUOTE (same stack env): POST_ONLY markets are quoted maker-only (true) or
   * reduce-only (false). Unset: the agent's default, true with ops-venue in live mode (venue_market_restricted text).
   */
  AGENT_VENUE_POST_ONLY_QUOTE: z.stringbool().optional(),
  ALERT_RISK_WARN: bool(false),
  /** held_marks_in_session: a held run spanning this much open session (or a mark valued in session) alerts (warning) */
  ALERT_HELD_MARK_SESSION_SECONDS: z.coerce.number().int().min(300).default(900),
  /** held_marks_in_session: a held run (since the last non-held mark) this long pages critical */
  ALERT_HELD_MARK_CRITICAL_SECONDS: int(86_400),
  /** risk_quote_unverified: a book held reduce-only for quoteUnverified this long in session alerts */
  ALERT_QUOTE_UNVERIFIED_SECONDS: int(300),
  /** desk_stale_trade_price: this many StaleTradePrice refusals of a book's desk swaps within the window alert (3x: critical) */
  ALERT_STALE_TRADE_PRICE_MAX: z.coerce.number().int().min(1).default(3),
  ALERT_STALE_TRADE_PRICE_WINDOW_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  /** bus_forged_message: forged bus messages refused by one service within the window before a warning (3x: critical) */
  ALERT_FORGED_MESSAGES_MAX: z.coerce.number().int().min(1).default(3),
  ALERT_FORGED_MESSAGES_WINDOW_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  /** agent_no_desk_key: a Live book without an active desk key this long pages critical (warning before) */
  ALERT_NO_DESK_KEY_CRITICAL_SECONDS: int(600),
  /** risk_state_unverified: no RISK-signed state verified by the agent this long alerts (warning) */
  ALERT_RISK_STATE_UNVERIFIED_SECONDS: int(60),
  /** engine_loss_budget_unreadable: an engine book whose risk state has carried no readable loss budget this long alerts (warning) */
  ALERT_LOSS_BUDGET_UNREADABLE_SECONDS: int(300),
  /** the stack's SESSIONS_MODE (same enum and default as every service: 24x7 overrides the charter sessions) */
  SESSIONS_MODE: baseEnvSchema.shape.SESSIONS_MODE,
  ALERT_VENUE_REPORT_MAX_AGE_SECONDS: z.coerce.number().int().min(1).optional(),
  ALERT_RESTART_WINDOW_SECONDS: int(900),
  ALERT_RESTART_MAX: int(3),
  ALERT_EXIT_WINDOW_SECONDS: int(600),
  ALERT_ROLE_ADDRESSES: z.string().default(""),
  ALERT_BALANCE_MIN_ETH: z.string().default(""),
  ALERT_FUNDER_MIN_ETH: z.string().optional(),
  ALERT_RPC_ERROR_RATE: num(0.5),
  ALERT_RPC_MIN_SAMPLES: int(4),
  ALERT_RPC_WINDOW_SECONDS: int(900),
  ALERT_HEAD_LAG_SECONDS: z.coerce.number().int().min(1).optional(),
  ALERT_INDEXER_LAG_BLOCKS: int(5000),
  ALERT_INDEXER_STALE_SECONDS: int(900),
  ALERT_BUYBACK_MIN_USD: num(50),
  ALERT_BUYBACK_GROW_HOURS: num(48),
  ALERT_BUYBACK_MAX_USD: num(5000),
  ALERT_API_FOR_SECONDS: int(120),
  ALERT_BACKUP_MAX_AGE_HOURS: num(26),
  // ---- liquidation keeper (in-house engine markets; rules-liquidation.ts)
  /** liquidation_backlog: a liquidatable position still open this long (warning; critical at 5x) */
  ALERT_LIQ_BACKLOG_SECONDS: int(60),
  /** keeper_liquidation_failing: this many consecutive failed attempts */
  ALERT_LIQ_FAILURES: int(3),
  /** keeper_liquidation_failing: status older than this while an engine book is live */
  ALERT_LIQ_STATUS_STALE_SECONDS: int(300),
  /** liquidation_coverage: critical when a paged rotation over every open position takes longer than this */
  ALERT_LIQ_ROTATION_SECONDS: int(120),
  // ---- InsurancePool (docs/ARCHITECTURE.md §2.10; rules-pool.ts)
  /** pool_utilisation: claims / pool assets above this (bps) for 5 min alerts (warning) */
  ALERT_POOL_UTILISATION_BPS: int(9000),
  /** pool_utilisation: at or above this (bps) the alert is critical */
  ALERT_POOL_UTILISATION_CRITICAL_BPS: int(9800),
  /** pool_epoch_overdue: an ended epoch with something queued, processable and unprocessed this long past its end (warning) */
  ALERT_POOL_EPOCH_OVERDUE_SECONDS: int(7200),
  /** pool_epoch_in_grace: books not marked since the epoch end this long after it alert (default: the network's mark grace) */
  ALERT_POOL_GRACE_WARN_SECONDS: z.coerce.number().int().min(0).optional(),
  /** pool_market_debt: a market whose active books' marked-down debt reaches this share of pool assets (bps) is critical */
  ALERT_POOL_MARKET_DEBT_CRITICAL_BPS: int(500),
  /** pool_book_unrepaid: a retired book still owing its claim this long after its final mark alerts (warning) */
  ALERT_POOL_UNREPAID_SECONDS: int(21_600),
  /** pool_final_mark_stuck: a retired book's pool position still open this long (keeper retrying settleInsurance) */
  ALERT_POOL_FINAL_MARK_STUCK_SECONDS: int(1_800),
  /** pool_debt_written_off: a retired book's written-off loss is paged (critical, one-off) while its final mark is younger than this */
  ALERT_POOL_WRITE_OFF_NOTIFY_SECONDS: int(604_800),
  /** default: on for testnet / mainnet (deploy/server backup timer), off on devnet */
  ALERT_BACKUP_EXPECTED: z.string().optional(),

  // ---- delivery
  ALERT_EMAIL_TO: z.string().default(""),
  ALERT_EMAIL_FROM: z.string().optional(),
  ALERT_SMTP_HOST: z.string().default("mail.ignition-x.com"),
  ALERT_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  ALERT_SMTP_USER: z.string().optional(),
  ALERT_SMTP_PASS: z.string().optional(),
  ALERT_WEBHOOK_URL: z.string().optional(),
  ALERT_WEBHOOK_FORMAT: z.enum(["auto", "slack", "discord", "telegram", "json"]).default("auto"),
  ALERT_TELEGRAM_CHAT_ID: z.string().optional(),
  /** dead-man's switch: GET after every completed pass (healthchecks.io style); unset = off */
  ALERT_HEARTBEAT_URL: z.string().optional(),
  ALERT_MIN_INTERVAL_SECONDS: int(60),
  ALERT_MAX_PER_HOUR: int(20),
  /** a firing condition must stay clear this long before "resolved" is sent (anti-flap) */
  ALERT_CLEAR_SECONDS: int(120),
  /** daily digest hour (UTC, 0-23); unset = no digest */
  ALERT_DIGEST_HOUR_UTC: z.coerce.number().int().min(0).max(23).optional(),
};

export interface RuleConfig {
  markGraceSec: number;
  riskStaleSec: number;
  riskWarn: boolean;
  /** held_marks_in_session: open-session seconds a held run must span (when no mark of it was valued in session) */
  heldMarkSessionSec: number;
  /** held_marks_in_session: held run length (s) before critical */
  heldMarkCriticalSec: number;
  /** risk_quote_unverified: hold (s) in session before the alert */
  quoteUnverifiedSec: number;
  /** desk_stale_trade_price: refusals within the window before a warning */
  staleTradePriceMax: number;
  staleTradePriceWindowSec: number;
  /** bus_forged_message: refusals within the window before a warning */
  forgedMessagesMax: number;
  forgedMessagesWindowSec: number;
  noDeskKeyCriticalSec: number;
  riskStateUnverifiedSec: number;
  /** engine_loss_budget_unreadable: span (s) before the warning */
  lossBudgetUnreadableSec: number;
  venueReportMaxAgeSec: number;
  /** builder_price_push: failing span (s) of a live builder price push in session */
  builderPushFailSec: number;
  /** venue_listing_pending: grace (s) of a Live book on an unlisted market before critical */
  listingLiveGraceSec: number;
  /** venue_listing_check: consecutive failed checks before a warning */
  listingCheckFailures: number;
  /** venue_delist_pending: wait (s) before critical */
  delistWaitCriticalSec: number;
  /** venue_if_operator_pending: wait (s) before critical */
  ifOperatorWaitCriticalSec: number;
  /** the agents' AGENT_VENUE_POST_ONLY_QUOTE when set (undefined: the agent default, true with ops-venue live) */
  venuePostOnlyQuote?: boolean;
  restartWindowSec: number;
  restartMax: number;
  exitWindowSec: number;
  /** role -> min balance (wei); "*" = default */
  roleMinWei: Record<string, bigint>;
  funderMinWei: bigint;
  rpcErrorRate: number;
  rpcMinSamples: number;
  headLagSec: number;
  indexerLagBlocks: number;
  indexerStaleSec: number;
  buybackMinUsd: number;
  buybackGrowSec: number;
  buybackMaxUsd: number;
  apiForSec: number;
  oracleExpected: boolean;
  oracleSourceFailSec: number;
  oraclePriceMissingSec: number;
  /** primary-confirm: "diverged" this long alerts */
  oracleConfirmDivergenceSec: number;
  /** primary-confirm: "unavailable" this long alerts */
  oracleConfirmUnavailableSec: number;
  /** tickers oracle_confirm_unavailable applies to (empty = all) */
  oracleConfirmTickers?: string[];
  /** primary-confirm: this many tickers diverged at once = critical */
  oracleConfirmCriticalTickers: number;
  /** primary-confirm: stalled-feed gap duration (s) for oracle_primary_suspect_stale */
  oraclePrimaryLagSec: number;
  backupExpected: boolean;
  backupMaxAgeSec: number;
  /** liquidation_backlog: seconds a liquidatable position may stay open */
  liqBacklogSec: number;
  /** keeper_liquidation_failing: consecutive failed attempts */
  liqFailures: number;
  /** keeper_liquidation_failing: max age of the keeper status (s) */
  liqStatusStaleSec: number;
  /** liquidation_coverage: longest acceptable rotation (s) */
  liqRotationSec: number;
  /** pool_utilisation: warning above, critical at or above (bps) */
  poolUtilisationBps: number;
  poolUtilisationCriticalBps: number;
  /** pool_epoch_overdue: seconds past the epoch end before the warning */
  poolEpochOverdueSec: number;
  /** pool_epoch_in_grace: seconds past the epoch end before the warning */
  poolGraceWarnSec: number;
  /** pool_market_debt: critical share of pool assets (bps) */
  poolMarketDebtCriticalBps: number;
  /** pool_book_unrepaid: seconds after the final mark */
  poolUnrepaidSec: number;
  /** pool_final_mark_stuck: anti-flap before the warning */
  poolFinalMarkStuckSec: number;
  /** pool_debt_written_off: seconds after the final mark the one-off page stays reported */
  poolWriteOffNotifySec: number;
  supervisorExpected: boolean;
  disabled: Set<string>;
}

export interface DeliveryConfig {
  label: string;
  email: { to: string[]; from: string; host: string; port: number; user: string; pass: string } | null;
  webhook: { url: string; format: "auto" | "slack" | "discord" | "telegram" | "json"; telegramChatId: string | null } | null;
  heartbeatUrl: string | null;
  minIntervalSec: number;
  maxPerHour: number;
  clearSec: number;
  digestHourUtc: number | null;
}

export interface AlertsConfig {
  network: Network;
  chainId: number;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  rpcUrl: string;
  deploymentFile: string;
  markIntervalSec: number;
  /** SESSIONS_MODE (24x7: charter sessions ignored) */
  sessionsMode: "charter" | "24x7";
  intervalSec: number;
  apiUrl: string;
  oracleUrl: string;
  rpcWindowSec: number;
  roles: Array<{ role: string; address: `0x${string}` }>;
  rules: RuleConfig;
  delivery: DeliveryConfig;
}

/** ETH decimal string -> wei (no float rounding). */
export function ethToWei(s: string): bigint {
  const m = /^(\d*)(?:\.(\d{0,18}))?$/.exec(s.trim());
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) throw new Error(`invalid ETH amount: ${s}`);
  return BigInt(m[1] || "0") * 10n ** 18n + BigInt((m[2] ?? "").padEnd(18, "0") || "0");
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AlertsConfig {
  const parsed = z.object(shape).safeParse(env);
  if (!parsed.success) throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const e = parsed.data;
  const network = networkOf(env);
  const nd = NETWORK_DEFAULTS[network];

  const roleMin: Record<string, bigint> = {};
  for (const [k, v] of Object.entries({ ...ROLE_MIN_ETH[network], ...parsePairs(e.ALERT_BALANCE_MIN_ETH) })) roleMin[k] = ethToWei(v);
  const roles: AlertsConfig["roles"] = [];
  for (const [role, address] of Object.entries(parsePairs(e.ALERT_ROLE_ADDRESSES))) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`ALERT_ROLE_ADDRESSES: ${role} is not an address`);
    roles.push({ role, address: address as `0x${string}` });
  }

  const label = e.ALERT_LABEL || `BookRunner ${network}`;
  const to = e.ALERT_EMAIL_TO.split(/[,;\s]+/).filter(Boolean);
  const email =
    to.length && e.ALERT_SMTP_USER && e.ALERT_SMTP_PASS
      ? { to, from: e.ALERT_EMAIL_FROM || e.ALERT_SMTP_USER, host: e.ALERT_SMTP_HOST, port: e.ALERT_SMTP_PORT, user: e.ALERT_SMTP_USER, pass: e.ALERT_SMTP_PASS }
      : null;
  const webhook = e.ALERT_WEBHOOK_URL ? { url: e.ALERT_WEBHOOK_URL, format: e.ALERT_WEBHOOK_FORMAT, telegramChatId: e.ALERT_TELEGRAM_CHAT_ID ?? null } : null;

  return {
    network,
    chainId: e.CHAIN_ID,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    rpcUrl: e.RPC_URL,
    deploymentFile: e.DEPLOYMENT_FILE,
    markIntervalSec: e.MARK_INTERVAL_SECONDS,
    sessionsMode: e.SESSIONS_MODE,
    intervalSec: Math.max(10, e.ALERT_INTERVAL_SECONDS),
    apiUrl: (e.ALERT_API_URL || `http://127.0.0.1:${e.API_PORT}`).replace(/\/+$/, ""),
    oracleUrl: (e.ALERT_ORACLE_URL || `http://127.0.0.1:${e.ORACLE_PORT}`).replace(/\/+$/, ""),
    rpcWindowSec: e.ALERT_RPC_WINDOW_SECONDS,
    roles,
    rules: {
      markGraceSec: e.ALERT_MARK_GRACE_SECONDS ?? nd.markGraceSec,
      riskStaleSec: e.ALERT_RISK_STALE_SECONDS,
      riskWarn: e.ALERT_RISK_WARN,
      heldMarkSessionSec: e.ALERT_HELD_MARK_SESSION_SECONDS,
      heldMarkCriticalSec: e.ALERT_HELD_MARK_CRITICAL_SECONDS,
      quoteUnverifiedSec: e.ALERT_QUOTE_UNVERIFIED_SECONDS,
      staleTradePriceMax: e.ALERT_STALE_TRADE_PRICE_MAX,
      staleTradePriceWindowSec: e.ALERT_STALE_TRADE_PRICE_WINDOW_SECONDS,
      forgedMessagesMax: e.ALERT_FORGED_MESSAGES_MAX,
      forgedMessagesWindowSec: e.ALERT_FORGED_MESSAGES_WINDOW_SECONDS,
      noDeskKeyCriticalSec: e.ALERT_NO_DESK_KEY_CRITICAL_SECONDS,
      riskStateUnverifiedSec: e.ALERT_RISK_STATE_UNVERIFIED_SECONDS,
      lossBudgetUnreadableSec: e.ALERT_LOSS_BUDGET_UNREADABLE_SECONDS,
      venueReportMaxAgeSec: e.ALERT_VENUE_REPORT_MAX_AGE_SECONDS ?? nd.venueReportMaxAgeSec,
      builderPushFailSec: e.ALERT_BUILDER_PUSH_FAIL_SECONDS,
      listingLiveGraceSec: e.ALERT_LISTING_LIVE_GRACE_SECONDS,
      listingCheckFailures: e.ALERT_LISTING_CHECK_FAILURES,
      delistWaitCriticalSec: e.ALERT_DELIST_WAIT_CRITICAL_SECONDS,
      ifOperatorWaitCriticalSec: e.ALERT_IF_OPERATOR_WAIT_CRITICAL_SECONDS,
      ...(e.AGENT_VENUE_POST_ONLY_QUOTE !== undefined ? { venuePostOnlyQuote: e.AGENT_VENUE_POST_ONLY_QUOTE } : {}),
      restartWindowSec: e.ALERT_RESTART_WINDOW_SECONDS,
      restartMax: e.ALERT_RESTART_MAX,
      exitWindowSec: e.ALERT_EXIT_WINDOW_SECONDS,
      roleMinWei: roleMin,
      funderMinWei: ethToWei(e.ALERT_FUNDER_MIN_ETH ?? nd.funderMinEth),
      rpcErrorRate: e.ALERT_RPC_ERROR_RATE,
      rpcMinSamples: e.ALERT_RPC_MIN_SAMPLES,
      headLagSec: e.ALERT_HEAD_LAG_SECONDS ?? nd.headLagSec,
      indexerLagBlocks: e.ALERT_INDEXER_LAG_BLOCKS,
      indexerStaleSec: e.ALERT_INDEXER_STALE_SECONDS,
      buybackMinUsd: e.ALERT_BUYBACK_MIN_USD,
      buybackGrowSec: Math.round(e.ALERT_BUYBACK_GROW_HOURS * 3600),
      buybackMaxUsd: e.ALERT_BUYBACK_MAX_USD,
      apiForSec: e.ALERT_API_FOR_SECONDS,
      oracleExpected:
        e.ALERT_ORACLE_EXPECTED === undefined || e.ALERT_ORACLE_EXPECTED === "" ? network !== "devnet" : e.ALERT_ORACLE_EXPECTED === "1" || e.ALERT_ORACLE_EXPECTED.toLowerCase() === "true",
      oracleSourceFailSec: e.ALERT_ORACLE_SOURCE_FAIL_SECONDS,
      oraclePriceMissingSec: e.ALERT_ORACLE_PRICE_MISSING_SECONDS,
      oracleConfirmDivergenceSec: e.ALERT_ORACLE_CONFIRM_DIVERGENCE_SECONDS,
      oracleConfirmUnavailableSec: e.ALERT_ORACLE_CONFIRM_UNAVAILABLE_SECONDS,
      oracleConfirmTickers: e.ALERT_ORACLE_CONFIRM_TICKERS.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean),
      oracleConfirmCriticalTickers: e.ALERT_ORACLE_CONFIRM_CRITICAL_TICKERS,
      oraclePrimaryLagSec: e.ALERT_ORACLE_PRIMARY_LAG_SECONDS,
      backupExpected: e.ALERT_BACKUP_EXPECTED === undefined || e.ALERT_BACKUP_EXPECTED === "" ? network !== "devnet" : e.ALERT_BACKUP_EXPECTED === "1" || e.ALERT_BACKUP_EXPECTED.toLowerCase() === "true",
      backupMaxAgeSec: Math.round(e.ALERT_BACKUP_MAX_AGE_HOURS * 3600),
      liqBacklogSec: e.ALERT_LIQ_BACKLOG_SECONDS,
      liqFailures: e.ALERT_LIQ_FAILURES,
      liqStatusStaleSec: e.ALERT_LIQ_STATUS_STALE_SECONDS,
      liqRotationSec: e.ALERT_LIQ_ROTATION_SECONDS,
      poolUtilisationBps: e.ALERT_POOL_UTILISATION_BPS,
      poolUtilisationCriticalBps: e.ALERT_POOL_UTILISATION_CRITICAL_BPS,
      poolEpochOverdueSec: e.ALERT_POOL_EPOCH_OVERDUE_SECONDS,
      poolGraceWarnSec: e.ALERT_POOL_GRACE_WARN_SECONDS ?? nd.markGraceSec,
      poolMarketDebtCriticalBps: e.ALERT_POOL_MARKET_DEBT_CRITICAL_BPS,
      poolUnrepaidSec: e.ALERT_POOL_UNREPAID_SECONDS,
      poolFinalMarkStuckSec: e.ALERT_POOL_FINAL_MARK_STUCK_SECONDS,
      poolWriteOffNotifySec: e.ALERT_POOL_WRITE_OFF_NOTIFY_SECONDS,
      supervisorExpected: true,
      disabled: new Set(e.ALERT_DISABLE.split(/[,\s]+/).filter(Boolean)),
    },
    delivery: {
      label,
      email,
      webhook,
      heartbeatUrl: e.ALERT_HEARTBEAT_URL || null,
      minIntervalSec: e.ALERT_MIN_INTERVAL_SECONDS,
      maxPerHour: e.ALERT_MAX_PER_HOUR,
      clearSec: e.ALERT_CLEAR_SECONDS,
      digestHourUtc: e.ALERT_DIGEST_HOUR_UTC ?? null,
    },
  };
}
