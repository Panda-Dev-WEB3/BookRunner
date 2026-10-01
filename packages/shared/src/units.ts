// Protocol-wide units (mirror of contracts/src/interfaces/BRTypes.sol).
//   USD amounts: 6 decimals (USDC units) — bigint "raw" values, `...Usd` suffix.
//   Tranche shares: 6 decimals.
//   Prices: WAD (1e18) USD per 1 whole unit of the underlying.
//   Stock Token multiplier: WAD.
//   bps: 1e4 = 100%.

export const USD_DECIMALS = 6;
export const USD = 10n ** 6n;
export const WAD = 10n ** 18n;
export const BPS = 10_000n;

/** "1234.56" | 1234.56 -> 1234560000n */
export function usd(v: string | number): bigint {
  return parseFixed(typeof v === "number" ? v.toFixed(USD_DECIMALS) : v, USD_DECIMALS);
}

/** 1234560000n -> "1234.56" (trailing zeros trimmed, at least 2 dp) */
export function formatUsd(raw: bigint, dp = 2): string {
  const s = formatFixed(raw, USD_DECIMALS);
  const [i, f = ""] = s.split(".");
  return `${i}.${f.padEnd(dp, "0").slice(0, Math.max(dp, 0))}`;
}

/** Raw 6dp -> JS number (for charts/analytics only; never for accounting). */
export function usdToNumber(raw: bigint): number {
  return Number(raw) / 1e6;
}

export function wad(v: string | number): bigint {
  return parseFixed(typeof v === "number" ? v.toString() : v, 18);
}

export function wadToNumber(raw: bigint): number {
  return Number(raw) / 1e18;
}

export function parseFixed(value: string, decimals: number): bigint {
  const neg = value.trim().startsWith("-");
  const v = neg ? value.trim().slice(1) : value.trim();
  const [i = "0", f = ""] = v.split(".");
  if (!/^\d*$/.test(i) || !/^\d*$/.test(f)) throw new Error(`invalid fixed-point value: ${value}`);
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  const out = BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return neg ? -out : out;
}

export function formatFixed(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const i = v / base;
  const f = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${i}${f ? `.${f}` : ""}`;
}

/** floor(a * b / d) for non-negative operands. */
export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error("mulDiv: division by zero");
  return (a * b) / d;
}

export function minBig(...xs: bigint[]): bigint {
  return xs.reduce((m, x) => (x < m ? x : m));
}

export function maxBig(...xs: bigint[]): bigint {
  return xs.reduce((m, x) => (x > m ? x : m));
}

export function absBig(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/** Postgres numeric(38,6) string <-> raw 6dp bigint */
export const dbUsd = {
  toDb: (raw: bigint): string => formatFixed(raw, USD_DECIMALS),
  fromDb: (s: string | null | undefined): bigint => (s == null ? 0n : parseFixed(s, USD_DECIMALS)),
};
