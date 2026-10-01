// Drizzle adapter for the tables the risk service writes (limits, events, receipts, kill_events,
// hedges) and reads (books, kill_events, venue_accounts).
import { type Db, books, events, hedges, killEvents, limits, receipts, venueAccounts } from "@bookrunner/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbBookRow, EventRow, HedgeRow, KillEventRow, LimitsRow, ReceiptRow, StorePort } from "../ports";

export class DrizzleStore implements StorePort {
  constructor(private readonly db: Db) {}

  async insertLimits(r: LimitsRow): Promise<void> {
    await this.db.insert(limits).values({
      bookId: r.bookId,
      ts: r.ts,
      inventoryUtil: r.inventoryUtil,
      skewUtil: r.skewUtil,
      hedgeRatio: r.hedgeRatio,
      drawdownBps: r.drawdownBps,
      state: r.state,
      offHours: r.offHours,
      breaches: r.breaches,
      netExposureUsd: r.netExposureUsd,
      liveNavUsd: r.liveNavUsd,
    });
  }

  async insertEvent(e: EventRow): Promise<{ id: number; createdAt: Date; inserted: boolean }> {
    const inserted = await this.db
      .insert(events)
      .values({ type: e.type, bookId: e.bookId, payload: e.payload, dedupeKey: e.dedupeKey })
      .onConflictDoNothing({ target: events.dedupeKey })
      .returning({ id: events.id, createdAt: events.createdAt });
    const row = inserted[0];
    if (row) return { ...row, inserted: true };
    const existing = await this.db
      .select({ id: events.id, createdAt: events.createdAt })
      .from(events)
      .where(eq(events.dedupeKey, e.dedupeKey))
      .limit(1);
    const ex = existing[0];
    if (!ex) throw new Error(`event ${e.dedupeKey} neither inserted nor found`);
    return { ...ex, inserted: false };
  }

  async insertReceipt(r: ReceiptRow): Promise<void> {
    await this.db.insert(receipts).values({
      bookId: r.bookId,
      kind: r.kind,
      ts: r.ts,
      payload: r.payload,
      payloadHash: r.payloadHash,
      hourStart: r.hourStart,
    });
  }

  async insertKillEvent(r: KillEventRow): Promise<void> {
    await this.db.insert(killEvents).values({
      bookId: r.bookId,
      ts: r.ts,
      reason: r.reason,
      breaches: r.breaches,
      actions: r.actions,
      txHashes: r.txHashes,
    });
  }

  async killEvents(bookId: number): Promise<Array<{ reason: string; txHashes: string[] }>> {
    const rows = await this.db
      .select({ reason: killEvents.reason, txHashes: killEvents.txHashes })
      .from(killEvents)
      .where(eq(killEvents.bookId, bookId))
      .orderBy(desc(killEvents.ts))
      .limit(100);
    return rows.map((r) => ({ reason: r.reason, txHashes: Array.isArray(r.txHashes) ? r.txHashes.map(String) : [] }));
  }

  async insertHedge(r: HedgeRow): Promise<void> {
    await this.db.insert(hedges).values({
      bookId: r.bookId,
      ts: r.ts,
      asset: r.asset,
      qtyRaw: r.qtyRaw,
      px: r.px,
      mult: r.mult,
      txHash: r.txHash,
      venue: r.venue,
      valueUsd: r.valueUsd,
    });
  }

  async liveBooks(): Promise<DbBookRow[]> {
    return this.db
      .select({
        id: books.id,
        venue: books.venue,
        symbol: books.symbol,
        underlying: books.underlying,
        state: books.state,
        bookAddr: books.bookAddr,
        seniorAddr: books.seniorAddr,
        juniorAddr: books.juniorAddr,
        vaultAddr: books.vaultAddr,
        mandateAddr: books.mandateAddr,
        routerAddr: books.routerAddr,
        deskAddr: books.deskAddr,
        adapterAddr: books.adapterAddr,
      })
      .from(books)
      .where(inArray(books.state, ["Live", "Retiring"]));
  }

  /** Active MM venue account id from venue_accounts (fallback when the adapter read fails). */
  async venueAccountId(bookId: number, kind = "mm"): Promise<string | null> {
    const rows = await this.db
      .select({ accountId: venueAccounts.accountId })
      .from(venueAccounts)
      .where(and(eq(venueAccounts.bookId, bookId), eq(venueAccounts.kind, kind), eq(venueAccounts.status, "active")))
      .limit(1);
    return rows[0]?.accountId ?? null;
  }
}
