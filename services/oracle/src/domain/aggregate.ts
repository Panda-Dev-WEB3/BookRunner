// Multi-source aggregation: median of fresh observations, outliers beyond `outlierBps` of that
// median rejected, final price = median of the accepted set, ok iff >= minSources accepted and, with exactly two
// accepted, they are within pairMaxBps of each other and neither is older than its pairMaxAgeMs.
import type { SourceQuote } from "./types";

export interface AggregateOptions {
  nowMs: number;
  outlierBps: number;
  minSources: number;
  /** default freshness window; `maxAgeMs` on a quote overrides it */
  maxAgeMs: number;
  /** tolerated clock skew for observations stamped in the future */
  maxFutureMs?: number;
  /**
   * When only two sources are accepted in a tick (the third down, or an outlier) the band cannot reject either
   * (each sits half their gap from the midpoint): refuse when they are further apart than this (bps of their
   * midpoint; default outlierBps, the source-check rule).
   */
  pairMaxBps?: number;
  /**
   * Per source name: the oldest observation that may back a price when only two sources are accepted (e.g.
   * Chainlink, whose in-session age is a deviation-triggered round and says little about the market). Older ->
   * refused, so a held-up round cannot co-sign with one other source.
   */
  pairMaxAgeMs?: Readonly<Record<string, number>>;
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
  /** set when exactly two accepted sources were refused as a pair (disagreement / too old to pair): never seed from them */
  pairRefused?: boolean;
  /**
   * Observations the signed sourcesHash commits to when they differ from `accepted` (primary-confirm: the primary
   * plus every fresh confirmer, so outsiders can see the confirm values; only the primary counts in sourceCount).
   */
  attested?: SourceQuote[];
  /** primary-confirm only: how the confirm sources compare with the primary (domain/confirm.ts) */
  confirm?: ConfirmResult;
}

/** primary-confirm: ok = every fresh confirmer within the band; no fresh confirmer = unavailable; no primary = no-primary. */
export type ConfirmStatus = "ok" | "diverged" | "unavailable" | "no-primary";

export interface ConfirmResult {
  status: ConfirmStatus;
  /** largest |confirmer - primary| / primary among fresh confirmers (bps); null when none */
  diffBps: number | null;
  primaryPrice: number | null;
  confirmers: Array<{ name: string; price: number; ts: number; diffBps: number }>;
}

/** Observations behind a signed price (what sourcesHash commits to). */
export const attestedOf = (a: AggregateResult): SourceQuote[] => a.attested ?? a.accepted;

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

/**
 * Drops invalid (non-positive, non-finite, future-stamped) and stale observations and keeps one (the newest) per
 * source name. Shared by both policies.
 */
export function freshQuotes(
  quotes: readonly CollectedQuote[],
  o: Pick<AggregateOptions, "nowMs" | "maxAgeMs" | "maxFutureMs">,
): { fresh: SourceQuote[]; rejected: AggregateResult["rejected"] } {
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
  return { fresh: [...byName.values()].map((q) => ({ name: q.name, price: q.price, ts: q.ts })), rejected };
}

export function aggregate(quotes: readonly CollectedQuote[], o: AggregateOptions): AggregateResult {
  const { fresh, rejected } = freshQuotes(quotes, o);
  if (fresh.length === 0) return { ok: false, price: null, accepted: [], rejected, reason: "no fresh sources" };

  const m = median(fresh.map((q) => q.price));
  const accepted: SourceQuote[] = [];
  for (const q of fresh) {
    if (exceedsBps(q.price, m, o.outlierBps)) rejected.push({ ...q, reason: "outlier" });
    else accepted.push(q);
  }
  accepted.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const price = accepted.length > 0 ? median(accepted.map((q) => q.price)) : null;
  if (accepted.length === 2 && price !== null) {
    const [a, b] = accepted as [SourceQuote, SourceQuote];
    const gap = deviationBps(Math.max(a.price, b.price), price) + deviationBps(Math.min(a.price, b.price), price);
    const limit = o.pairMaxBps ?? o.outlierBps;
    if (gap > limit + 1e-9) {
      return { ok: false, price, accepted, rejected, pairRefused: true, reason: `sources disagree: ${a.name} and ${b.name} are ${gap.toFixed(1)} bps apart (limit ${limit})` };
    }
    for (const q of [a, b]) {
      const maxAge = o.pairMaxAgeMs?.[q.name];
      if (maxAge !== undefined && maxAge > 0 && o.nowMs - q.ts > maxAge) {
        return {
          ok: false,
          price,
          accepted,
          rejected,
          pairRefused: true,
          reason: `${q.name} observation is ${Math.round((o.nowMs - q.ts) / 1000)}s old: too old to back a 2-source price (limit ${Math.round(maxAge / 1000)}s)`,
        };
      }
    }
  }
  const ok = accepted.length >= o.minSources && price !== null;
  return ok
    ? { ok, price, accepted, rejected }
    : { ok: false, price, accepted, rejected, reason: `${accepted.length} of ${o.minSources} required sources` };
}
