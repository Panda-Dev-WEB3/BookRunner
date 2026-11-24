import { z } from "zod";
import { loadServiceEnv, zBool, zUsd, zWad } from "./kit/env";

export const waterfallEnvShape = {
  /** Scheduler + keeper loop cadence. */
  WATERFALL_TICK_SECONDS: z.coerce.number().positive().default(5),
  /**
   * RPC budget: protocol-level keeper duties (buyback threshold, insurance-pool epoch) run at most this often; 0 = every
   * tick (default; mainnet profile 300: fees accrue per daily mark, the epoch is days long).
   */
  WATERFALL_PROTOCOL_DUTY_SECONDS: z.coerce.number().min(0).max(86_400).default(0),
  /** RPC budget: BookFactory.bookIds() re-read at most this often (kit/books.ts BookDirectory); 0 = every tick. */
  BOOKS_REFRESH_SECONDS: z.coerce.number().min(0).max(3_600).default(0),
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
  /** Keeper (2026-10 insurance pool): InsurancePool.processEpoch once the oldest epoch is processable. */
  WATERFALL_POOL_EPOCH_ENABLED: zBool(true),
  /**
   * Keeper (2026-10 in-house engine markets): liquidation keeper (liquidationKeeper.ts). Liquidates positions that are
   * liquidatable at the fresh signed price, closes out wind-down / settled markets (forceClose).
   */
  WATERFALL_LIQ_ENABLED: zBool(true),
  /** Pass cadence while a market trades or closes out (mainnet profile 10 s). */
  WATERFALL_LIQ_INTERVAL_SECONDS: z.coerce.number().positive().max(300).default(10),
  /** Pass cadence with no open position or every market held / settled (off-hours: the held price does not move). */
  WATERFALL_LIQ_IDLE_INTERVAL_SECONDS: z.coerce.number().positive().max(3_600).default(60),
  /** Gas guard: a liquidation may cost at most its reward plus this (USD; a forceClose, which pays nothing, at most this). */
  WATERFALL_LIQ_GAS_MARGIN_USD: zUsd("0.50"),
  /** Gas guard: USD per ETH to compare cost and reward; 0 = WATERFALL_ETH_USD; both 0 = only the caps below apply. */
  WATERFALL_LIQ_ETH_USD: zWad("0"),
  /** Gas guard: most ETH one liquidation / close-out transaction may cost. */
  WATERFALL_LIQ_MAX_TX_COST_ETH: zWad("0.002"),
  /**
   * Gas policy (domain/liquidation.ts gasDecision): rolling one-hour budget of the LOSS-MAKING part of liquidations
   * (cost above the reward) and of reverted transactions. Liquidations that pay for themselves never use it.
   */
  WATERFALL_LIQ_HOURLY_GAS_ETH: zWad("0.01"),
  /** Gas policy: an under-water position leaving at least this bad debt (USD) is liquidated whatever the hourly budget. */
  WATERFALL_LIQ_BAD_DEBT_OVERRIDE_USD: zUsd("50"),
  /** Transactions per pass at most (liquidations first, largest reward first). */
  WATERFALL_LIQ_MAX_TX_PER_PASS: z.coerce.number().int().positive().max(100).default(10),
  /** Open positions per aggregate3 read. */
  WATERFALL_LIQ_BATCH_SIZE: z.coerce.number().int().positive().max(2_000).default(500),
  /** aggregate3 reads per pass at most; beyond batch x this, positions are paged across passes (alert liquidation_coverage). */
  WATERFALL_LIQ_MAX_BATCHES: z.coerce.number().int().positive().max(50).default(10),
  /** On-chain reconciliation of every engine_positions row (size 0 included) this often; 0 = off. */
  WATERFALL_LIQ_RECONCILE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(600),
  /** Slippage tolerance below the buyback router's quote for minBkrnOut. */
  WATERFALL_BUYBACK_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(9_999).default(100),
  /** Uniswap v3 fee tier passed ONLY to a legacy (pre-A5-02) BkrnFeeRouter; the current router pins it on-chain. */
  WATERFALL_BUYBACK_POOL_FEE: z.coerce.number().int().min(0).max(1_000_000).default(3000),
  /** Whole BKRN per whole USDC used when the buyback router has no quote (a real SwapRouter02); 0 = use the router's on-chain floor. */
  WATERFALL_BUYBACK_BKRN_PER_USDC: zWad("0"),
  /**
   * Uniswap v3 QuoterV2 for buyback quotes on a real SwapRouter02. Empty = the chain's known QuoterV2
   * (Robinhood Chain 4663: docs/VERIFY.md U1), none on devnet/testnet (MockSwapRouter quotes itself).
   */
  WATERFALL_UNIV3_QUOTER: z
    .string()
    .regex(/^(0x[0-9a-fA-F]{40})?$/, "an address or empty")
    .default(""),
  WATERFALL_LOG_CHUNK_BLOCKS: z.coerce.bigint().positive().default(10_000n),
  /** 0 = scan logs from deployment.startBlock. */
  WATERFALL_LOG_LOOKBACK_BLOCKS: z.coerce.bigint().min(0n).default(0n),
};

export function loadWaterfallConfig(source: Record<string, string | undefined> = process.env) {
  return loadServiceEnv(waterfallEnvShape, source);
}

export type WaterfallConfig = ReturnType<typeof loadWaterfallConfig>;

/** Robinhood Chain mainnet (the liquidation keeper refuses to start there without an ETH/USD price). */
const MAINNET_CHAIN_ID = 4663;

/**
 * Review I-4: ETH/USD (WAD) of the liquidation gas policy: WATERFALL_LIQ_ETH_USD, else WATERFALL_ETH_USD. On mainnet with
 * the keeper on, neither set = refusal to start: the policy could not tell a liquidation that pays from one that does
 * not (docs/RUNBOOK.md). The stack reads no ETH/USD feed today (the oracle signs stock prices; its DEX confirm pools are
 * Stock Token / USDG), so the price is configured, not derived; outside 100..100,000 USD it is refused as a typo.
 * Elsewhere 0 = caps only.
 */
export function liquidationEthUsd(cfg: Pick<WaterfallConfig, "CHAIN_ID" | "WATERFALL_LIQ_ETH_USD" | "WATERFALL_ETH_USD" | "WATERFALL_KEEPER_ENABLED" | "WATERFALL_LIQ_ENABLED">): bigint {
  const v = cfg.WATERFALL_LIQ_ETH_USD > 0n ? cfg.WATERFALL_LIQ_ETH_USD : cfg.WATERFALL_ETH_USD;
  if (!(cfg.WATERFALL_KEEPER_ENABLED && cfg.WATERFALL_LIQ_ENABLED)) return v;
  if (v === 0n && cfg.CHAIN_ID === MAINNET_CHAIN_ID)
    throw new Error("WATERFALL_LIQ_ETH_USD is required on mainnet (USD per ETH, e.g. 3000): the liquidation keeper's gas policy compares cost and reward with it (or set WATERFALL_LIQ_ENABLED=false)");
  const WAD = 10n ** 18n;
  if (v !== 0n && (v < 100n * WAD || v > 100_000n * WAD)) throw new Error("WATERFALL_LIQ_ETH_USD / WATERFALL_ETH_USD out of range (100..100000 USD per ETH)");
  return v;
}
