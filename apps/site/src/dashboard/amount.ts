// Token amount entry: parsing what a person types into exact base units and checking it against a
// balance or a maximum. Pure (test/amount.test.ts). Mirrors apps/web/src/lib/amount.ts.
import { formatFixed, parseFixed } from "@bookrunner/shared/units";

export const USDC_DECIMALS = 6;
export const SHARE_DECIMALS = 6;
export const BKRN_DECIMALS = 18;

/** "1,234.5" -> base units. null when empty or not a plain non-negative decimal within `decimals`. */
export function parseAmount(value: string, decimals = USDC_DECIMALS): bigint | null {
  const v = value.trim().replace(/[\s,_]/g, "");
  if (v === "" || v === ".") return null;
  const re = decimals > 0 ? new RegExp(`^\\d*(\\.\\d{0,${decimals}})?$`) : /^\d+$/;
  if (!re.test(v)) return null;
  try {
    return parseFixed(v.endsWith(".") ? v.slice(0, -1) || "0" : v, decimals);
  } catch {
    return null;
  }
}

/** Canonical decimal string the API accepts (/^\d+(\.\d{1,6})?$/), or null. */
export function normalizeAmount(value: string, decimals = USDC_DECIMALS): string | null {
  const raw = parseAmount(value, decimals);
  return raw === null ? null : formatFixed(raw, decimals);
}

/** Base units -> plain input value ("1234.5"), floored at `maxDp` decimals. */
export function formatAmountInput(raw: bigint, decimals = USDC_DECIMALS, maxDp = decimals): string {
  const v = raw < 0n ? 0n : raw;
  const dp = Math.max(0, Math.min(maxDp, decimals));
  const scale = 10n ** BigInt(decimals - dp);
  return formatFixed((v / scale) * scale, decimals);
}

/** Base units -> grouped display ("12,345.67"), floored at `dp` decimals; "<0.01" for dust. */
export function formatAmountDisplay(raw: bigint | null | undefined, decimals = USDC_DECIMALS, dp = 2): string {
  if (raw == null) return "-";
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const d = Math.max(0, Math.min(dp, decimals));
  const base = 10n ** BigInt(decimals);
  const int = abs / base;
  const fracDigits = (abs % base).toString().padStart(decimals, "0").slice(0, d);
  const grouped = int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (int === 0n && abs > 0n && /^0*$/.test(fracDigits)) return `${neg ? "-" : ""}<${d > 0 ? `0.${"0".repeat(d - 1)}1` : "1"}`;
  return `${neg ? "-" : ""}${grouped}${d > 0 ? `.${fracDigits}` : ""}`;
}

export type AmountIssue = "empty" | "invalid" | "zero" | "above-max" | "exceeds-balance";

export interface AmountLimits {
  decimals?: number;
  /** Wallet balance (null/undefined: unknown, not checked). */
  balance?: bigint | null;
  /** Inclusive maximum (e.g. shares held, free stake). */
  max?: bigint | null;
}

/** First problem with an entered amount, or null when it can be submitted. */
export function amountIssue(value: string, limits: AmountLimits = {}): AmountIssue | null {
  const decimals = limits.decimals ?? USDC_DECIMALS;
  if (value.trim() === "") return "empty";
  const raw = parseAmount(value, decimals);
  if (raw === null) return "invalid";
  if (raw === 0n) return "zero";
  if (limits.max != null && raw > limits.max) return "above-max";
  if (limits.balance != null && raw > limits.balance) return "exceeds-balance";
  return null;
}

export function amountIssueText(issue: AmountIssue | null, symbol = "USDC"): string | null {
  switch (issue) {
    case null:
      return null;
    case "empty":
      return "Enter an amount.";
    case "invalid":
      return "Enter a number, for example 250 or 250.50.";
    case "zero":
      return "Enter an amount above zero.";
    case "above-max":
      return `This is more ${symbol} than is available for this action.`;
    case "exceeds-balance":
      return `This is more ${symbol} than the wallet holds.`;
  }
}

/** Decimal string from the API ("134854.933474") -> base units (null when absent / malformed). */
export function apiAmount(v: string | null | undefined, decimals = USDC_DECIMALS): bigint | null {
  if (v == null) return null;
  const s = v.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const neg = s.startsWith("-");
  const [i = "0", f = ""] = (neg ? s.slice(1) : s).split(".");
  const raw = parseFixed(`${i}.${f.slice(0, decimals)}`, decimals);
  return neg ? -raw : raw;
}
