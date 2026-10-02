// Chart transforms for NAV history. Marked points come from signed daily marks; the optional live
// point is the risk/mark service's estimate and is always kept distinct (kind: "live").
import { toNum } from "./format";

export interface MarkPointIn {
  ts: string;
  markId: number;
  navUsd: string;
  seniorNavUsd: string | null;
  juniorNavUsd: string | null;
  seniorSharePrice: string | null;
  juniorSharePrice: string | null;
  pnlUsd?: string | null;
}

export interface LivePointIn {
  navUsd: string | null;
  seniorNavUsd: string | null;
  juniorNavUsd: string | null;
  ts: string | null;
}

export interface NavPoint {
  t: number; // unix ms
  kind: "mark" | "live";
  markId: number | null;
  nav: number;
  senior: number | null;
  junior: number | null;
  seniorPrice: number | null;
  juniorPrice: number | null;
}

/** Sorted, de-duplicated marked points, plus the live estimate when it is newer than the last mark. */
export function navSeries(points: MarkPointIn[], live: LivePointIn | null, nowMs = Date.now()): NavPoint[] {
  const byId = new Map<number, NavPoint>();
  for (const p of points) {
    const t = Date.parse(p.ts);
    const nav = toNum(p.navUsd);
    if (Number.isNaN(t) || nav === null) continue;
    byId.set(p.markId, {
      t,
      kind: "mark",
      markId: p.markId,
      nav,
      senior: toNum(p.seniorNavUsd),
      junior: toNum(p.juniorNavUsd),
      seniorPrice: toNum(p.seniorSharePrice),
      juniorPrice: toNum(p.juniorSharePrice),
    });
  }
  const out = [...byId.values()].sort((a, b) => a.t - b.t || (a.markId ?? 0) - (b.markId ?? 0));
  const liveNav = live ? toNum(live.navUsd) : null;
  if (live && liveNav !== null) {
    const parsed = live.ts ? Date.parse(live.ts) : Number.NaN;
    const t = Number.isNaN(parsed) ? nowMs : parsed;
    const last = out[out.length - 1];
    if (!last || t > last.t) {
      out.push({
        t,
        kind: "live",
        markId: null,
        nav: liveNav,
        senior: toNum(live.seniorNavUsd),
        junior: toNum(live.juniorNavUsd),
        seniorPrice: null,
        juniorPrice: null,
      });
    }
  }
  return out;
}

/** True when every marked point carries both tranche NAVs (the stacked view is meaningful). */
export function hasTrancheSplit(series: NavPoint[]): boolean {
  const marks = series.filter((p) => p.kind === "mark");
  return marks.length > 0 && marks.every((p) => p.senior !== null && p.junior !== null);
}

/** Y domain with headroom; never collapses to a zero-height range. */
export function paddedDomain(values: number[], pad = 0.08, floorAtZero = false): [number, number] {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return [0, 1];
  let lo = Math.min(...v);
  let hi = Math.max(...v);
  if (hi === lo) {
    const d = Math.abs(hi) * 0.01 || 1;
    lo -= d;
    hi += d;
  }
  const span = hi - lo;
  lo -= span * pad;
  hi += span * pad;
  if (floorAtZero && lo < 0 && Math.min(...v) >= 0) lo = 0;
  return [lo, hi];
}

/** Share-price series for one tranche (marked points only). */
export function sharePriceSeries(series: NavPoint[], tranche: "senior" | "junior"): Array<{ t: number; price: number; markId: number | null }> {
  return series
    .filter((p) => p.kind === "mark")
    .map((p) => ({ t: p.t, price: (tranche === "senior" ? p.seniorPrice : p.juniorPrice) ?? Number.NaN, markId: p.markId }))
    .filter((p) => Number.isFinite(p.price));
}

/** Fixed-size ring buffer append (client-side history of polled live values). */
export function ringPush<T>(buf: readonly T[], item: T, max: number, sameAs?: (a: T, b: T) => boolean): T[] {
  const last = buf[buf.length - 1];
  if (last !== undefined && sameAs?.(last, item)) return buf as T[];
  const next = [...buf, item];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Evenly spaced time ticks (unix ms) for an axis. */
export function timeTicks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) return [lo];
  const step = (hi - lo) / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(lo + i * step));
}
