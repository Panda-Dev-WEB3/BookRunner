// BKRN buyback decisions (pure). Execution lives in buyback.ts.
//   BkrnFeeRouter.buybackPending accrues half of every book's carry; once it reaches the threshold the
//   keeper swaps all of it to BKRN (executeBuyback), which BkrnStaking distributes to stakers.
//   minBkrnOut = quote * (1 - slippage), quote = the buyback router's own quote (MockSwapRouter.quote:
//   the deploy-time fixed BKRN/USDC price) or, when the router has none, a configured BKRN-per-USDC price.

const BPS = 10_000n;
const USDC_SCALE = 10n ** 6n;

export interface BuybackPolicy {
  /** Minimum buybackPending (USDC 6dp) before a buyback is sent. */
  thresholdUsd: bigint;
  /** Slippage tolerance applied to the quote (bps, < 10000). */
  slippageBps: bigint;
  /** Uniswap v3 pool fee tier passed to executeBuyback (MockSwapRouter ignores it). */
  poolFee: number;
  /** Fallback price, whole BKRN per whole USDC (WAD); 0 = none (no quote -> no buyback). */
  fallbackBkrnPerUsdcWad: bigint;
}

export type BuybackPlan =
  | { kind: "skip"; reason: string }
  | { kind: "buy"; amountIn: bigint; quote: bigint; minOut: bigint; priceSource: "router" | "config" };

export function buybackDue(pending: bigint, thresholdUsd: bigint): boolean {
  return pending > 0n && pending >= thresholdUsd;
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

/** Buy back all of `pending` once it reaches the threshold; never with a zero minBkrnOut (the contract rejects it). */
export function planBuyback(pending: bigint, routerQuote: bigint | null, p: BuybackPolicy): BuybackPlan {
  if (!buybackDue(pending, p.thresholdUsd)) return { kind: "skip", reason: "below threshold" };
  let quote: bigint;
  let priceSource: "router" | "config";
  if (routerQuote !== null && routerQuote > 0n) {
    quote = routerQuote;
    priceSource = "router";
  } else if (p.fallbackBkrnPerUsdcWad > 0n) {
    quote = quoteAtPrice(pending, p.fallbackBkrnPerUsdcWad);
    priceSource = "config";
  } else {
    return { kind: "skip", reason: "no BKRN price (buyback router has no quote and no fallback price is configured)" };
  }
  const minOut = minOutAfterSlippage(quote, p.slippageBps);
  if (minOut === 0n) return { kind: "skip", reason: "quote rounds to zero BKRN" };
  return { kind: "buy", amountIn: pending, quote, minOut, priceSource };
}
