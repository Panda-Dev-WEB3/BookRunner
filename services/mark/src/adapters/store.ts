// Postgres adapter for the mark service.
import { type Db, books, marks, quotes, settlements } from "@bookrunner/db";
import { type MarkPnl, dbUsd } from "@bookrunner/shared";
import { PgSettlementStore } from "@bookrunner/waterfall";
import { and, desc, eq, gt, lt, lte, sql } from "drizzle-orm";
import type { Hex } from "viem";
import { parseUsd6 } from "../domain/pnl";
import type { MarkAppliedEvent, MarkRow, MarkStore, StoredMark } from "../ports";

const date = (s: number) => new Date(s * 1000);
const wadToFloat = (w: bigint) => Number(w) / 1e18;

/** marks row values for a committed mark (pure; applied fields filled later). */
export function committedMarkValues(r: MarkRow) {
  return {
    id: r.markId,
    bookId: r.bookId,
    periodEnd: date(r.periodEnd),
    navUsd: dbUsd.toDb(r.input.navUsd),
    seniorNav: dbUsd.toDb(r.preview.seniorNav),
    juniorNav: dbUsd.toDb(r.preview.juniorNav),
    pnlJson: r.pnl,
    receiptsRoot: r.input.receiptsRoot,
    txHash: r.commitTx,
    inventoryRoot: r.input.inventoryRoot,
    pnlJsonHash: r.input.pnlJsonHash,
    deployedValueUsd: dbUsd.toDb(r.input.deployedValueUsd),
    flowNonce: Number(r.input.flowNonce),
    signer: r.signer.toLowerCase(),
    signature: r.signature,
    seniorPrice: wadToFloat(r.preview.seniorPrice),
    juniorPrice: wadToFloat(r.preview.juniorPrice),
    pnlUsd: dbUsd.toDb(r.preview.pnlUsd),
    committedAt: r.committedAt,
  };
}

export class PgMarkStore implements MarkStore {
  private settlementsStore: PgSettlementStore;

  constructor(private readonly db: Db) {
    this.settlementsStore = new PgSettlementStore(db);
  }

  async distribution(bookId: number, period: number) {
    const d = await this.settlementsStore.distributionFor(bookId, period);
    return d ? { senior: d.amounts.senior, junior: d.amounts.junior, txHash: d.txHash } : null;
  }

  async fundingInPeriod(bookId: number, periodStart: number, periodEnd: number): Promise<bigint> {
    const [row] = await this.db
      .select({ total: sql<string | null>`sum(${settlements.grossUsd})` })
      .from(settlements)
      .where(and(eq(settlements.bookId, bookId), eq(settlements.source, "funding"), gt(settlements.ts, date(periodStart)), lte(settlements.ts, date(periodEnd))));
    return dbUsd.fromDb(row?.total ?? null);
  }

  async prevUnrealized(bookId: number, periodEnd: number): Promise<bigint> {
    const [row] = await this.db
      .select({ pnl: marks.pnlJson })
      .from(marks)
      .where(and(eq(marks.bookId, bookId), lt(marks.periodEnd, date(periodEnd))))
      .orderBy(desc(marks.periodEnd))
      .limit(1);
    const pnl = row?.pnl as Partial<MarkPnl> | undefined;
    return parseUsd6(pnl?.pnl?.unrealizedUsd);
  }

  async lastQuoteSkewBps(bookId: number, atOrBefore: number): Promise<number | null> {
    const [row] = await this.db
      .select({ skew: quotes.skewBps })
      .from(quotes)
      .where(and(eq(quotes.bookId, bookId), lte(quotes.ts, date(atOrBefore))))
      .orderBy(desc(quotes.ts))
      .limit(1);
    return row ? row.skew : null;
  }

  async markForPeriod(bookId: number, periodEnd: number): Promise<StoredMark | null> {
    const [row] = await this.db
      .select()
      .from(marks)
      .where(and(eq(marks.bookId, bookId), eq(marks.periodEnd, date(periodEnd))))
      .limit(1);
    if (!row) return null;
    return { markId: row.id, pnl: row.pnlJson as MarkPnl, commitTx: row.txHash, appliedTx: row.appliedTx, receiptsRoot: row.receiptsRoot };
  }

  /** Off-chain fields are authoritative here (the indexer may have inserted the row from logs first). */
  async saveCommitted(r: MarkRow): Promise<void> {
    const v = committedMarkValues(r);
    const { id: _id, ...update } = v;
    await this.db.insert(marks).values(v).onConflictDoUpdate({ target: marks.id, set: update });
  }

  async saveApplied(markId: number, appliedTx: Hex, ev: MarkAppliedEvent): Promise<void> {
    await this.db
      .update(marks)
      .set({
        appliedTx,
        seniorNav: dbUsd.toDb(ev.seniorNav),
        juniorNav: dbUsd.toDb(ev.juniorNav),
        seniorPrice: wadToFloat(ev.seniorPrice),
        juniorPrice: wadToFloat(ev.juniorPrice),
        pnlUsd: dbUsd.toDb(ev.pnlUsd),
      })
      .where(eq(marks.id, markId));
  }

  async updateBookNav(bookId: number, markId: number, ev: MarkAppliedEvent): Promise<void> {
    await this.db
      .update(books)
      .set({ navUsd: dbUsd.toDb(ev.navUsd), seniorNav: dbUsd.toDb(ev.seniorNav), juniorNav: dbUsd.toDb(ev.juniorNav), lastMarkId: markId, updatedAt: new Date() })
      .where(eq(books.id, bookId));
  }
}
