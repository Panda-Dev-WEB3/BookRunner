// Process-wide defaults so callers can use the short signatures, e.g.
//   import { periodReceiptsRoot } from "@bookrunner/receipts";
//   const { root } = await periodReceiptsRoot(bookId, periodEnd - interval, periodEnd);
// Defaults come from env (DATABASE_URL, RECEIPTS_INTERVAL_SECONDS, MARK_INTERVAL_SECONDS,
// RECEIPTS_GRACE_SECONDS) unless overridden once with configureReceipts({ store, ... }) or per call.
import { createDb, type Db } from "@bookrunner/db";
import { type PeriodReceiptsRoot, type ReceiptProofResult, type ReceiptsDeps, periodRootWith, receiptProofWith } from "./roots";
import type { ReceiptsStore, StoredRoot } from "./store";
import { PgReceiptsStore } from "./store-pg";

let overrides: Partial<ReceiptsDeps> = {};
let lazy: ReturnType<typeof createDb> | null = null;

const envNum = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Override defaults (e.g. the api passes its own Drizzle db). */
export function configureReceipts(d: Partial<ReceiptsDeps> & { db?: Db }): void {
  const { db, ...rest } = d;
  overrides = { ...overrides, ...rest, ...(db ? { store: new PgReceiptsStore(db) } : {}) };
}

export function resolveReceiptsDeps(opts?: Partial<ReceiptsDeps>): ReceiptsDeps {
  const store: ReceiptsStore = opts?.store ?? overrides.store ?? defaultStore();
  return {
    store,
    intervalSeconds: opts?.intervalSeconds ?? overrides.intervalSeconds ?? envNum("RECEIPTS_INTERVAL_SECONDS", 60),
    graceSeconds: opts?.graceSeconds ?? overrides.graceSeconds ?? Number(process.env.RECEIPTS_GRACE_SECONDS ?? 10),
    markIntervalSeconds: opts?.markIntervalSeconds ?? overrides.markIntervalSeconds ?? envNum("MARK_INTERVAL_SECONDS", 300),
    now: opts?.now ?? overrides.now ?? (() => Math.floor(Date.now() / 1000)),
    log: opts?.log ?? overrides.log,
  };
}

function defaultStore(): ReceiptsStore {
  lazy ??= createDb(process.env.DATABASE_URL, 4);
  return new PgReceiptsStore(lazy.db);
}

/** Closes the lazily created default DB pool (if any). */
export async function closeReceiptsDefaults(): Promise<void> {
  if (lazy) await lazy.close();
  lazy = null;
}

const n = (v: number | bigint) => Number(v);

/**
 * receiptsRoot of a mark period [periodStart, periodEnd): StandardMerkleTree (PERIOD_LEAF) over the
 * window roots of the period. Closed windows that were not rooted yet are built (and persisted) first.
 */
export function periodReceiptsRoot(bookId: number | bigint, periodStart: number | bigint, periodEnd: number | bigint, opts?: Partial<ReceiptsDeps>): Promise<PeriodReceiptsRoot> {
  return periodRootWith(resolveReceiptsDeps(opts), n(bookId), n(periodStart), n(periodEnd));
}

/** Proof bundle for one receipt row: leaf -> window root -> period root. */
export function receiptProof(receiptId: number | bigint, opts?: Partial<ReceiptsDeps>): Promise<ReceiptProofResult> {
  return receiptProofWith(resolveReceiptsDeps(opts), n(receiptId));
}

/** Persisted window root (null if the window is open or not rooted yet). */
export async function windowRoot(bookId: number | bigint, hourStart: number | bigint, opts?: Partial<ReceiptsDeps>): Promise<StoredRoot | null> {
  const deps = resolveReceiptsDeps(opts);
  const s = n(hourStart);
  const [row] = await deps.store.rootsInRange(n(bookId), s, s + 1);
  return row ?? null;
}

/** Window roots of a book in [from, to). */
export function windowRoots(bookId: number | bigint, from: number | bigint, to: number | bigint, opts?: Partial<ReceiptsDeps>): Promise<StoredRoot[]> {
  return resolveReceiptsDeps(opts).store.rootsInRange(n(bookId), n(from), n(to));
}
