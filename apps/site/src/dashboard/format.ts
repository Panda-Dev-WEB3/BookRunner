// Display formatting (pure). Amounts arrive from the API as decimal strings; numbers here are for
// display only, never for accounting (exact amounts go through amount.ts as bigint).

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

export const toNum = (v: string | number | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** "$134,854.93"; a dash when unknown. */
export const usd = (v: string | number | null | undefined): string => {
  const n = toNum(v);
  return n === null ? "-" : usdFmt.format(n);
};

/** Signed USD for P&L ("+$243.64", "-$12.00"). */
export const signedUsd = (v: string | number | null | undefined): string => {
  const n = toNum(v);
  if (n === null) return "-";
  return `${n > 0 ? "+" : n < 0 ? "-" : ""}${usdFmt.format(Math.abs(n))}`;
};

export const num = (v: string | number | null | undefined, dp = 4): string => {
  const n = toNum(v);
  if (n === null) return "-";
  return dp === 4 ? numFmt.format(n) : new Intl.NumberFormat("en-US", { maximumFractionDigits: dp }).format(n);
};

/** Share price with 6 decimals ("1.014313"). */
export const price = (v: string | number | null | undefined): string => {
  const n = toNum(v);
  return n === null ? "-" : n.toFixed(6);
};

/** 0.1084 -> "10.8%". */
export const pct = (ratio: number | null | undefined, dp = 1): string => (ratio == null || !Number.isFinite(ratio) ? "-" : `${(ratio * 100).toFixed(dp)}%`);

/** 6000 -> "60%"; 9104 -> "91.04%". */
export const bpsPct = (bps: number | null | undefined): string => (bps == null ? "-" : `${Number((bps / 100).toFixed(2))}%`);

const toDate = (v: string | number | Date): Date => (v instanceof Date ? v : typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v));

/** ISO / unix seconds / unix ms -> "Oct 7, 2026". */
export const date = (v: string | number | Date | null | undefined): string =>
  v == null ? "-" : toDate(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** -> "05:00 PM" (local time). */
export const time = (v: string | number | Date | null | undefined): string =>
  v == null ? "-" : toDate(v).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

export const dateTime = (v: string | number | Date | null | undefined): string => (v == null ? "-" : `${date(v)} · ${time(v)}`);

/** Seconds -> "45s", "12 min", "3 h 05 min", "2 days 4 h". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, "0")} min`;
  const d = Math.floor(h / 24);
  return `${d} days${h % 24 ? ` ${h % 24} h` : ""}`;
}

/** Age of a timestamp relative to `nowMs`: "12 min ago", "in 4 min". */
export function ago(v: string | number | Date | null | undefined, nowMs: number): string {
  if (v == null) return "-";
  const diff = (nowMs - toDate(v).getTime()) / 1000;
  if (!Number.isFinite(diff)) return "-";
  return diff >= 0 ? `${duration(diff)} ago` : `in ${duration(-diff)}`;
}

/** 0x1234…abcd */
export const short = (hex: string | null | undefined, head = 6, tail = 4): string =>
  !hex ? "-" : hex.length <= head + tail + 2 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;

export const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
