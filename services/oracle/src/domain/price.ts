import { parseFixed } from "@bookrunner/shared";

/** Published prices carry 8 decimals; priceWad is derived from the rounded value (exact, no float noise). */
export const PRICE_DECIMALS = 8;

export function roundPrice(p: number, dp = PRICE_DECIMALS): number {
  if (!Number.isFinite(p) || p < 0) throw new Error(`bad price ${p}`);
  return Number(p.toFixed(dp));
}

export function toPriceWad(p: number): bigint {
  return parseFixed(roundPrice(p).toFixed(PRICE_DECIMALS), 18);
}
