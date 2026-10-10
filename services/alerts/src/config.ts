// services/alerts configuration: thresholds (with per-network defaults) and delivery channels.
// Every threshold is an env var; the defaults below are what the rules use when it is unset.
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

  ALERT_INTERVAL_SECONDS: int(60),
  ALERT_API_URL: z.string().optional(),
  ALERT_LABEL: z.string().optional(),
  /** comma-separated rule names to switch off, e.g. "buyback_growing,role_balance_low" */
  ALERT_DISABLE: z.string().default(""),

  ALERT_MARK_GRACE_SECONDS: z.coerce.number().int().min(0).optional(),
  ALERT_RISK_STALE_SECONDS: int(300),
  ALERT_RISK_WARN: bool(false),
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
  /** default: on for testnet / mainnet (deploy/server backup timer), off on devnet */
  ALERT_BACKUP_EXPECTED: z.string().optional(),

  // ---- delivery
  ALERT_EMAIL_TO: z.string().default(""),
  ALERT_EMAIL_FROM: z.string().optional(),
  ALERT_SMTP_HOST: z.string().default("mail.use-cert.com"),
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
  venueReportMaxAgeSec: number;
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
  backupExpected: boolean;
  backupMaxAgeSec: number;
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
  intervalSec: number;
  apiUrl: string;
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
    intervalSec: Math.max(10, e.ALERT_INTERVAL_SECONDS),
    apiUrl: (e.ALERT_API_URL || `http://127.0.0.1:${e.API_PORT}`).replace(/\/+$/, ""),
    rpcWindowSec: e.ALERT_RPC_WINDOW_SECONDS,
    roles,
    rules: {
      markGraceSec: e.ALERT_MARK_GRACE_SECONDS ?? nd.markGraceSec,
      riskStaleSec: e.ALERT_RISK_STALE_SECONDS,
      riskWarn: e.ALERT_RISK_WARN,
      venueReportMaxAgeSec: e.ALERT_VENUE_REPORT_MAX_AGE_SECONDS ?? nd.venueReportMaxAgeSec,
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
      backupExpected: e.ALERT_BACKUP_EXPECTED === undefined || e.ALERT_BACKUP_EXPECTED === "" ? network !== "devnet" : e.ALERT_BACKUP_EXPECTED === "1" || e.ALERT_BACKUP_EXPECTED.toLowerCase() === "true",
      backupMaxAgeSec: Math.round(e.ALERT_BACKUP_MAX_AGE_HOURS * 3600),
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
