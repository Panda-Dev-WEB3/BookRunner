// Postgres (Drizzle) adapter for the receipts store.
import { type Db, books, receiptRoots, receipts } from "@bookrunner/db";
import { and, asc, count, eq, gte, lt, max, min, notInArray } from "drizzle-orm";
import type { Hex } from "viem";
import type { ReceiptsStore, StoredReceipt, StoredRoot } from "./store";

const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const date = (s: number) => new Date(s * 1000);
const INSERT_BATCH = 500;

export class PgReceiptsStore implements ReceiptsStore {
  constructor(private readonly db: Db) {}

  async receiptsInWindow(bookId: number, startSec: number, endSec: number): Promise<StoredReceipt[]> {
    const rows = await this.db
      .select()
      .from(receipts)
      .where(and(eq(receipts.bookId, bookId), gte(receipts.ts, date(startSec)), lt(receipts.ts, date(endSec))))
      .orderBy(asc(receipts.id));
    return rows.map(toReceipt);
  }

  async countReceiptsInWindow(bookId: number, startSec: number, endSec: number): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(receipts)
      .where(and(eq(receipts.bookId, bookId), gte(receipts.ts, date(startSec)), lt(receipts.ts, date(endSec))));
    return Number(row?.n ?? 0);
  }

  async rootsInRange(bookId: number, fromSec: number, toSec: number): Promise<StoredRoot[]> {
    const rows = await this.db
      .select()
      .from(receiptRoots)
      .where(and(eq(receiptRoots.bookId, bookId), gte(receiptRoots.hourStart, date(fromSec)), lt(receiptRoots.hourStart, date(toSec))))
      .orderBy(asc(receiptRoots.hourStart));
    return rows.map((r) => ({ bookId: r.bookId, hourStart: sec(r.hourStart), root: r.root as Hex, leafCount: r.leafCount }));
  }

  async insertRoots(rows: StoredRoot[]): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const chunk = rows.slice(i, i + INSERT_BATCH);
      const res = await this.db
        .insert(receiptRoots)
        .values(chunk.map((r) => ({ bookId: r.bookId, hourStart: date(r.hourStart), root: r.root, leafCount: r.leafCount })))
        .onConflictDoNothing({ target: [receiptRoots.bookId, receiptRoots.hourStart] })
        .returning({ id: receiptRoots.id });
      inserted += res.length;
    }
    return inserted;
  }

  async latestRootStart(bookId: number): Promise<number | null> {
    const [row] = await this.db.select({ m: max(receiptRoots.hourStart) }).from(receiptRoots).where(eq(receiptRoots.bookId, bookId));
    return row?.m ? sec(row.m) : null;
  }

  async firstReceiptTs(bookId: number): Promise<number | null> {
    const [row] = await this.db.select({ m: min(receipts.ts) }).from(receipts).where(eq(receipts.bookId, bookId));
    return row?.m ? sec(row.m) : null;
  }

  async getReceipt(id: number): Promise<StoredReceipt | null> {
    const [row] = await this.db.select().from(receipts).where(eq(receipts.id, id)).limit(1);
    return row ? toReceipt(row) : null;
  }

  async bookIds(sinceSec: number): Promise<number[]> {
    const active = await this.db.select({ id: books.id }).from(books).where(notInArray(books.state, ["Cancelled", "Retired"]));
    const recent = await this.db.selectDistinct({ id: receipts.bookId }).from(receipts).where(gte(receipts.ts, date(sinceSec)));
    return [...new Set([...active.map((r) => r.id), ...recent.map((r) => r.id)])].sort((a, b) => a - b);
  }
}

function toReceipt(r: typeof receipts.$inferSelect): StoredReceipt {
  return {
    id: r.id,
    bookId: r.bookId,
    kind: r.kind,
    ts: r.ts,
    payload: r.payload,
    payloadHash: r.payloadHash as Hex,
    hourStart: r.hourStart,
  };
}
