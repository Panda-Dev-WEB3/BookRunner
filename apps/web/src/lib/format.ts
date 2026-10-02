// Display formatting. Pure, DOM-free (unit-tested under Bun). Exact USD / share amounts arrive from
// the API as 6-decimal strings and are formatted from bigint so no float rounding leaks into a
// displayed balance; floats are only used for prices, ratios and chart coordinates.
import { USD_DECIMALS, formatFixed, parseFixed } from "@bookrunner/shared/units";

export const DASH = "—";

/** Decimal string | number -> number (null when missing / malformed). Charts and ratios only. */
export function toNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 6dp decimal string -> raw bigint (null when malformed). */
export function usdRaw(v: string | number | null | undefined): bigint | null {
  if (v == null) return null;
  try {
    return parseFixed(typeof v === "number" ? v.toFixed(USD_DECIMALS) : v.trim(), USD_DECIMALS);
  } catch {
    return null;
  }
}

export const rawToDecimal = (raw: bigint): string => formatFixed(raw, USD_DECIMALS);

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface UsdFormat {
  dp?: number;
  /** Prefix a dollar sign. */
  symbol?: boolean;
  /** Always show the sign (+/-). */
  signed?: boolean;
  /** Compact notation for headline figures (12.9K, 4.2M). */
  compact?: boolean;
}

/** "25000.000000" -> "25,000.00". Exact (bigint) unless `compact`. */
export function fmtUsd(v: string | number | bigint | null | undefined, o: UsdFormat = {}): string {
  const raw = typeof v === "bigint" ? v : usdRaw(v);
  if (raw === null) return DASH;
  const dp = o.dp ?? 2;
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const sign = neg ? "-" : o.signed && abs > 0n ? "+" : "";
  const cur = o.symbol ? "$" : "";
  if (o.compact) {
    const n = Number(abs) / 1e6;
    if (n >= 1e9) return `${sign}${cur}${trimDp(n / 1e9, 2)}B`;
    if (n >= 1e6) return `${sign}${cur}${trimDp(n / 1e6, 2)}M`;
    if (n >= 1e4) return `${sign}${cur}${trimDp(n / 1e3, 1)}K`;
  }
  // round half up at dp (display only)
  const scale = 10n ** BigInt(USD_DECIMALS - Math.min(dp, USD_DECIMALS));
  const rounded = dp >= USD_DECIMALS ? abs : ((abs + scale / 2n) / scale) * scale;
  const s = formatFixed(rounded, USD_DECIMALS);
  const [i = "0", f = ""] = s.split(".");
  const frac = dp > 0 ? `.${f.padEnd(dp, "0").slice(0, dp)}` : "";
  return `${sign}${cur}${group(i)}${frac}`;
}

function trimDp(n: number, dp: number): string {
  return n.toFixed(dp).replace(/\.?0+$/, "");
}

/** Plain number with grouping. */
export function fmtNum(v: number | null | undefined, dp = 2): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const s = Math.abs(v).toFixed(dp);
  const [i = "0", f] = s.split(".");
  return `${v < 0 && Number(s) !== 0 ? "-" : ""}${group(i)}${f ? `.${f}` : ""}`;
}

/** Quote / oracle price: 2 dp at or above 10, 4 dp below. */
export function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return fmtNum(v, Math.abs(v) >= 10 ? 2 : 4);
}

/** NAV per share (decimal string, e.g. "1.0023451") -> "1.002345". */
export function fmtSharePrice(v: string | number | null | undefined, dp = 6): string {
  const n = toNum(v);
  if (n === null) return DASH;
  return n.toFixed(dp);
}

/** Basis points. */
export function fmtBps(v: number | null | undefined, o: { signed?: boolean; dp?: number } = {}): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const dp = o.dp ?? (Number.isInteger(v) ? 0 : 1);
  const s = Math.abs(v).toFixed(dp);
  const sign = v < 0 && Number(s) !== 0 ? "-" : o.signed && v > 0 ? "+" : "";
  return `${sign}${s} bps`;
}

/** Fraction -> percent ("0.425" -> "42.5%"). */
export function fmtPct(frac: number | null | undefined, dp = 1): string {
  if (frac == null || !Number.isFinite(frac)) return DASH;
  return `${(frac * 100).toFixed(dp)}%`;
}

/** bps -> percent string (7000 -> "70%"). */
export function bpsPct(bps: number | null | undefined, dp = 0): string {
  if (bps == null || !Number.isFinite(bps)) return DASH;
  const v = bps / 100;
  return `${Number.isInteger(v) && dp === 0 ? v.toFixed(0) : v.toFixed(Math.max(dp, 1))}%`;
}

/** Elapsed time, compact: "now", "12s", "4m", "3h 12m", "2d 4h". */
export function fmtAge(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return DASH;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 2) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function ageMs(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : now - t;
}

/** Human duration for configured windows: 600 -> "10 min", 172800 -> "2 days". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return DASH;
  const s = Math.max(0, Math.round(seconds));
  if (s === 0) return "none";
  const units: Array<[number, string, string]> = [
    [86_400, "day", "days"],
    [3_600, "h", "h"],
    [60, "min", "min"],
    [1, "s", "s"],
  ];
  const parts: string[] = [];
  let rest = s;
  for (const [size, one, many] of units) {
    if (rest >= size) {
      const n = Math.floor(rest / size);
      rest -= n * size;
      parts.push(`${n} ${n === 1 ? one : many}`);
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

/** Timestamp in a fixed, sortable form: "2026-10-02 14:05:12". */
export function fmtDateTime(iso: string | number | null | undefined, timeZone?: string): string {
  if (iso == null) return DASH;
  const d = new Date(typeof iso === "number" ? (iso > 1e12 ? iso : iso * 1000) : iso);
  if (Number.isNaN(d.getTime())) return DASH;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function fmtTime(iso: string | number | null | undefined, timeZone?: string): string {
  const s = fmtDateTime(iso, timeZone);
  return s === DASH ? s : s.slice(11);
}

/** 0x1234…abcd */
export function shortHex(h: string | null | undefined, head = 6, tail = 4): string {
  if (!h) return DASH;
  if (h.length <= head + tail + 1) return h;
  return `${h.slice(0, head)}…${h.slice(-tail)}`;
}

/** Venue symbol -> display ticker: PERP_NVDA_USDC -> NVDA, RHX5-PERP -> RHX5. */
export function tickerOf(symbol: string | null | undefined): string {
  if (!symbol) return DASH;
  const m = /^PERP_([A-Z0-9.]+)_[A-Z]+$/i.exec(symbol) ?? /^([A-Z0-9.]+)-PERP$/i.exec(symbol);
  return (m?.[1] ?? symbol).toUpperCase();
}

export const isZeroHash =(h: string | null | undefined) => !h || /^0x0*$/.test(h);

/** Signed exposure in USD from a float (risk snapshots carry floats). */
export function fmtUsdFloat(v: number | null | undefined, o: UsdFormat = {}): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return fmtUsd(v.toFixed(USD_DECIMALS), o);
}

/** Investor-facing date and time in the reader's time zone (or `timeZone`), e.g. "1 Nov 2026, 16:16 UTC". */
export function fmtWhen(sec: number | null | undefined, timeZone?: string): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return DASH;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(sec * 1000));
}

/** "1 Nov 2026" in the reader's time zone (or `timeZone`). */
export function fmtDay(sec: number | null | undefined, timeZone?: string): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return DASH;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone }).format(new Date(sec * 1000));
}

/** ISO string -> unix seconds (null when missing or malformed). */
export function isoToSec(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}
