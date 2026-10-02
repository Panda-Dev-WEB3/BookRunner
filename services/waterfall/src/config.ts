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
   * Orderly books: after the earmark (FeesSwept), max wait for ops-venue's forwardPendingFees to carry the
   * earmarked fees to the router before distributing (else the period distributes the previous period's
   * fees). Keep WATERFALL_SWEEP_WAIT_SECONDS + this < MARK_WAIT_SECONDS.
   */
  WATERFALL_FEE_FORWARD_WAIT_SECONDS: z.coerce.number().min(0).default(45),
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
  /** Keeper: BkrnFeeRouter.executeBuyback once buybackPending reaches the threshold (carry -> BKRN stakers). */
  WATERFALL_BUYBACK_ENABLED: zBool(true),
  WATERFALL_BUYBACK_THRESHOLD_USD: zUsd("10.00"),
  /** Slippage tolerance below the buyback router's quote for minBkrnOut. */
  WATERFALL_BUYBACK_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(9_999).default(100),
  /** Uniswap v3 fee tier of the USDC/BKRN pool (MockSwapRouter ignores it). */
  WATERFALL_BUYBACK_POOL_FEE: z.coerce.number().int().min(0).max(1_000_000).default(3000),
  /** Whole BKRN per whole USDC used when the buyback router has no quote (a real SwapRouter02); 0 = skip. */
  WATERFALL_BUYBACK_BKRN_PER_USDC: zWad("0"),
  WATERFALL_LOG_CHUNK_BLOCKS: z.coerce.bigint().positive().default(10_000n),
  /** 0 = scan logs from deployment.startBlock. */
  WATERFALL_LOG_LOOKBACK_BLOCKS: z.coerce.bigint().min(0n).default(0n),
};

export function loadWaterfallConfig(source: Record<string, string | undefined> = process.env) {
  return loadServiceEnv(waterfallEnvShape, source);
}

export type WaterfallConfig = ReturnType<typeof loadWaterfallConfig>;
