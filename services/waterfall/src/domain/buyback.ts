// BKRN buyback decisions (pure). Execution lives in buyback.ts.
//   BkrnFeeRouter.buybackPending accrues half of every book's carry; once it reaches the threshold the
//   keeper swaps it to BKRN (executeBuyback), which BkrnStaking streams to stakers.
//   The router enforces the price bound on-chain (A5-02): the pool fee tier is pinned by the timelock,
//   each call is capped at maxBuybackPerCall, and the swap minimum is at least buybackFloor(amountIn) =
//   amountIn x reference price x (1 - maxSlippageBps). The keeper only TIGHTENS that bound:
//   minBkrnOut = max(quote * (1 - slippage), floor), quote = the buyback router's own quote
//   (MockSwapRouter.quote: the deploy-time fixed BKRN/USDC price), else a configured BKRN-per-USDC price,
//   else the on-chain floor itself. A quote below the floor means the pool is off-market or the reference
//   is stale: the keeper skips (the tx would revert) and warns.

const BPS = 10_000n;
const USDC_SCALE = 10n ** 6n;

export interface BuybackPolicy {
  /** Minimum buybackPending (USDC 6dp) before a buyback is sent. */
  thresholdUsd: bigint;
  /** Slippage tolerance applied to the quote (bps, < 10000). */
  slippageBps: bigint;
  /** Uniswap v3 pool fee tier, passed ONLY to a legacy (pre-A5-02) BkrnFeeRouter; the current one pins it. */
  poolFee: number;
  /** Fallback price, whole BKRN per whole USDC (WAD); 0 = none (falls back to the on-chain floor). */
  fallbackBkrnPerUsdcWad: bigint;
}

/** The fee router's on-chain bound for this pass (legacy router: no cap, no floor). */
export interface BuybackBound {
  /** maxBuybackPerCall (USDC 6dp); 0 = uncapped. */
  maxPerCall: bigint;
  /** buybackFloor(amountIn) for the planned amountIn (BKRN 18dp); 0 = none. */
  floor: bigint;
}

export type BuybackPlan =
  | { kind: "skip"; reason: string }
  | { kind: "buy"; amountIn: bigint; quote: bigint; minOut: bigint; floor: bigint; priceSource: "router" | "config" | "reference" };

export function buybackDue(pending: bigint, thresholdUsd: bigint): boolean {
  return pending > 0n && pending >= thresholdUsd;
}

/** USDC to swap this pass: all of `pending`, capped at the router's per-call maximum. */
export function buybackAmount(pending: bigint, maxPerCall: bigint): bigint {
  return maxPerCall > 0n && pending > maxPerCall ? maxPerCall : pending;
}

/** BKRN (18dp) for `amountIn` USDC (6dp) at `bkrnPerUsdcWad` whole BKRN per whole USDC (floored). */
export function quoteAtPrice(amountIn: bigint, bkrnPerUsdcWad: bigint): bigint {
  return (amountIn * bkrnPerUsdcWad) / USDC_SCALE;
}

/** quote * (10000 - slippageBps) / 10000, floored. */
export function minOutAfterSlippage(quote: bigint, slippageBps: bigint): bigint {
  if (slippageBps < 0n || slippageBps >= BPS) throw new Error(`slippageBps out of range: ${slippageBps}`);
  return (quote * (BPS - slippageBps)) / BPS;
}

/**
 * Buy back `buybackAmount(pending, bound.maxPerCall)` once pending reaches the threshold. `routerQuote` and
 * `bound.floor` must be for that amount. Never with a zero minBkrnOut.
 */
export function planBuyback(pending: bigint, routerQuote: bigint | null, p: BuybackPolicy, bound: BuybackBound = { maxPerCall: 0n, floor: 0n }): BuybackPlan {
  if (!buybackDue(pending, p.thresholdUsd)) return { kind: "skip", reason: "below threshold" };
  const amountIn = buybackAmount(pending, bound.maxPerCall);
  const floor = bound.floor;
  let quote: bigint;
  let priceSource: "router" | "config" | "reference";
  if (routerQuote !== null && routerQuote > 0n) {
    quote = routerQuote;
    priceSource = "router";
  } else if (p.fallbackBkrnPerUsdcWad > 0n) {
    quote = quoteAtPrice(amountIn, p.fallbackBkrnPerUsdcWad);
    priceSource = "config";
  } else if (floor > 0n) {
    quote = floor;
    priceSource = "reference";
  } else {
    return { kind: "skip", reason: "no BKRN price (buyback router has no quote, no fallback price and no on-chain floor)" };
  }
  if (priceSource === "router" && quote < floor) {
    return { kind: "skip", reason: "router quote below the on-chain reference floor (pool off-market or reference price stale)" };
  }
  const fromQuote = priceSource === "reference" ? floor : minOutAfterSlippage(quote, p.slippageBps);
  const minOut = fromQuote > floor ? fromQuote : floor;
  if (minOut === 0n) return { kind: "skip", reason: "quote rounds to zero BKRN" };
  return { kind: "buy", amountIn, quote, minOut, floor, priceSource };
}
