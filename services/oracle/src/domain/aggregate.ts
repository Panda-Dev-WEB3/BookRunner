// Multi-source aggregation: median of fresh observations, outliers beyond `outlierBps` of that
// median rejected, final price = median of the accepted set, ok iff >= minSources accepted.
import type { SourceQuote } from "./types";

export interface AggregateOptions {
  nowMs: number;
  outlierBps: number;
  minSources: number;
  /** default freshness window; `maxAgeMs` on a quote overrides it */
  maxAgeMs: number;
  /** tolerated clock skew for observations stamped in the future */
  maxFutureMs?: number;
}

export type RejectReason = "invalid" | "stale" | "duplicate" | "outlier";

export interface AggregateResult {
  ok: boolean;
  /** median of accepted sources (null when nothing usable) */
  price: number | null;
  accepted: SourceQuote[];
  rejected: Array<SourceQuote & { reason: RejectReason }>;
  /** independent sources behind `price` when it differs from accepted.length (index levels) */
  sourceCount?: number;
  /** why ok is false */
  reason?: string;
}

/** Number of independent sources behind an aggregate. */
export const sourceCountOf = (a: AggregateResult): number => a.sourceCount ?? a.accepted.length;

export type CollectedQuote = SourceQuote & { maxAgeMs?: number };

export function median(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error("median of empty set");
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** |a - b| / b in bps */
export function deviationBps(a: number, b: number): number {
  return (Math.abs(a - b) / b) * 1e4;
}

/** Float-safe "deviation strictly exceeds limit" (1e-9 bps tolerance at the boundary). */
export function exceedsBps(a: number, b: number, limitBps: number): boolean {
  return deviationBps(a, b) > limitBps + 1e-9;
}

export function aggregate(quotes: readonly CollectedQuote[], o: AggregateOptions): AggregateResult {
  const rejected: AggregateResult["rejected"] = [];
  const byName = new Map<string, CollectedQuote>();
  const maxFuture = o.maxFutureMs ?? 5_000;

  for (const q of quotes) {
    const plain: SourceQuote = { name: q.name, price: q.price, ts: q.ts };
    if (!Number.isFinite(q.price) || q.price <= 0 || !Number.isFinite(q.ts) || q.ts > o.nowMs + maxFuture) {
      rejected.push({ ...plain, reason: "invalid" });
      continue;
    }
    if (o.nowMs - q.ts > (q.maxAgeMs ?? o.maxAgeMs)) {
      rejected.push({ ...plain, reason: "stale" });
      continue;
    }
    const prev = byName.get(q.name);
    if (prev) {
      // one vote per source: keep the newest observation
      const [keep, drop] = q.ts > prev.ts ? [q, prev] : [prev, q];
      byName.set(q.name, keep);
      rejected.push({ name: drop.name, price: drop.price, ts: drop.ts, reason: "duplicate" });
      continue;
    }
    byName.set(q.name, q);
  }

  const fresh = [...byName.values()].map((q) => ({ name: q.name, price: q.price, ts: q.ts }));
  if (fresh.length === 0) return { ok: false, price: null, accepted: [], rejected, reason: "no fresh sources" };

  const m = median(fresh.map((q) => q.price));
  const accepted: SourceQuote[] = [];
  for (const q of fresh) {
    if (exceedsBps(q.price, m, o.outlierBps)) rejected.push({ ...q, reason: "outlier" });
    else accepted.push(q);
  }
  accepted.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const price = accepted.length > 0 ? median(accepted.map((q) => q.price)) : null;
  const ok = accepted.length >= o.minSources && price !== null;
  return ok
    ? { ok, price, accepted, rejected }
    : { ok: false, price, accepted, rejected, reason: `${accepted.length} of ${o.minSources} required sources` };
}
