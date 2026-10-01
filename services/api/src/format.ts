// Output formatting: every value leaving the API is JSON-safe (no bigint). USD amounts and shares
// are decimal strings with exactly 6 decimals ("25000.000000"); WAD values are decimal strings.
import { USD_DECIMALS, dbUsd, formatFixed, parseFixed } from "@bookrunner/shared/units";

/** Raw 6dp bigint -> "1234.560000". */
export function usdStr(raw: bigint): string {
  const s = formatFixed(raw, USD_DECIMALS);
  const [i, f = ""] = s.split(".");
  return `${i}.${f.padEnd(USD_DECIMALS, "0")}`;
}

/** numeric(38,6) DB string (or null) -> canonical 6dp string (or null). */
export function dbUsdStr(v: string | null | undefined): string | null {
  return v == null ? null : usdStr(dbUsd.fromDb(v));
}

/** Human decimal ("25000", "0.5", 1000) -> raw 6dp bigint. Throws on malformed input. */
export function parseUsd(v: string | number): bigint {
  const s = typeof v === "number" ? v.toFixed(USD_DECIMALS) : v.trim();
  return parseFixed(s, USD_DECIMALS);
}

/** WAD bigint -> decimal string ("1.0123"), trailing zeros trimmed (at least one decimal). */
export function wadStr(raw: bigint): string {
  const s = formatFixed(raw, 18);
  return s.includes(".") ? s : `${s}.0`;
}

/** BKRN (18 decimals) -> decimal string. */
export const bkrnStr = wadStr;

/**
 * Share price persisted as double precision by the mark service. Values > 1e9 are treated as WAD
 * scaled (1e18 = 1.0); smaller values as human prices. Returns a decimal string or null.
 */
export function sharePriceStr(v: number | string | null | undefined): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^\d+$/.test(t) && t.length > 12) return wadStr(BigInt(t));
    const n = Number(t);
    return Number.isFinite(n) ? sharePriceStr(n) : null;
  }
  if (!Number.isFinite(v)) return null;
  const human = v > 1e9 ? v / 1e18 : v;
  return trimNumber(human, 12);
}

function trimNumber(n: number, dp: number): string {
  const s = n.toFixed(dp).replace(/0+$/, "");
  return s.endsWith(".") ? `${s}0` : s;
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export const unixSec = (d: Date): number => Math.floor(d.getTime() / 1000);

export const fromUnix = (sec: number | bigint): Date => new Date(Number(sec) * 1000);

/** Accepts unix seconds, unix ms (> 1e12) or an ISO string. */
export function toDate(v: number | string | Date): Date {
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000);
  const n = Number(v);
  if (/^\d+$/.test(v) && Number.isFinite(n)) return toDate(n);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid time: ${v}`);
  return d;
}

/** JSON replacer: bigint -> decimal string. */
export const jsonSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/** Deep-convert bigints to strings and Dates to ISO strings (REST / MCP output). */
export function toJsonValue<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, jsonSafe));
}
