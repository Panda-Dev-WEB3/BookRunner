// Index level = sum_i (weightBps_i / 1e4) * price_i over the components' published prices.
// sourceCount = the weakest component's source count; sources = one entry per component.
import type { AggregateResult } from "./aggregate";
import type { IndexComponent, SourceQuote } from "./types";

export interface ComponentPrice {
  price: number;
  sourceCount: number;
  /** unix ms of the component publication */
  ts: number;
}

export interface IndexLevelResult {
  ok: boolean;
  level: number | null;
  sources: SourceQuote[];
  sourceCount: number;
  missing: string[];
}

export function indexLevel(components: readonly IndexComponent[], prices: ReadonlyMap<string, ComponentPrice>): IndexLevelResult {
  if (components.length === 0) return { ok: false, level: null, sources: [], sourceCount: 0, missing: [] };
  const missing: string[] = [];
  const sources: SourceQuote[] = [];
  let level = 0;
  let count = Number.POSITIVE_INFINITY;
  for (const c of components) {
    const p = prices.get(c.priceId);
    if (!p) {
      missing.push(c.priceId);
      continue;
    }
    level += (c.weightBps / 1e4) * p.price;
    count = Math.min(count, p.sourceCount);
    sources.push({ name: c.priceId, price: p.price, ts: p.ts });
  }
  if (missing.length > 0) return { ok: false, level: null, sources, sourceCount: 0, missing };
  return { ok: true, level, sources, sourceCount: count, missing };
}

/** Adapts an index level to the aggregation result shape consumed by `decide`. */
export function indexAsAggregate(r: IndexLevelResult, minSources: number): AggregateResult {
  const ok = r.ok && r.sourceCount >= minSources;
  const base = { price: r.level, accepted: r.sources, rejected: [], sourceCount: r.sourceCount };
  if (ok) return { ok: true, ...base };
  const reason = r.missing.length > 0 ? `missing components: ${r.missing.join(",")}` : `weakest component has ${r.sourceCount} sources`;
  // off-hours seeding needs every component; an incomplete index is never seeded
  return { ok: false, ...base, accepted: r.ok ? r.sources : [], reason };
}
