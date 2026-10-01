// Persistence: quotes / fills / hedges rows + receipt leaves (Postgres + Timescale via drizzle).

import { type Db, fills, hedges, quotes, receipts } from "@bookrunner/db";
import { dbUsd } from "@bookrunner/shared";
import { eq, max } from "drizzle-orm";
import type { ReceiptRow } from "../domain/receipts";

export interface QuoteRow {
  bookId: number;
  ts: Date;
  bid: number | null;
  ask: number | null;
  size: number;
  inventoryUsd: number;
  skewBps: number;
  mid: number | null;
  oracle: number | null;
  widthBps: number | null;
}

export interface FillRow {
  bookId: number;
  ts: Date;
  side: "buy" | "sell";
  qty: number;
  px: number;
  feeUsd: number;
  venueTradeId: string;
  maker: boolean;
  trader: string | null;
}

export interface HedgeRow {
  bookId: number;
  ts: Date;
  asset: string;
  qtyRaw: bigint; // signed: + buy, - sell
  px: number; // USD per whole token (price per share * multiplier)
  mult: number;
  txHash: string;
  venue: string;
  valueUsd: bigint;
}

export interface AgentStore {
  insertQuote(row: QuoteRow, receipt: ReceiptRow | null): Promise<void>;
  /** Returns the venue trade ids actually inserted (duplicates ignored). */
  insertFills(rows: FillRow[], receiptsFor: (inserted: FillRow[]) => ReceiptRow[]): Promise<string[]>;
  insertHedge(row: HedgeRow, receipt: ReceiptRow): Promise<void>;
  lastFillTs(bookId: number): Promise<number | null>;
}

const receiptValues = (r: ReceiptRow) => ({
  bookId: r.bookId,
  kind: r.kind,
  ts: r.ts,
  payload: r.payload,
  payloadHash: r.payloadHash,
  hourStart: r.hourStart,
});

export class DbStore implements AgentStore {
  constructor(private readonly db: Db) {}

  async insertQuote(row: QuoteRow, receipt: ReceiptRow | null): Promise<void> {
    await this.db.insert(quotes).values(row);
    if (receipt) await this.db.insert(receipts).values(receiptValues(receipt));
  }

  async insertFills(rows: FillRow[], receiptsFor: (inserted: FillRow[]) => ReceiptRow[]): Promise<string[]> {
    if (rows.length === 0) return [];
    return this.db.transaction(async (tx) => {
      const ins = await tx.insert(fills).values(rows).onConflictDoNothing().returning({ id: fills.venueTradeId });
      const ids = new Set(ins.map((r) => r.id));
      const inserted = rows.filter((r) => ids.has(r.venueTradeId));
      const recs = receiptsFor(inserted);
      if (recs.length) await tx.insert(receipts).values(recs.map(receiptValues));
      return [...ids];
    });
  }

  async insertHedge(row: HedgeRow, receipt: ReceiptRow): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(hedges).values({
        bookId: row.bookId,
        ts: row.ts,
        asset: row.asset,
        qtyRaw: row.qtyRaw.toString(),
        px: row.px,
        mult: row.mult,
        txHash: row.txHash,
        venue: row.venue,
        valueUsd: dbUsd.toDb(row.valueUsd),
      });
      await tx.insert(receipts).values(receiptValues(receipt));
    });
  }

  async lastFillTs(bookId: number): Promise<number | null> {
    const r = await this.db.select({ ts: max(fills.ts) }).from(fills).where(eq(fills.bookId, bookId));
    const ts = r[0]?.ts;
    return ts ? new Date(ts).getTime() : null;
  }
}
