// Flatten planning for the kill sequence (desk Flatten = sell Stock Tokens -> USDC). Pure.
//
// mode "net" (default, "flatten within mandate"): sell only the part of the spot hedge that does
//   not offset venue exposure, so |venue exposure + desk hedge| never increases (the mandate's
//   reduce-only rule for hedge legs). E.g. venue short 40k + desk long 38k → net -2k → sell nothing;
//   venue flat or long → sell everything.
// mode "all": sell every Stock Token the desk holds.
//
// minAmountOut = floor(oracle value of the tokens sold * (1e4 - slippageBps) / 1e4) in USDC (6dp).
import { BPS } from "@bookrunner/shared";
import type { Address } from "viem";

export interface Holding {
  token: Address;
  qtyRaw: bigint;
  /** USD 6dp value of qtyRaw at the oracle price (StockTokenRegistry.valueUsdAt, multiplier applied once). */
  valueUsd: bigint;
  priceWad: bigint;
  multiplierWad: bigint;
  decimals: number;
}

export interface FlattenOrder {
  token: Address;
  amountIn: bigint;
  expectedOutUsd: bigint;
  minAmountOut: bigint;
  priceWad: bigint;
  multiplierWad: bigint;
}

export interface FlattenPlan {
  sellUsd: bigint;
  orders: FlattenOrder[];
  skipped: Array<{ token: Address; reason: "no_price" }>;
}

/**
 * StockTokenRegistry valuation (ARCHITECTURE §2.7), used only when the registry read fails:
 *   valueUsd = qtyRaw * multiplierWad * priceWad / (10^decimals * 1e18) / 1e12   (WAD USD -> 6dp)
 * The multiplier is applied exactly once.
 */
export function stockValueUsd(qtyRaw: bigint, multiplierWad: bigint, priceWad: bigint, decimals: number): bigint {
  return (qtyRaw * multiplierWad * priceWad) / (10n ** BigInt(decimals) * 10n ** 18n) / 10n ** 12n;
}

export function planFlatten(args: {
  holdings: Holding[];
  /** venue net exposure + signed desk hedge notional (book net exposure), USD 6dp. */
  netBookExposureUsd: bigint;
  mode: "net" | "all";
  slippageBps: number;
}): FlattenPlan {
  const held = args.holdings.filter((h) => h.qtyRaw > 0n);
  const skipped = held.filter((h) => h.valueUsd <= 0n).map((h) => ({ token: h.token, reason: "no_price" as const }));
  const priced = held.filter((h) => h.valueUsd > 0n);
  const spotUsd = priced.reduce((s, h) => s + h.valueUsd, 0n);
  if (spotUsd === 0n) return { sellUsd: 0n, orders: [], skipped };

  let sellUsd: bigint;
  if (args.mode === "all") sellUsd = spotUsd;
  else {
    const n = args.netBookExposureUsd;
    sellUsd = n <= 0n ? 0n : n >= spotUsd ? spotUsd : n;
  }
  if (sellUsd === 0n) return { sellUsd, orders: [], skipped };

  const slip = BigInt(Math.max(0, Math.min(10_000, Math.floor(args.slippageBps))));
  const orders: FlattenOrder[] = [];
  for (const h of priced) {
    const amountIn = sellUsd === spotUsd ? h.qtyRaw : (h.qtyRaw * sellUsd) / spotUsd;
    if (amountIn === 0n) continue;
    const expectedOutUsd = (h.valueUsd * amountIn) / h.qtyRaw;
    orders.push({
      token: h.token,
      amountIn,
      expectedOutUsd,
      minAmountOut: (expectedOutUsd * (BPS - slip)) / BPS,
      priceWad: h.priceWad,
      multiplierWad: h.multiplierWad,
    });
  }
  return { sellUsd, orders, skipped };
}
