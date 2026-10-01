// Receipts roots: hourly (window) roots persisted to receipt_roots, period roots for marks, and proofs.
// Every function takes injectable deps (store, intervals, clock); omitted deps fall back to the
// process defaults (see defaults.ts) so other services can call e.g. periodReceiptsRoot(bookId, a, b).
import { type BuiltTree, type Logger, payloadHash } from "@bookrunner/shared";
import { type Hex, zeroHash } from "viem";
import type { ReceiptsStore, StoredReceipt, StoredRoot } from "./store";
import {
  type HourlyRoot,
  type ReceiptLeaf,
  type ReceiptProof,
  hourlyLeafProof,
  hourlyTree,
  periodLeafProof,
  periodRootTree,
} from "./trees";
import { closedWindowStarts, isWindowClosed, leafTs, periodOfWindow, windowStartOf, windowsInPeriod } from "./windows";

export interface ReceiptsDeps {
  store: ReceiptsStore;
  /** RECEIPTS_INTERVAL_SECONDS (devnet 60, mainnet 3600). */
  intervalSeconds: number;
  /** A window is only built once end + grace has passed. */
  graceSeconds: number;
  /** MARK_INTERVAL_SECONDS: which period a window belongs to (proofs). */
  markIntervalSeconds: number;
  /** unix seconds */
  now: () => number;
  log?: Logger;
}

/** Max span of receipts fetched per query while building roots. */
const FETCH_SPAN_SECONDS = 6 * 3600;

export function toLeaf(r: StoredReceipt): ReceiptLeaf {
  return { kind: r.kind, bookId: BigInt(r.bookId), ts: BigInt(leafTs(r.ts)), payloadHash: r.payloadHash };
}

export function toHourly(r: StoredRoot): HourlyRoot {
  return { bookId: BigInt(r.bookId), hourStart: BigInt(r.hourStart), root: r.root, leafCount: r.leafCount };
}

/** Pure: groups receipts into windows and computes each window's root. */
export function computeWindowRoots(bookId: number, starts: number[], rows: StoredReceipt[], intervalSeconds: number, log?: Logger): StoredRoot[] {
  const byWindow = new Map<number, StoredReceipt[]>();
  for (const s of starts) byWindow.set(s, []);
  for (const r of rows) {
    const w = windowStartOf(leafTs(r.ts), intervalSeconds);
    byWindow.get(w)?.push(r);
  }
  return starts.map((s) => {
    const inWindow = byWindow.get(s) ?? [];
    for (const r of inWindow) {
      // Integrity check only: leaves use the stored hash the producer committed to.
      const recomputed = payloadHash(r.payload);
      if (recomputed.toLowerCase() !== r.payloadHash.toLowerCase()) {
        log?.warn({ receiptId: r.id, bookId, stored: r.payloadHash, recomputed }, "receipt payload hash differs from stored hash (stored hash is used)");
      }
    }
    const t = hourlyTree(inWindow.map(toLeaf));
    return { bookId, hourStart: s, root: t.root, leafCount: t.count };
  });
}

/** Splits sorted starts into chunks whose fetch span stays within FETCH_SPAN_SECONDS. */
function chunkStarts(starts: number[], intervalSeconds: number): number[][] {
  const per = Math.max(1, Math.floor(FETCH_SPAN_SECONDS / intervalSeconds));
  const out: number[][] = [];
  let cur: number[] = [];
  for (const s of starts) {
    const first = cur[0];
    if (first !== undefined && (s - first) / intervalSeconds >= per) {
      out.push(cur);
      cur = [];
    }
    cur.push(s);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Ensures receipt_roots rows exist for every CLOSED window in `starts` (idempotent per (book, window));
 * returns the persisted rows (another writer may have inserted first — persisted rows win).
 */
export async function ensureWindowRoots(deps: ReceiptsDeps, bookId: number, starts: number[]): Promise<StoredRoot[]> {
  const { store, intervalSeconds: iv } = deps;
  const now = deps.now();
  const closed = [...new Set(starts)].filter((s) => isWindowClosed(s, iv, now, deps.graceSeconds)).sort((a, b) => a - b);
  if (closed.length === 0) return [];
  const lo = closed[0] as number;
  const hi = (closed[closed.length - 1] as number) + iv;
  const existing = await store.rootsInRange(bookId, lo, hi);
  const have = new Set(existing.map((r) => r.hourStart));
  const missing = closed.filter((s) => !have.has(s));
  if (missing.length === 0) return filterStarts(existing, closed);

  let inserted = 0;
  for (const chunk of chunkStarts(missing, iv)) {
    const from = chunk[0] as number;
    const to = (chunk[chunk.length - 1] as number) + iv;
    const rows = await store.receiptsInWindow(bookId, from, to);
    const built = computeWindowRoots(bookId, chunk, rows, iv, deps.log);
    inserted += await store.insertRoots(built);
    const nonEmpty = built.filter((b) => b.leafCount > 0);
    if (nonEmpty.length) deps.log?.debug({ bookId, windows: nonEmpty.map((b) => ({ hourStart: b.hourStart, leafCount: b.leafCount, root: b.root })) }, "receipt roots built");
  }
  if (inserted) deps.log?.info({ bookId, inserted, from: missing[0], to: missing[missing.length - 1] }, "receipt roots persisted");
  return filterStarts(await store.rootsInRange(bookId, lo, hi), closed);
}

function filterStarts(rows: StoredRoot[], starts: number[]): StoredRoot[] {
  const want = new Set(starts);
  return rows.filter((r) => want.has(r.hourStart));
}

export interface PeriodReceiptsRoot {
  bookId: number;
  periodStart: number;
  periodEnd: number;
  /** The mark's receiptsRoot (period tree over window roots). zeroHash if no window is closed yet. */
  root: Hex;
  /** True when every window of the period is closed and persisted. Marks require complete roots. */
  complete: boolean;
  windows: StoredRoot[];
  receiptCount: number;
  tree: BuiltTree;
}

/** Period tree over the window roots of [periodStart, periodEnd) (missing closed windows are built first). */
export async function periodRootWith(deps: ReceiptsDeps, bookId: number, periodStart: number, periodEnd: number): Promise<PeriodReceiptsRoot> {
  const starts = windowsInPeriod(periodStart, periodEnd, deps.intervalSeconds);
  const rows = await ensureWindowRoots(deps, bookId, starts);
  const byStart = new Map(rows.map((r) => [r.hourStart, r]));
  const present = starts.map((s) => byStart.get(s)).filter((r): r is StoredRoot => r !== undefined);
  const tree = periodRootTree(present.map(toHourly));
  return {
    bookId,
    periodStart,
    periodEnd,
    root: present.length ? tree.root : zeroHash,
    complete: starts.length > 0 && present.length === starts.length,
    windows: present,
    receiptCount: present.reduce((n, r) => n + r.leafCount, 0),
    tree,
  };
}

export type ReceiptProofResult =
  | { status: "ok"; proof: ReceiptProof }
  | { status: "not_found" | "window_open" | "not_included" | "root_mismatch"; detail: string };

/** Proof for one receipt: leaf -> window (hourly) root -> period root (mark receiptsRoot). */
export async function receiptProofWith(deps: ReceiptsDeps, receiptId: number): Promise<ReceiptProofResult> {
  const r = await deps.store.getReceipt(receiptId);
  if (!r) return { status: "not_found", detail: `receipt ${receiptId} not found` };
  const iv = deps.intervalSeconds;
  const ws = windowStartOf(leafTs(r.ts), iv);
  if (!isWindowClosed(ws, iv, deps.now(), deps.graceSeconds)) return { status: "window_open", detail: `window ${ws} is still open` };
  const [root] = await ensureWindowRoots(deps, r.bookId, [ws]);
  if (!root) return { status: "window_open", detail: `window ${ws} has no root yet` };

  const rows = await deps.store.receiptsInWindow(r.bookId, ws, ws + iv);
  let included = rows;
  let tree = hourlyTree(included.map(toLeaf));
  if (tree.root !== root.root) {
    // Receipts inserted after the root was built: the root covers the first leafCount rows by id.
    included = rows.slice(0, root.leafCount);
    tree = hourlyTree(included.map(toLeaf));
    if (tree.root !== root.root) return { status: "root_mismatch", detail: `rebuilt window root ${tree.root} != stored ${root.root}` };
  }
  if (!included.some((x) => x.id === r.id)) return { status: "not_included", detail: `receipt ${receiptId} arrived after window ${ws} was rooted` };

  const leaf = toLeaf(r);
  const hourly = toHourly(root);
  const { periodStart, periodEnd } = periodOfWindow(ws, deps.markIntervalSeconds);
  const period = await periodRootWith(deps, r.bookId, periodStart, periodEnd);
  return {
    status: "ok",
    proof: {
      receiptId: r.id,
      leaf: { kind: leaf.kind, bookId: leaf.bookId.toString(), ts: leaf.ts.toString(), payloadHash: leaf.payloadHash },
      payload: r.payload,
      hourly: { hourStart: ws, root: root.root, leafCount: root.leafCount, proof: hourlyLeafProof(tree, leaf) },
      period: { periodStart, periodEnd, root: period.root, proof: periodLeafProof(period.tree, hourly), complete: period.complete },
    },
  };
}

export interface ProcessOptions {
  /** Never auto-build windows older than now - backfillSeconds (they are still built on demand). */
  backfillSeconds: number;
  maxWindowsPerTick: number;
  /** Windows re-checked for receipts that arrived after rooting. */
  lateCheckWindows?: number;
}

export interface ProcessStats {
  books: number;
  windows: number;
  lateReceipts: number;
}

/** Service tick: roots every closed window per book since its last root (bounded backfill). */
export async function processClosedWindows(deps: ReceiptsDeps, opts: ProcessOptions, warned = new Set<string>()): Promise<ProcessStats> {
  const { store, intervalSeconds: iv } = deps;
  const now = deps.now();
  const horizon = windowStartOf(now - opts.backfillSeconds, iv);
  const ids = await store.bookIds(horizon);
  const stats: ProcessStats = { books: ids.length, windows: 0, lateReceipts: 0 };
  for (const bookId of ids) {
    const last = await store.latestRootStart(bookId);
    let from: number;
    if (last !== null) from = last + iv;
    else {
      const first = await store.firstReceiptTs(bookId);
      // no receipts yet: start at the most recent closed window instead of back-filling empty windows
      from = first !== null ? windowStartOf(first, iv) : windowStartOf(now - deps.graceSeconds, iv) - iv;
    }
    from = Math.max(from, horizon);
    const starts = closedWindowStarts(from, now, iv, deps.graceSeconds, opts.maxWindowsPerTick);
    if (starts.length) stats.windows += (await ensureWindowRoots(deps, bookId, starts)).length;
    stats.lateReceipts += await checkLateReceipts(deps, bookId, opts.lateCheckWindows ?? 3, warned);
  }
  return stats;
}

/** Warns (once per window) when receipts landed in a window after its root was persisted. */
async function checkLateReceipts(deps: ReceiptsDeps, bookId: number, windows: number, warned: Set<string>): Promise<number> {
  if (windows <= 0) return 0;
  const iv = deps.intervalSeconds;
  const last = await deps.store.latestRootStart(bookId);
  if (last === null) return 0;
  const roots = await deps.store.rootsInRange(bookId, last - (windows - 1) * iv, last + iv);
  let late = 0;
  for (const r of roots) {
    const key = `${bookId}:${r.hourStart}`;
    if (warned.has(key)) continue;
    const n = await deps.store.countReceiptsInWindow(bookId, r.hourStart, r.hourStart + iv);
    if (n > r.leafCount) {
      warned.add(key);
      late += n - r.leafCount;
      deps.log?.warn({ bookId, hourStart: r.hourStart, rooted: r.leafCount, present: n }, "receipts arrived after their window was rooted; they are not covered by any root (raise RECEIPTS_GRACE_SECONDS)");
    }
  }
  if (warned.size > 10_000) warned.clear();
  return late;
}
