// Environment for the bookrunner agent and the trader simulator (extends the shared base env).

import { baseEnvSchema, loadEnv } from "@bookrunner/shared";
import { z } from "zod";
import type { RuleBasedSizingConfig } from "./domain/sizing";
import type { QuotingConfig } from "./domain/quoting";
import type { EwmaVolConfig } from "./domain/volatility";
import type { EngineVenueConfig } from "./venues/engine";
import type { HedgePlannerConfig } from "./domain/hedge-planner";
import { usd } from "@bookrunner/shared";

const num = (d: number) => z.coerce.number().default(d);
const flag = (d: boolean) => z.stringbool().default(d);

export const agentEnvShape = {
  BOOK_ID: z.coerce.number().int().positive().optional(),
  DESK_KEY_PRIVATE_KEY: z.string().optional(),
  ORACLE_PRICE_ID: z.string().optional(), // override the registry-derived price id (e.g. "NVDA")
  ORDERLY_ACCOUNT_ID: z.string().optional(), // override adapter.accountId(MM)
  DEPLOYMENT_RETRY_MS: num(10_000),

  // loops
  AGENT_QUOTE_INTERVAL_MS: num(1_000),
  AGENT_STATE_REFRESH_MS: num(5_000),
  AGENT_FILL_POLL_MS: num(2_000),
  AGENT_HEDGE_INTERVAL_MS: num(15_000),
  AGENT_HEARTBEAT_TTL_MS: num(60_000),
  AGENT_HALT_LOG_MS: num(60_000),
  AGENT_PRICE_STALE_SECONDS: num(30), // no quoting without a price update this recent
  AGENT_CHAIN_PRICE_FALLBACK_SECONDS: num(10), // poll AttestedOracle when Redis is this quiet

  // Avellaneda-Stoikov + clamps
  AGENT_GAMMA: num(50),
  AGENT_K: num(2_000),
  AGENT_HORIZON_SECONDS: num(3_600),
  AGENT_WIDTH_SAFETY_BPS: num(0.5),
  AGENT_SKEW_SAFETY_BPS: num(0.5),
  AGENT_MAX_WIDTH_BPS: num(300),
  AGENT_TICK_SIZE: num(0),

  // volatility
  AGENT_VOL_HALFLIFE_SECONDS: num(600),
  AGENT_VOL_PRIOR_ANNUAL: num(0.6),
  AGENT_VOL_MIN_ANNUAL: num(0.05),
  AGENT_VOL_MAX_ANNUAL: num(5),
  AGENT_VOL_MAX_GAP_SECONDS: num(600),
  AGENT_VOL_MIN_SAMPLES: num(20),

  // sizing
  AGENT_BASE_SIZE_USD: num(2_500),
  AGENT_MAX_HEADROOM_FRACTION: num(0.25),
  AGENT_INVENTORY_TILT: num(0.75),
  AGENT_VOL_REF_ANNUAL: num(1),
  AGENT_MIN_SIZE_USD: num(10),
  AGENT_LOT_SIZE: num(0),

  // cancel/replace venues (Orderly)
  AGENT_REQUOTE_BPS: num(1),
  AGENT_REQUOTE_SIZE_FRAC: num(0.2),
  AGENT_REQUOTE_MAX_MS: num(10_000),

  // persistence sampling
  AGENT_QUOTE_SAMPLE_MS: num(1_000),
  AGENT_QUOTE_RECEIPT_MS: num(5_000),

  // pull oracle (docs/LOW_GAS.md §1): desk actions carry the freshest signed prices
  /** auto: executeWithPrices when the deployed desk has it; on: always; off: plain execute (stored prices). */
  AGENT_PULL_PRICES: z.enum(["auto", "on", "off"]).default("auto"),
  /** Signed prices older than this are not carried (the desk then runs on the stored price). */
  AGENT_PRICE_DATA_MAX_AGE_SECONDS: num(60),
  /**
   * SetQuote / inventory moves carry no prices while the stored book price is in-hours and younger than
   * this (someone else already landed it; well below config.maxPriceAge = 300 s). 0 = always carry.
   */
  AGENT_PRICE_DATA_SKIP_IF_STORED_SECONDS: num(120),
  /** Optional oracle service base URL (GET /prices/signed); Redis KEYS.oracleBundle is always read. */
  ORACLE_URL: z.string().optional(),

  // engine venue (desk SetQuote) — low-gas defaults (docs/LOW_GAS.md §4): re-quote only on a >= 5 bps
  // spread/skew move or a >= 5% exposure-cap step, at most once a minute (urgent capacity cuts and
  // out-of-mandate corrections are immediate), unchanged-but-different params refreshed every 15 min
  ENGINE_MIN_RESEND_MS: num(60_000),
  ENGINE_REFRESH_MS: num(900_000),
  ENGINE_SPREAD_THRESHOLD_BPS: num(5),
  ENGINE_SKEW_THRESHOLD_BPS: num(5),
  ENGINE_EXPOSURE_STEP_BPS: num(500),
  ENGINE_FAILURE_BACKOFF_MS: num(15_000),
  ENGINE_FILL_LOOKBACK_BLOCKS: num(600),
  ENGINE_LOG_CHUNK_BLOCKS: num(2_000),

  // hedging
  HEDGE_ENABLED: flag(true),
  HEDGE_MIN_TRADE_USD: num(250),
  /** Per-leg floor (USD): basket legs below it are skipped (each leg is a desk tx). Retiring sweeps dust regardless. */
  HEDGE_MIN_LEG_USD: num(50),
  /**
   * Reversal hold: a trade opposite to the last one (sell after buy, buy after sell) waits this long
   * unless the ratio is out of an enforced band (always fixed immediately). 0 = off.
   */
  HEDGE_REVERSE_HOLD_MS: num(600_000),
  HEDGE_SLIPPAGE_BPS: num(100),
  HEDGE_POOL_FEE: num(3_000), // VERIFY Stock Token pool fee tiers on RHC
  HEDGE_TARGET_RATIO_BPS: z.coerce.number().optional(),
  HEDGE_PERP_ENABLED: flag(false),
  /** Retiring: desk USDC above this is returned to the vault. 0 = all of it (finalizeRetirement needs 0 deployed). */
  HEDGE_RETURN_DUST_USD: num(0),
  /** JSON [{asset, venue}] override of the allow-list pairs (bytes32 hex or ASCII venue names). */
  HEDGE_ALLOW_PAIRS: z.string().optional(),

  TX_RECEIPT_TIMEOUT_MS: num(60_000),
  /**
   * SIGINT/SIGTERM: no new quote / hedge leg starts; a desk tx in flight gets this long to confirm and
   * be recorded (plus the shutdown quote freeze) before the process exits 0 anyway.
   */
  AGENT_SHUTDOWN_GRACE_MS: num(8_000),
};

/**
 * Parse base + extra env. Same semantics as shared loadEnv(); typed locally because loadEnv's
 * conditional schema type widens to the base env and drops the extension fields.
 */
export function parseEnv<T extends z.ZodRawShape>(extra: T, source: Record<string, string | undefined>) {
  loadEnv(undefined, source); // validates the base fields with the shared error format
  const schema = baseEnvSchema.extend(extra);
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

export function loadAgentEnv(source: Record<string, string | undefined> = process.env) {
  return parseEnv(agentEnvShape, source);
}
export type AgentEnv = ReturnType<typeof loadAgentEnv>;

export function quotingConfigFrom(env: AgentEnv): QuotingConfig {
  return {
    as: { gamma: env.AGENT_GAMMA, k: env.AGENT_K, horizonSec: env.AGENT_HORIZON_SECONDS },
    widthSafetyBps: env.AGENT_WIDTH_SAFETY_BPS,
    skewSafetyBps: env.AGENT_SKEW_SAFETY_BPS,
    maxWidthBps: env.AGENT_MAX_WIDTH_BPS,
    tickSize: env.AGENT_TICK_SIZE,
    sizeLimits: { minSizeUsd: env.AGENT_MIN_SIZE_USD, ...(env.AGENT_LOT_SIZE > 0 ? { lotSize: env.AGENT_LOT_SIZE } : {}) },
  };
}

export function volConfigFrom(env: AgentEnv): EwmaVolConfig {
  return {
    halfLifeSec: env.AGENT_VOL_HALFLIFE_SECONDS,
    priorAnnualVol: env.AGENT_VOL_PRIOR_ANNUAL,
    minAnnualVol: env.AGENT_VOL_MIN_ANNUAL,
    maxAnnualVol: env.AGENT_VOL_MAX_ANNUAL,
    maxGapSec: env.AGENT_VOL_MAX_GAP_SECONDS,
    minSamples: env.AGENT_VOL_MIN_SAMPLES,
  };
}

export function sizingConfigFrom(env: AgentEnv): RuleBasedSizingConfig {
  return {
    baseSizeUsd: env.AGENT_BASE_SIZE_USD,
    maxHeadroomFraction: env.AGENT_MAX_HEADROOM_FRACTION,
    inventoryTilt: env.AGENT_INVENTORY_TILT,
    volRefAnnual: env.AGENT_VOL_REF_ANNUAL,
  };
}

export function engineVenueConfigFrom(env: AgentEnv): EngineVenueConfig {
  return {
    minIntervalMs: env.ENGINE_MIN_RESEND_MS,
    refreshIntervalMs: env.ENGINE_REFRESH_MS,
    spreadThresholdBps: env.ENGINE_SPREAD_THRESHOLD_BPS,
    skewThresholdBps: env.ENGINE_SKEW_THRESHOLD_BPS,
    exposureStepBps: env.ENGINE_EXPOSURE_STEP_BPS,
    failureBackoffMs: env.ENGINE_FAILURE_BACKOFF_MS,
  };
}

export function hedgeConfigFrom(env: AgentEnv): HedgePlannerConfig {
  return {
    minTradeUsd: usd(env.HEDGE_MIN_TRADE_USD),
    minLegUsd: usd(env.HEDGE_MIN_LEG_USD),
    reverseHoldMs: env.HEDGE_REVERSE_HOLD_MS,
    slippageBps: env.HEDGE_SLIPPAGE_BPS,
    ...(env.HEDGE_TARGET_RATIO_BPS === undefined ? {} : { targetRatioBps: env.HEDGE_TARGET_RATIO_BPS }),
    perpEnabled: env.HEDGE_PERP_ENABLED,
    returnDustUsd: usd(env.HEDGE_RETURN_DUST_USD),
  };
}

export const simEnvShape = {
  TRADER_SIM_BOOKS: z.string().optional(), // comma-separated book ids (default: all launch books)
  /** per book; default 6 on the local devnet (31337), 1 elsewhere (docs/LOW_GAS.md §4: demo traffic) */
  TRADER_SIM_TRADES_PER_MIN: z.coerce.number().positive().optional(),
  /** auto: PoolEngine.trade/liquidate(..., priceData) when the deployed engine has them; on / off */
  TRADER_SIM_PULL_PRICES: z.enum(["auto", "on", "off"]).default("auto"),
  ORACLE_URL: z.string().optional(),
  TRADER_SIM_MIN_NOTIONAL_USD: num(200),
  TRADER_SIM_MAX_NOTIONAL_USD: num(3_000),
  TRADER_SIM_CLOSE_PROB: num(0.15),
  TRADER_SIM_SLIPPAGE_BPS: num(50),
  TRADER_SIM_MARGIN_USD: num(25_000), // margin kept per trader per engine market
  TRADER_SIM_MINT_USD: num(100_000), // devnet MockERC20 mint per top-up
  TRADER_SIM_MAX_LEVERAGE: num(5),
  TRADER_SIM_TRADERS: num(4),
  TRADER_SIM_SEED: num(42),
  TRADER_SIM_ORDERLY: flag(true),
  TRADER_SIM_ENGINE: flag(true),
  DEPLOYMENT_RETRY_MS: num(10_000),
  TX_RECEIPT_TIMEOUT_MS: num(60_000),
};

export const DEVNET_SIM_TRADES_PER_MIN = 6;
export const TESTNET_SIM_TRADES_PER_MIN = 1;

export function loadSimEnv(source: Record<string, string | undefined> = process.env) {
  const env = parseEnv(simEnvShape, source);
  const tradesPerMin = env.TRADER_SIM_TRADES_PER_MIN ?? (env.CHAIN_ID === 31337 ? DEVNET_SIM_TRADES_PER_MIN : TESTNET_SIM_TRADES_PER_MIN);
  return { ...env, TRADER_SIM_TRADES_PER_MIN: tradesPerMin };
}
export type SimEnv = ReturnType<typeof loadSimEnv>;
