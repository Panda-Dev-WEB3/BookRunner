// Postgres implementation of IndexerStore (drizzle + postgres-js). Writes are idempotent:
// ON CONFLICT on natural keys, guarded transitions, jsonb-append-if-absent.
import { type Db, agentKeys, books, chainCursor, charters, committee, events, juryVerdicts, killEvents, marks, redemptions, schema, settlements, subscriptions } from "@bookrunner/db";
import { type BookComponents, type CharterStatus, dbUsd } from "@bookrunner/shared";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { Address } from "viem";
import type {
  AgentKeyRow,
  BookPatch,
  BookRow,
  CharterFiledRow,
  IndexerStore,
  KillRow,
  MarkAppliedPatch,
  MarkRow,
  PendingEvent,
  RedemptionRow,
  SettlementRow,
  SubscriptionRow,
  VoteEntry,
} from "./store";

type Exec = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;
const WAD = 10n ** 18n;
const lc = (s: string) => s.toLowerCase();

export class PgIndexerStore implements IndexerStore {
  private constructor(
    private readonly db: Exec,
    private readonly root: Db,
    private readonly inTx: boolean,
  ) {}

  static create(db: Db): PgIndexerStore {
    return new PgIndexerStore(db as unknown as Exec, db, false);
  }

  transaction<T>(fn: (s: IndexerStore) => Promise<T>): Promise<T> {
    if (this.inTx) return this.savepoint(fn);
    return this.root.transaction((tx) => fn(new PgIndexerStore(tx as unknown as Exec, this.root, true)));
  }

  savepoint<T>(fn: (s: IndexerStore) => Promise<T>): Promise<T> {
    if (!this.inTx) return this.transaction(fn);
    return this.db.transaction((sp) => fn(new PgIndexerStore(sp as unknown as Exec, this.root, true)));
  }

  // ------------------------------------------------------------ cursors / lookups

  async getCursor(name: string): Promise<number | null> {
    const r = await this.db.select({ b: chainCursor.blockNumber }).from(chainCursor).where(eq(chainCursor.name, name)).limit(1);
    return r[0]?.b ?? null;
  }

  async setCursor(name: string, block: number): Promise<void> {
    await this.db
      .insert(chainCursor)
      .values({ name, blockNumber: block })
      .onConflictDoUpdate({ target: chainCursor.name, set: { blockNumber: block, updatedAt: new Date() } });
  }

  async loadBooks(): Promise<Array<{ bookId: number; components: BookComponents }>> {
    const rows = await this.db.select().from(books);
    return rows.map((b) => ({
      bookId: b.id,
      components: {
        book: b.bookAddr as Address,
        senior: b.seniorAddr as Address,
        junior: b.juniorAddr as Address,
        vault: b.vaultAddr as Address,
        mandate: b.mandateAddr as Address,
        router: b.routerAddr as Address,
        desk: b.deskAddr as Address,
        adapter: b.adapterAddr as Address,
      },
    }));
  }

  async getCharterStruct(id: number): Promise<Record<string, unknown> | null> {
    const r = await this.db.select({ s: charters.structJson }).from(charters).where(eq(charters.id, id)).limit(1);
    return (r[0]?.s as Record<string, unknown> | undefined) ?? null;
  }

  async getBookState(id: number): Promise<string | null> {
    const r = await this.db.select({ s: books.state }).from(books).where(eq(books.id, id)).limit(1);
    return r[0]?.s ?? null;
  }

  // ------------------------------------------------------------ charters

  async upsertCharterFiled(r: CharterFiledRow): Promise<void> {
    const values = {
      id: r.id,
      sponsor: lc(r.sponsor),
      structJson: r.structJson,
      status: "Filed",
      underlying: lc(r.underlying),
      symbol: r.symbol,
      venue: r.venue,
      feeUsd: r.feeUsd,
      bondBkrn: r.bondBkrn,
      filedAt: r.filedAt,
      bondTx: lc(r.bondTx),
    };
    const { id: _id, status: _status, ...update } = values;
    await this.db
      .insert(charters)
      .values(values)
      .onConflictDoUpdate({ target: charters.id, set: { ...update, updatedAt: new Date() } });
  }

  async setCharterStatus(
    id: number,
    status: CharterStatus,
    p: { decidedAt?: Date; juryCid?: string; bookAddr?: string; from?: CharterStatus[] },
  ): Promise<boolean> {
    const set: Partial<typeof charters.$inferInsert> = { status, updatedAt: new Date() };
    if (p.decidedAt) set.decidedAt = p.decidedAt;
    if (p.juryCid) set.juryCid = p.juryCid;
    if (p.bookAddr) set.bookAddr = lc(p.bookAddr);
    const where = p.from?.length ? and(eq(charters.id, id), inArray(charters.status, p.from)) : eq(charters.id, id);
    const r = await this.db.update(charters).set(set).where(where).returning({ id: charters.id });
    return r.length > 0;
  }

  async setCharterJuryCid(id: number, cid: string): Promise<void> {
    await this.db.update(charters).set({ juryCid: cid, updatedAt: new Date() }).where(eq(charters.id, id));
  }

  async setCharterBook(id: number, bookAddr: string): Promise<void> {
    await this.db.update(charters).set({ bookAddr: lc(bookAddr), updatedAt: new Date() }).where(eq(charters.id, id));
  }

  async appendCharterSlash(id: number, entry: { sponsor: string; amount: string; reason: string; tx: string; logIndex: number; ts: string }): Promise<boolean> {
    const probe = JSON.stringify([{ tx: entry.tx, logIndex: entry.logIndex }]);
    const r = await this.db.execute(sql`
      update charters
         set meta = jsonb_set(coalesce(meta, '{}'::jsonb), '{slashes}', coalesce(meta->'slashes', '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb),
             updated_at = now()
       where id = ${id}
         and not (coalesce(meta->'slashes', '[]'::jsonb) @> ${probe}::jsonb)
      returning id`);
    return r.length > 0;
  }

  // ------------------------------------------------------------ jury / committee

  async recordVerdictPosted(p: { charterId: number; digest: string; cid: string; recommendApprove: boolean; txHash: string }): Promise<"updated" | "inserted" | "unchanged"> {
    const digest = lc(p.digest);
    const tx = lc(p.txHash);
    const upd = await this.db
      .update(juryVerdicts)
      .set({ postedTx: tx })
      .where(and(eq(juryVerdicts.charterId, p.charterId), sql`lower(${juryVerdicts.digest}) = ${digest}`, sql`(${juryVerdicts.postedTx} is null or ${juryVerdicts.postedTx} = ${tx})`))
      .returning({ id: juryVerdicts.id });
    if (upd.length) return "updated";
    const existing = await this.db
      .select({ id: juryVerdicts.id })
      .from(juryVerdicts)
      .where(and(eq(juryVerdicts.charterId, p.charterId), sql`lower(${juryVerdicts.digest}) = ${digest}`))
      .limit(1);
    if (existing.length) return "unchanged";
    await this.db.insert(juryVerdicts).values({
      charterId: p.charterId,
      cid: p.cid,
      digest,
      recommendApprove: p.recommendApprove,
      verdict: { placeholder: true, source: "indexer", note: "verdict posted on-chain; content not held by this deployment" },
      postedTx: tx,
    });
    return "inserted";
  }

  async setCommitteeSeat(member: string, seat: number): Promise<void> {
    const m = lc(member);
    await this.db
      .insert(committee)
      .values({ member: m, seat })
      .onConflictDoUpdate({ target: committee.member, set: { seat, updatedAt: new Date() } });
    await this.db
      .update(committee)
      .set({ seat: null, updatedAt: new Date() })
      .where(and(eq(committee.seat, seat), sql`${committee.member} <> ${m}`));
  }

  async clearCommitteeSeat(seat: number): Promise<void> {
    await this.db.update(committee).set({ seat: null, updatedAt: new Date() }).where(eq(committee.seat, seat));
  }

  async setCommitteeBond(member: string, bond: bigint): Promise<void> {
    await this.db
      .insert(committee)
      .values({ member: lc(member), bond: bond.toString() })
      .onConflictDoUpdate({ target: committee.member, set: { bond: bond.toString(), updatedAt: new Date() } });
  }

  async reduceCommitteeBond(member: string, amount: bigint): Promise<void> {
    await this.db
      .update(committee)
      .set({ bond: sql`greatest(${committee.bond} - ${amount.toString()}::numeric, 0)`, updatedAt: new Date() })
      .where(eq(committee.member, lc(member)));
  }

  async appendCommitteeVote(member: string, vote: VoteEntry): Promise<boolean> {
    const m = lc(member);
    const entry = JSON.stringify([vote]);
    const probe = JSON.stringify([{ tx: vote.tx, logIndex: vote.logIndex }]);
    const r = await this.db.execute(sql`
      insert into committee (member, votes_json) values (${m}, ${entry}::jsonb)
      on conflict (member) do update
         set votes_json = committee.votes_json || excluded.votes_json, updated_at = now()
       where not (committee.votes_json @> ${probe}::jsonb)
      returning member`);
    return r.length > 0;
  }

  // ------------------------------------------------------------ books

  async upsertBook(r: BookRow): Promise<void> {
    const values = {
      id: r.id,
      charterId: r.charterId,
      bookAddr: lc(r.bookAddr),
      seniorAddr: lc(r.seniorAddr),
      juniorAddr: lc(r.juniorAddr),
      vaultAddr: lc(r.vaultAddr),
      mandateAddr: lc(r.mandateAddr),
      routerAddr: lc(r.routerAddr),
      deskAddr: lc(r.deskAddr),
      adapterAddr: lc(r.adapterAddr),
      venue: r.venue,
      symbol: r.symbol,
      underlying: lc(r.underlying),
      name: r.name,
      createdAt: r.createdAt,
      subscriptionEnds: r.subscriptionEnds,
    };
    const { id: _id, name, ...update } = values;
    await this.db
      .insert(books)
      .values(values)
      .onConflictDoUpdate({ target: books.id, set: { ...update, name: sql`coalesce(${name}, ${books.name})`, updatedAt: new Date() } });
  }

  async updateBook(id: number, patch: BookPatch): Promise<void> {
    const set: Partial<typeof books.$inferInsert> = { updatedAt: new Date() };
    if (patch.state !== undefined) set.state = patch.state;
    if (patch.seniorNav !== undefined) set.seniorNav = patch.seniorNav;
    if (patch.juniorNav !== undefined) set.juniorNav = patch.juniorNav;
    if (patch.navUsd !== undefined) set.navUsd = patch.navUsd;
    if (patch.lastMarkId !== undefined) {
      set.lastMarkId = patch.lastMarkId;
      await this.db
        .update(books)
        .set(set)
        .where(and(eq(books.id, id), sql`(${books.lastMarkId} is null or ${books.lastMarkId} <= ${patch.lastMarkId})`));
      return;
    }
    await this.db.update(books).set(set).where(eq(books.id, id));
  }

  // ------------------------------------------------------------ tranches

  async insertSubscription(r: SubscriptionRow): Promise<boolean> {
    const out = await this.db
      .insert(subscriptions)
      .values({ ...r, wallet: lc(r.wallet), txHash: lc(r.txHash) })
      .onConflictDoNothing({ target: [subscriptions.txHash, subscriptions.logIndex] })
      .returning({ id: subscriptions.id });
    return out.length > 0;
  }

  async insertRedemption(r: RedemptionRow): Promise<boolean> {
    const out = await this.db
      .insert(redemptions)
      .values({ ...r, wallet: lc(r.wallet), requestTx: lc(r.requestTx) })
      .onConflictDoNothing({ target: [redemptions.requestTx, redemptions.logIndex] })
      .returning({ id: redemptions.id });
    return out.length > 0;
  }

  async settleRedemptions(p: { bookId: number; tranche: "senior" | "junior"; requestId: string; priceWad: bigint; markId: number | null }): Promise<number> {
    const rows = await this.db
      .select({ id: redemptions.id, shares: redemptions.shares })
      .from(redemptions)
      .where(and(eq(redemptions.bookId, p.bookId), eq(redemptions.tranche, p.tranche), eq(redemptions.requestId, p.requestId), isNull(redemptions.assets)));
    for (const r of rows) {
      const assets = (dbUsd.fromDb(r.shares) * p.priceWad) / WAD;
      await this.db
        .update(redemptions)
        .set({ assets: dbUsd.toDb(assets), honouredMarkId: p.markId })
        .where(and(eq(redemptions.id, r.id), isNull(redemptions.assets)));
    }
    return rows.length;
  }

  async claimRedemptions(p: { bookId: number; tranche: "senior" | "junior"; wallet: string; at: Date }): Promise<number> {
    const r = await this.db
      .update(redemptions)
      .set({ claimedAt: p.at })
      .where(
        and(
          eq(redemptions.bookId, p.bookId),
          eq(redemptions.tranche, p.tranche),
          eq(redemptions.wallet, lc(p.wallet)),
          isNotNull(redemptions.assets),
          isNull(redemptions.claimedAt),
        ),
      )
      .returning({ id: redemptions.id });
    return r.length;
  }

  // ------------------------------------------------------------ settlements / keys / kills / marks

  async insertSettlement(r: SettlementRow): Promise<boolean> {
    const out = await this.db
      .insert(settlements)
      .values({ ...r, txHash: lc(r.txHash) })
      .onConflictDoNothing({ target: [settlements.txHash, settlements.logIndex] })
      .returning({ id: settlements.id });
    return out.length > 0;
  }

  async upsertAgentKey(r: AgentKeyRow): Promise<void> {
    const values = {
      bookId: r.bookId,
      key: lc(r.key),
      operator: lc(r.operator),
      validUntil: r.validUntil,
      inventoryTierUsd: r.inventoryTierUsd,
      status: "active",
      registeredTx: lc(r.registeredTx),
      revokedTx: null,
      revokedReason: null,
    };
    const { bookId: _b, key: _k, ...update } = values;
    await this.db
      .insert(agentKeys)
      .values(values)
      .onConflictDoUpdate({ target: [agentKeys.bookId, agentKeys.key], set: { ...update, updatedAt: new Date() } });
  }

  async revokeAgentKey(p: { bookId: number; key: string; operator: string; revokedTx: string; reason: string }): Promise<void> {
    await this.db
      .insert(agentKeys)
      .values({ bookId: p.bookId, key: lc(p.key), operator: lc(p.operator), status: "revoked", revokedTx: lc(p.revokedTx), revokedReason: p.reason })
      .onConflictDoUpdate({
        target: [agentKeys.bookId, agentKeys.key],
        set: { status: "revoked", revokedTx: lc(p.revokedTx), revokedReason: p.reason, updatedAt: new Date() },
      });
  }

  async insertKillIfAbsent(r: KillRow): Promise<boolean> {
    const tx = lc(r.txHash);
    const out = await this.db.execute(sql`
      insert into ${killEvents} (book_id, ts, reason, breaches, actions, tx_hashes)
      select ${r.bookId}, ${r.ts.toISOString()}::timestamptz, ${r.reason}, ${JSON.stringify(r.breaches)}::jsonb, ${JSON.stringify(r.actions)}::jsonb, ${JSON.stringify([tx])}::jsonb
       where not exists (select 1 from ${killEvents} k where k.book_id = ${r.bookId} and k.tx_hashes @> ${JSON.stringify([tx])}::jsonb)
      returning id`);
    return out.length > 0;
  }

  async insertMarkIfAbsent(r: MarkRow): Promise<boolean> {
    const out = await this.db
      .insert(marks)
      .values({
        id: r.id,
        bookId: r.bookId,
        periodEnd: r.periodEnd,
        navUsd: r.navUsd,
        pnlJson: { pending: true, source: "indexer" },
        receiptsRoot: lc(r.receiptsRoot),
        txHash: lc(r.txHash),
        inventoryRoot: lc(r.inventoryRoot),
        pnlJsonHash: lc(r.pnlJsonHash),
        deployedValueUsd: r.deployedValueUsd,
        flowNonce: r.flowNonce,
        signer: lc(r.signer),
        signature: r.signature,
        committedAt: r.committedAt,
      })
      .onConflictDoNothing()
      .returning({ id: marks.id });
    return out.length > 0;
  }

  async setMarkApplied(markId: number, txHash: string, patch?: MarkAppliedPatch): Promise<void> {
    await this.db
      .update(marks)
      .set({ appliedTx: lc(txHash), ...(patch ?? {}) })
      .where(eq(marks.id, markId));
  }

  async insertEvent(e: PendingEvent): Promise<{ id: number; createdAt: Date } | null> {
    const rows = await this.db
      .insert(events)
      .values({ type: e.type, bookId: e.bookId, payload: e.payload, dedupeKey: e.dedupeKey })
      .onConflictDoNothing({ target: events.dedupeKey })
      .returning({ id: events.id, createdAt: events.createdAt });
    return rows[0] ?? null;
  }
}
