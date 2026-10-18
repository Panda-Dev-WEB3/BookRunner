// Receipt tree cache (audit 2026-10 M-4). receipts.proof / receipts.root used to rebuild an hour's Merkle
// tree on every call: ~150 us of CPU per leaf on Bun's single thread (OpenZeppelin StandardMerkleTree), so a
// busy hour costs tens to hundreds of ms per call. A CLOSED hour is immutable once the receipts service has
// committed its root (receipt_roots row, written after the window end + grace), so its tree is built once
// and kept in a bounded LRU. An hour still open is cached for a few seconds only (receipts keep arriving);
// a receipt the cached tree does not contain always forces a rebuild, so a proof never omits its own leaf.
// The receipts service does not persist proofs (services/receipts builds them on demand too), so the API
// keeps no second copy in the DB: the tree is derived from the stored leaves, as before.
// Period trees (a mark's receiptsRoot over its hourly roots) are cached per mark once they match the mark.
import type { BuiltTree } from "@bookrunner/shared/merkle";
import type { ReceiptRootRow, ReceiptRow } from "../data/types";
import type { ApiDeps } from "../deps";
import { type HourTree, hourTreeOf } from "./receipts";

/**
 * Bounds. A cached leaf retains ~700 bytes (tree nodes, values, lookup index; measured on Bun 1.4), so the
 * default 100,000 leaves keep the hour cache under ~70 MB. An hour larger than the whole bound is not
 * cached (built per call, still behind the receipts rate limit and the batch weight).
 */
export const RECEIPT_TREE_CACHE = {
  /** most hour trees kept */
  maxEntries: 256,
  /** most leaves kept across all cached hour trees (memory bound); API_RECEIPT_CACHE_LEAVES overrides */
  maxLeaves: 100_000,
  /** an hour without a committed root is reused this long */
  openTtlMs: 5_000,
  /** most mark period trees kept, and their total hourly leaves */
  periodEntries: 512,
  periodLeaves: 100_000,
} as const;

interface Slot<V> {
  value: V;
  weight: number;
  expiresAt: number | null;
}

/** LRU bounded by entry count and total weight; optional per-entry expiry. */
export class WeightedLru<V> {
  readonly maxEntries: number;
  readonly maxWeight: number;
  private readonly slots = new Map<string, Slot<V>>();
  private total = 0;
  readonly stats = { hits: 0, misses: 0, evictions: 0 };

  constructor(opts: { maxEntries: number; maxWeight: number }) {
    this.maxEntries = Math.max(1, opts.maxEntries);
    this.maxWeight = Math.max(1, opts.maxWeight);
  }

  get size() {
    return this.slots.size;
  }

  get weight() {
    return this.total;
  }

  get(key: string, now: number): V | undefined {
    const s = this.slots.get(key);
    if (!s) {
      this.stats.misses++;
      return undefined;
    }
    if (s.expiresAt !== null && now >= s.expiresAt) {
      this.delete(key);
      this.stats.misses++;
      return undefined;
    }
    // most recently used last
    this.slots.delete(key);
    this.slots.set(key, s);
    this.stats.hits++;
    return s.value;
  }

  /** false when the value alone exceeds the weight bound (not cached). */
  set(key: string, value: V, weight: number, expiresAt: number | null = null): boolean {
    this.delete(key);
    if (weight > this.maxWeight) return false;
    this.slots.set(key, { value, weight, expiresAt });
    this.total += weight;
    while (this.slots.size > this.maxEntries || this.total > this.maxWeight) {
      const oldest = this.slots.keys().next().value as string;
      this.delete(oldest);
      this.stats.evictions++;
    }
    return true;
  }

  delete(key: string) {
    const s = this.slots.get(key);
    if (!s) return;
    this.slots.delete(key);
    this.total -= s.weight;
  }
}

export interface PeriodRoots {
  from: Date;
  roots: ReceiptRootRow[];
  tree: BuiltTree;
}

export interface ReceiptCaches {
  hours: WeightedLru<HourTree>;
  periods: WeightedLru<PeriodRoots>;
  /** one build per hour at a time, however many requests ask for it together */
  inflight: Map<string, Promise<{ hour: HourTree; rows: ReceiptRow[] }>>;
}

const perDeps = new WeakMap<ApiDeps, ReceiptCaches>();

/** The process cache of these deps (one per API process; tests get one per world). */
export function receiptCaches(deps: ApiDeps): ReceiptCaches {
  let c = perDeps.get(deps);
  if (!c) {
    c = {
      hours: new WeightedLru({ maxEntries: RECEIPT_TREE_CACHE.maxEntries, maxWeight: deps.settings.receiptCacheLeaves ?? RECEIPT_TREE_CACHE.maxLeaves }),
      periods: new WeightedLru({ maxEntries: RECEIPT_TREE_CACHE.periodEntries, maxWeight: RECEIPT_TREE_CACHE.periodLeaves }),
      inflight: new Map(),
    };
    perDeps.set(deps, c);
  }
  return c;
}

/**
 * The tree of one book-hour. `stored` is its receipt_roots row (null while the hour is open). A cached tree
 * is reused when it was built for a closed hour (or the hour is still open and the entry fresh) and holds
 * `mustContain`; otherwise the leaves are read and the tree rebuilt (`rows` is then set).
 */
export async function hourTreeFor(
  deps: ApiDeps,
  bookId: number,
  hourStart: Date,
  stored: ReceiptRootRow | null,
  mustContain?: number,
): Promise<{ hour: HourTree; rows: ReceiptRow[] | null }> {
  const c = receiptCaches(deps);
  const key = `${bookId}:${hourStart.getTime()}`;
  const now = deps.now();
  const closed = stored !== null && hourStart.getTime() + deps.settings.receiptsIntervalSeconds * 1000 <= now;
  const hit = c.hours.get(key, now);
  if (hit && (hit.closed || !closed) && (mustContain === undefined || hit.ids.has(mustContain))) return { hour: hit, rows: null };
  let p = c.inflight.get(key);
  if (!p) {
    p = (async () => {
      const rows = await deps.data.receiptsInHour(bookId, hourStart);
      const hour = hourTreeOf(rows, closed);
      c.hours.set(key, hour, Math.max(1, rows.length), closed ? null : deps.now() + RECEIPT_TREE_CACHE.openTtlMs);
      return { hour, rows };
    })().finally(() => c.inflight.delete(key));
    c.inflight.set(key, p);
  }
  return p;
}
