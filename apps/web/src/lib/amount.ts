// Token amount entry: sanitising what a person types, parsing it to base units (bigint, exact) and
// checking it against a balance or limits. Pure and DOM-free (unit-tested in test/amount.test.ts).
import { formatFixed, parseFixed } from "@bookrunner/shared/units";

export const USDC_DECIMALS = 6;
export const BKRN_DECIMALS = 18;
export const ETH_DECIMALS = 18;

/**
 * Keeps what can become a valid amount while typing: digits and one decimal point, at most
 * `decimals` fraction digits. Commas, spaces and underscores are dropped ("1,000.5" -> "1000.5");
 * a leading "." becomes "0."; leading zeros collapse ("007" -> "7").
 */
export function sanitizeAmountInput(raw: string, decimals = USDC_DECIMALS): string {
  let s = raw.replace(/[\s,_]/g, "");
  s = s.replace(/[^\d.]/g, "");
  const dot = s.indexOf(".");
  if (dot >= 0) s = `${s.slice(0, dot + 1)}${s.slice(dot + 1).replace(/\./g, "")}`;
  let [int = "", frac] = s.split(".");
  int = int.replace(/^0+(?=\d)/, "");
  if (frac !== undefined) {
    if (decimals <= 0) return int || "0";
    frac = frac.slice(0, decimals);
    return `${int || "0"}.${frac}`;
  }
  return int;
}

/** "1234.5" -> base units (bigint). null when empty or not a plain non-negative decimal. */
export function parseAmount(value: string, decimals = USDC_DECIMALS): bigint | null {
  const v = value.trim();
  if (v === "" || v === ".") return null;
  const re = decimals > 0 ? new RegExp(`^\\d*(\\.\\d{0,${decimals}})?$`) : /^\d+$/;
  if (!re.test(v)) return null;
  try {
    return parseFixed(v.endsWith(".") ? v.slice(0, -1) || "0" : v, decimals);
  } catch {
    return null;
  }
}

/** Base units -> plain decimal for an input value ("1234.5"), no grouping, trailing zeros trimmed. */
export function formatAmountInput(raw: bigint, decimals = USDC_DECIMALS, maxDp = decimals): string {
  if (raw < 0n) raw = 0n;
  const dp = Math.max(0, Math.min(maxDp, decimals));
  const scale = 10n ** BigInt(decimals - dp);
  const floored = (raw / scale) * scale; // never round up past the balance
  return formatFixed(floored, decimals);
}

/** Base units -> grouped display string ("12,345.67"), floored at `dp` decimals. */
export function formatAmountDisplay(raw: bigint | null | undefined, decimals = USDC_DECIMALS, dp = 2): string {
  if (raw == null) return "—";
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const d = Math.max(0, Math.min(dp, decimals));
  const base = 10n ** BigInt(decimals);
  const int = abs / base;
  const fracDigits = (abs % base).toString().padStart(decimals, "0").slice(0, d);
  const grouped = int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const tiny = int === 0n && abs > 0n && /^0*$/.test(fracDigits);
  if (tiny) return `${neg ? "-" : ""}<${d > 0 ? `0.${"0".repeat(d - 1)}1` : "1"}`;
  return `${neg ? "-" : ""}${grouped}${d > 0 ? `.${fracDigits}` : ""}`;
}

export type AmountIssue = "empty" | "invalid" | "zero" | "below-min" | "above-max" | "exceeds-balance";

export interface AmountLimits {
  decimals?: number;
  /** Wallet balance in base units (null/undefined: unknown, not checked). */
  balance?: bigint | null;
  /** Inclusive minimum in base units. */
  min?: bigint | null;
  /** Inclusive maximum in base units (e.g. remaining capacity). */
  max?: bigint | null;
}

/** First problem with an entered amount, or null when it can be submitted. */
export function amountIssue(value: string, limits: AmountLimits = {}): AmountIssue | null {
  const decimals = limits.decimals ?? USDC_DECIMALS;
  if (value.trim() === "") return "empty";
  const raw = parseAmount(value, decimals);
  if (raw === null) return "invalid";
  if (raw === 0n) return "zero";
  if (limits.min != null && raw < limits.min) return "below-min";
  if (limits.max != null && raw > limits.max) return "above-max";
  if (limits.balance != null && raw > limits.balance) return "exceeds-balance";
  return null;
}

/** Plain-language message for an amount issue ("empty" has none: nothing typed yet). */
export function amountIssueText(issue: AmountIssue | null, symbol = "USDC"): string | null {
  switch (issue) {
    case null:
    case "empty":
      return null;
    case "invalid":
      return "Enter a number, for example 250 or 250.50.";
    case "zero":
      return "Enter an amount above zero.";
    case "below-min":
      return "This is below the minimum for this action.";
    case "above-max":
      return "This is more than the room left for this action.";
    case "exceeds-balance":
      return `This is more ${symbol} than the wallet holds.`;
  }
}
