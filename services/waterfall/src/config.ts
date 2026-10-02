import { z } from "zod";
import { loadServiceEnv, zBool, zUsd, zWad } from "./kit/env";

export const waterfallEnvShape = {
  /** Scheduler + keeper loop cadence. */
  WATERFALL_TICK_SECONDS: z.coerce.number().positive().default(5),
  WATERFALL_EXPENSE_MODE: z.enum(["fixed", "metered"]).default("fixed"),
  /** fixed mode: expenses requested per period per book (on-chain cap applies). */
  WATERFALL_EXPENSES_USD: zUsd("1.00"),
  /** metered mode: oracle cost per period per book. */
  WATERFALL_ORACLE_COST_USD: zUsd("0.50"),
  /** metered mode: USD per ETH for keeper gas (VERIFY: oracle ETH/USD on RHC). */
  WATERFALL_ETH_USD: zWad("0"),
  /** Orderly books: max wait for ops-venue's fee sweep before distributing (keep < MARK_WAIT_SECONDS). */
  WATERFALL_SWEEP_WAIT_SECONDS: z.coerce.number().min(0).default(30),
  /**
   * Send distribute(period) even when the router holds no fee flow (a no-op tx that only labels the
   * period). Default false (docs/LOW_GAS.md §3): empty periods cost no gas and the mark is told not to wait.
   */
  WATERFALL_DISTRIBUTE_EMPTY: zBool(false),
  /** Settlement jobs processed in parallel (keeper txs stay serialised by the sender). */
  WATERFALL_CONCURRENCY: z.coerce.number().int().positive().default(4),
  WATERFALL_RECALL_BUFFER_BPS: z.coerce.number().int().min(0).max(10_000).default(100),
  WATERFALL_MIN_RECALL_USD: zUsd("1.00"),
  WATERFALL_FLAT_THRESHOLD_USD: zUsd("1.00"),
  WATERFALL_RETIRE_RECALL: zBool(true),
  WATERFALL_KEEPER_ENABLED: zBool(true),
  WATERFALL_ACTION_COOLDOWN_SECONDS: z.coerce.number().min(0).default(30),
  WATERFALL_LOG_CHUNK_BLOCKS: z.coerce.bigint().positive().default(10_000n),
  /** 0 = scan logs from deployment.startBlock. */
  WATERFALL_LOG_LOOKBACK_BLOCKS: z.coerce.bigint().min(0n).default(0n),
};

export function loadWaterfallConfig(source: Record<string, string | undefined> = process.env) {
  return loadServiceEnv(waterfallEnvShape, source);
}

export type WaterfallConfig = ReturnType<typeof loadWaterfallConfig>;
