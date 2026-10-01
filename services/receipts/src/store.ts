// Storage port for receipts + receipt_roots (Postgres adapter in store-pg.ts, in-memory below for tests
// and for other services' unit tests).
import type { Hex } from "viem";

export interface StoredReceipt {
  id: number;
  bookId: number;
  kind: number;
  ts: Date;
  payload: unknown;
  payloadHash: Hex;
  hourStart: Date;
}

export interface StoredRoot {
  bookId: number;
  hourStart: number; // unix seconds (window start)
  root: Hex;
  leafCount: number;
}

export interface ReceiptsStore {
  /** Receipts with startSec <= ts < endSec, ordered by id. */
  receiptsInWindow(bookId: number, startSec: number, endSec: number): Promise<StoredReceipt[]>;
  countReceiptsInWindow(bookId: number, startSec: number, endSec: number): Promise<number>;
  /** Roots with fromSec <= hourStart < toSec, ordered by hourStart. */
  rootsInRange(bookId: number, fromSec: number, toSec: number): Promise<StoredRoot[]>;
  /** Idempotent per (bookId, hourStart): existing rows are kept. Returns the number inserted. */
  insertRoots(rows: StoredRoot[]): Promise<number>;
  latestRootStart(bookId: number): Promise<number | null>;
  firstReceiptTs(bookId: number): Promise<number | null>;
  getReceipt(id: number): Promise<StoredReceipt | null>;
  /** Books to process: not Cancelled/Retired in `books`, plus any book with receipts since `sinceSec`. */
  bookIds(sinceSec: number): Promise<number[]>;
}

export class MemoryReceiptsStore implements ReceiptsStore {
  receipts: StoredReceipt[] = [];
  roots = new Map<string, StoredRoot>();
  books = new Map<number, string>(); // bookId -> state
  private nextId = 1;

  addReceipt(r: Omit<StoredReceipt, "id"> & { id?: number }): StoredReceipt {
    const row = { ...r, id: r.id ?? this.nextId++ };
    this.nextId = Math.max(this.nextId, row.id + 1);
    this.receipts.push(row);
    return row;
  }

  async receiptsInWindow(bookId: number, startSec: number, endSec: number) {
    return this.receipts
      .filter((r) => r.bookId === bookId && r.ts.getTime() >= startSec * 1000 && r.ts.getTime() < endSec * 1000)
      .sort((a, b) => a.id - b.id);
  }

  async countReceiptsInWindow(bookId: number, startSec: number, endSec: number) {
    return (await this.receiptsInWindow(bookId, startSec, endSec)).length;
  }

  async rootsInRange(bookId: number, fromSec: number, toSec: number) {
    return [...this.roots.values()]
      .filter((r) => r.bookId === bookId && r.hourStart >= fromSec && r.hourStart < toSec)
      .sort((a, b) => a.hourStart - b.hourStart);
  }

  async insertRoots(rows: StoredRoot[]) {
    let n = 0;
    for (const r of rows) {
      const k = `${r.bookId}:${r.hourStart}`;
      if (this.roots.has(k)) continue;
      this.roots.set(k, { ...r });
      n++;
    }
    return n;
  }

  async latestRootStart(bookId: number) {
    let max: number | null = null;
    for (const r of this.roots.values()) if (r.bookId === bookId && (max === null || r.hourStart > max)) max = r.hourStart;
    return max;
  }

  async firstReceiptTs(bookId: number) {
    let min: number | null = null;
    for (const r of this.receipts) {
      if (r.bookId !== bookId) continue;
      const t = Math.floor(r.ts.getTime() / 1000);
      if (min === null || t < min) min = t;
    }
    return min;
  }

  async getReceipt(id: number) {
    return this.receipts.find((r) => r.id === id) ?? null;
  }

  async bookIds(sinceSec: number) {
    const ids = new Set<number>();
    for (const [id, state] of this.books) if (state !== "Cancelled" && state !== "Retired") ids.add(id);
    for (const r of this.receipts) if (r.ts.getTime() >= sinceSec * 1000) ids.add(r.bookId);
    return [...ids].sort((a, b) => a - b);
  }
}
