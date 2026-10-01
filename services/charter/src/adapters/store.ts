// Postgres adapter (drizzle) for the charter service: charters (read), jury_verdicts, receipts,
// events (domain-event protocol) and committee upkeep.
import { type Db, charters, committee, events, juryVerdicts, receipts } from "@bookrunner/db";
import { payloadHash } from "@bookrunner/shared";
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Hex } from "viem";
import { cidFromDigest } from "../domain/cid";
import type { Verdict } from "../domain/verdict";
import type { PendingEvent, ReceiptInput, StoredVerdict } from "../jury/pipeline";

export type CharterRow = typeof charters.$inferSelect;
export type VerdictRow = typeof juryVerdicts.$inferSelect;

export function toStoredVerdict(r: VerdictRow): StoredVerdict {
  return {
    charterId: r.charterId,
    cid: r.cid,
    digest: r.digest as Hex,
    recommendApprove: r.recommendApprove,
    verdict: r.verdict as Verdict,
    postedTx: r.postedTx,
  };
}

export class CharterStore {
  constructor(
    readonly db: Db,
    private readonly receiptsIntervalSec: number,
  ) {}

  async ping(): Promise<boolean> {
    await this.db.execute(sql`select 1`);
    return true;
  }

  async getCharter(id: number): Promise<CharterRow | null> {
    const rows = await this.db.select().from(charters).where(eq(charters.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async listCharters(status: string | undefined, limit: number): Promise<CharterRow[]> {
    const q = this.db.select().from(charters);
    const rows = status ? await q.where(eq(charters.status, status)).orderBy(desc(charters.id)).limit(limit) : await q.orderBy(desc(charters.id)).limit(limit);
    return rows;
  }

  /** Charters the indexer recorded as Filed with no verdict posted yet. */
  async filedWithoutPostedVerdict(): Promise<Array<{ id: number; filedAt: Date }>> {
    return this.db
      .select({ id: charters.id, filedAt: charters.filedAt })
      .from(charters)
      .where(
        and(
          eq(charters.status, "Filed"),
          sql`not exists (select 1 from ${juryVerdicts} v where v.charter_id = ${charters.id} and v.posted_tx is not null)`,
        ),
      )
      .orderBy(charters.id);
  }

  async filedCharters(): Promise<Array<{ id: number; filedAt: Date }>> {
    return this.db.select({ id: charters.id, filedAt: charters.filedAt }).from(charters).where(eq(charters.status, "Filed")).orderBy(charters.id);
  }

  async latestVerdict(charterId: number): Promise<StoredVerdict | null> {
    const rows = await this.db.select().from(juryVerdicts).where(eq(juryVerdicts.charterId, charterId)).orderBy(desc(juryVerdicts.id)).limit(1);
    return rows[0] ? toStoredVerdict(rows[0]) : null;
  }

  async verdictsFor(charterId: number): Promise<VerdictRow[]> {
    return this.db.select().from(juryVerdicts).where(eq(juryVerdicts.charterId, charterId)).orderBy(desc(juryVerdicts.id));
  }

  async verdictByCid(cid: string): Promise<VerdictRow | null> {
    const rows = await this.db.select().from(juryVerdicts).where(eq(juryVerdicts.cid, cid)).orderBy(desc(juryVerdicts.id)).limit(1);
    return rows[0] ?? null;
  }

  async insertVerdict(v: StoredVerdict): Promise<void> {
    await this.db.insert(juryVerdicts).values({
      charterId: v.charterId,
      cid: v.cid,
      digest: v.digest.toLowerCase(),
      recommendApprove: v.recommendApprove,
      verdict: v.verdict,
      postedTx: v.postedTx,
    });
  }

  async markPosted(charterId: number, digest: Hex, txHash: Hex): Promise<void> {
    await this.db
      .update(juryVerdicts)
      .set({ postedTx: txHash.toLowerCase() })
      .where(and(eq(juryVerdicts.charterId, charterId), eq(juryVerdicts.digest, digest.toLowerCase()), isNull(juryVerdicts.postedTx)));
    await this.db.update(charters).set({ juryCid: cidFromDigest(digest), updatedAt: new Date() }).where(eq(charters.id, charterId));
  }

  /** Receipts protocol: DECISION leaf with payload_hash + hour bucket. */
  async insertReceipt(r: ReceiptInput): Promise<void> {
    const sec = Math.floor(r.ts.getTime() / 1000);
    const hourStart = Math.floor(sec / this.receiptsIntervalSec) * this.receiptsIntervalSec;
    await this.db.insert(receipts).values({
      bookId: r.bookId,
      kind: r.kind,
      ts: r.ts,
      payload: r.payload,
      payloadHash: payloadHash(r.payload),
      hourStart: new Date(hourStart * 1000),
    });
  }

  /** Domain-event protocol insert (ON CONFLICT (dedupe_key) DO NOTHING); null when deduped. */
  async insertEvent(e: PendingEvent): Promise<{ id: number; createdAt: Date } | null> {
    const rows = await this.db
      .insert(events)
      .values({ type: e.type, bookId: e.bookId, payload: e.payload, dedupeKey: e.dedupeKey })
      .onConflictDoNothing({ target: events.dedupeKey })
      .returning({ id: events.id, createdAt: events.createdAt });
    return rows[0] ?? null;
  }

  // ------------------------------------------------------------ committee upkeep

  async upsertSeat(member: string, seat: number, bond: bigint | null): Promise<void> {
    const m = member.toLowerCase();
    const set: Partial<typeof committee.$inferInsert> = { seat, updatedAt: new Date() };
    if (bond !== null) set.bond = bond.toString();
    await this.db
      .insert(committee)
      .values({ member: m, seat, bond: (bond ?? 0n).toString() })
      .onConflictDoUpdate({ target: committee.member, set });
    // a seat belongs to exactly one member
    await this.db
      .update(committee)
      .set({ seat: null, updatedAt: new Date() })
      .where(and(eq(committee.seat, seat), sql`${committee.member} <> ${m}`));
  }

  async unseatAllExcept(members: string[]): Promise<void> {
    const keep = members.map((m) => m.toLowerCase());
    const where = keep.length ? and(notInArray(committee.member, keep), sql`${committee.seat} is not null`) : sql`${committee.seat} is not null`;
    await this.db.update(committee).set({ seat: null, updatedAt: new Date() }).where(where);
  }

  async committeeRows(members?: string[]) {
    const q = this.db.select().from(committee);
    return members?.length ? q.where(inArray(committee.member, members.map((m) => m.toLowerCase()))) : q;
  }
}
