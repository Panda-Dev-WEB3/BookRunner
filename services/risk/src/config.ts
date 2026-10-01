import { baseEnvSchema } from "@bookrunner/shared";
import { z } from "zod";

/** Risk-service environment on top of the shared base env (packages/shared/src/env.ts). */
export const riskEnvShape = {
  /** Tick period per book. */
  RISK_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  /** How often the book list (BookFactory.bookIds / DB books) is refreshed. */
  RISK_BOOKS_REFRESH_MS: z.coerce.number().int().positive().default(15_000),
  /** Where to discover books: chain (BookFactory), db (books table) or auto (chain, fallback db). */
  RISK_BOOK_SOURCE: z.enum(["auto", "chain", "db"]).default("auto"),
  /** Optional comma-separated allow-list of book ids (empty = every Live/Retiring book). */
  RISK_BOOK_IDS: z.string().default(""),
  /** A `limits` row is written on every state/breach change and at least every N ticks. */
  RISK_LIMITS_EVERY_TICKS: z.coerce.number().int().positive().default(5),
  /**
   * Consecutive ticks a breach must be observed before the episode is confirmed (limit.breached +
   * kill sequence). 1 = act on the first observation; 2 filters single-read glitches (~1 interval).
   */
  RISK_BREACH_CONFIRM_TICKS: z.coerce.number().int().positive().default(2),
  /** A quote older than this is not "live" and is not checked for skew/width. */
  RISK_QUOTE_MAX_AGE_MS: z.coerce.number().int().positive().default(15_000),
  /** enforce = run the kill sequence on breach; alert = classify + emit limit.breached only. */
  RISK_KILL_MODE: z.enum(["enforce", "alert"]).default("enforce"),
  /**
   * net = sell only the desk hedge that does not offset venue exposure (never increases
   * |venue exposure + hedge|, i.e. reduce-only within the mandate); all = sell every Stock Token.
   */
  RISK_FLATTEN_MODE: z.enum(["net", "all"]).default("net"),
  /** minAmountOut = oracle value of the tokens sold * (1 - slippage). */
  RISK_FLATTEN_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(5000).default(100),
  /** Uniswap v3 pool fee tier for Flatten (VERIFY per Stock Token pool on RHC). */
  RISK_FLATTEN_POOL_FEE: z.coerce.number().int().min(0).default(3000),
  /** 0 = scan Kill logs from deployment.startBlock; otherwise only the last N blocks. */
  RISK_KILL_LOG_LOOKBACK_BLOCKS: z.coerce.number().int().min(0).default(0),
  RISK_VENUE_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  RISK_REDIS_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  RISK_TX_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  RISK_SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(20_000),
  /** Attempts per kill step within one run (exponential backoff from RISK_STEP_RETRY_MS). */
  RISK_STEP_ATTEMPTS: z.coerce.number().int().positive().default(3),
  RISK_STEP_RETRY_MS: z.coerce.number().int().positive().default(500),
  /** Orderly trade-scope key used for cancel-all + account reads (live mode; VERIFY). Mock is permissive. */
  RISK_ORDERLY_KEY: z.string().optional(),
  RISK_ORDERLY_SECRET: z.string().optional(),
};

const riskEnvSchema = baseEnvSchema.extend(riskEnvShape);
export type RiskEnv = z.infer<typeof riskEnvSchema>;

/**
 * Same semantics as shared `loadEnv(extra)`; parsed here with the extended schema directly because
 * loadEnv's declared return type collapses to the base env (union of the two schema branches).
 */
export function loadRiskEnv(source: Record<string, string | undefined> = process.env): RiskEnv {
  const parsed = riskEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** The subset of settings the pure domain + monitor logic needs (easy to build in tests). */
export interface RiskSettings {
  intervalMs: number;
  limitsEveryTicks: number;
  breachConfirmTicks: number;
  quoteMaxAgeMs: number;
  killMode: "enforce" | "alert";
  flattenMode: "net" | "all";
  flattenSlippageBps: number;
  flattenPoolFee: number;
  receiptsIntervalSec: number;
  stepAttempts: number;
  stepRetryMs: number;
  venueTimeoutMs: number;
}

export function settingsFromEnv(env: RiskEnv): RiskSettings {
  return {
    intervalMs: env.RISK_INTERVAL_MS,
    limitsEveryTicks: env.RISK_LIMITS_EVERY_TICKS,
    breachConfirmTicks: env.RISK_BREACH_CONFIRM_TICKS,
    quoteMaxAgeMs: env.RISK_QUOTE_MAX_AGE_MS,
    killMode: env.RISK_KILL_MODE,
    flattenMode: env.RISK_FLATTEN_MODE,
    flattenSlippageBps: env.RISK_FLATTEN_SLIPPAGE_BPS,
    flattenPoolFee: env.RISK_FLATTEN_POOL_FEE,
    receiptsIntervalSec: env.RECEIPTS_INTERVAL_SECONDS,
    stepAttempts: env.RISK_STEP_ATTEMPTS,
    stepRetryMs: env.RISK_STEP_RETRY_MS,
    venueTimeoutMs: env.RISK_VENUE_TIMEOUT_MS,
  };
}

export function parseBookIds(s: string): Set<number> | null {
  const ids = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0);
  return ids.length ? new Set(ids) : null;
}
