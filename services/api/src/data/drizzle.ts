// Drizzle implementation of the data ports on the shared schema (@bookrunner/db).
import {
  type Db,
  agentKeys,
  books,
  chainCursor,
  charters,
  committee,
  events,
  juryVerdicts,
  killEvents,
  limits,
  marks,
  oraclePrices,
  receiptRoots,
  receipts,
  redemptions,
  settlements,
  webhookDeliveries,
  webhookSubscriptions,
} from "@bookrunner/db";
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type {
  DeliveryUpdate,
  EventRow,
  LimitsBucket,
  LimitsRow,
  NewWebhookSubscription,
  OraclePriceRow,
  Page,
  ReadModel,
  WebhookStore,
  WebhookSubscriptionPatch,
} from "./types";

const lower = (s: string) => s.toLowerCase();

export class DrizzleReadModel implements ReadModel {
  constructor(private readonly db: Db) {}

  async ping() {
    await this.db.execute(sql`select 1`);
    return true;
  }

  listCharters(q: { status?: string; sponsor?: string } & Page) {
    const conds = [
      q.status ? eq(charters.status, q.status) : undefined,
      q.sponsor ? eq(charters.sponsor, lower(q.sponsor)) : undefined,
      q.beforeId !== undefined ? lt(charters.id, q.beforeId) : undefined,
    ].filter((c) => c !== undefined);
    return this.db
      .select()
      .from(charters)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(charters.id))
      .limit(q.limit);
  }

  async getCharter(id: number) {
    const [row] = await this.db.select().from(charters).where(eq(charters.id, id)).limit(1);
    return row ?? null;
  }

  async latestJuryVerdict(charterId: number) {
    const [row] = await this.db
      .select()
      .from(juryVerdicts)
      .where(eq(juryVerdicts.charterId, charterId))
      .orderBy(desc(juryVerdicts.id))
      .limit(1);
    return row ?? null;
  }

  juryVerdictsFor(charterIds: number[]) {
    if (charterIds.length === 0) return Promise.resolve([]);
    return this.db.select().from(juryVerdicts).where(inArray(juryVerdicts.charterId, charterIds)).orderBy(asc(juryVerdicts.id));
  }

  committeeMembers() {
    return this.db.select().from(committee).orderBy(asc(committee.seat), asc(committee.member));
  }

  listBooks() {
    return this.db.select().from(books).orderBy(asc(books.id));
  }

  async getBook(id: number) {
    const [row] = await this.db.select().from(books).where(eq(books.id, id)).limit(1);
    return row ?? null;
  }

  latestMarks(bookIds: number[]) {
    if (bookIds.length === 0) return Promise.resolve([]);
    return this.db
      .selectDistinctOn([marks.bookId])
      .from(marks)
      .where(inArray(marks.bookId, bookIds))
      .orderBy(marks.bookId, desc(marks.periodEnd));
  }

  listMarks(bookId: number, q: Page & { from?: Date; to?: Date }) {
    const conds = [
      eq(marks.bookId, bookId),
      q.beforeId !== undefined ? lt(marks.id, q.beforeId) : undefined,
      q.from ? gte(marks.periodEnd, q.from) : undefined,
      q.to ? lte(marks.periodEnd, q.to) : undefined,
    ].filter((c) => c !== undefined);
    return this.db
      .select()
      .from(marks)
      .where(and(...conds))
      .orderBy(desc(marks.periodEnd))
      .limit(q.limit);
  }

  async getMark(id: number) {
    const [row] = await this.db.select().from(marks).where(eq(marks.id, id)).limit(1);
    return row ?? null;
  }

  async markCovering(bookId: number, t: Date) {
    const [row] = await this.db
      .select()
      .from(marks)
      .where(and(eq(marks.bookId, bookId), gt(marks.periodEnd, t)))
      .orderBy(asc(marks.periodEnd))
      .limit(1);
    return row ?? null;
  }

  async latestLimits(bookIds: number[]): Promise<LimitsRow[]> {
    if (bookIds.length === 0) return [];
    return this.db
      .selectDistinctOn([limits.bookId])
      .from(limits)
      .where(inArray(limits.bookId, bookIds))
      .orderBy(limits.bookId, desc(limits.ts));
  }

  async limitsSeries(bookId: number, from: Date, to: Date, bucketSeconds: number): Promise<LimitsBucket[]> {
    const rows = await this.db.execute<{
      bucket: Date | string;
      inv: number | string;
      skew: number | string;
      hedge: number | string | null;
      dd: number | string;
      state: string;
      breaching: boolean;
      samples: number | string;
    }>(sql`
      select time_bucket(make_interval(secs => ${bucketSeconds}::double precision), ts) as bucket,
             max(inventory_util) as inv,
             max(skew_util) as skew,
             avg(hedge_ratio) as hedge,
             min(drawdown_bps) as dd,
             last(state, ts) as state,
             bool_or(state in ('breach', 'killed')) as breaching,
             count(*)::int as samples
        from limits
       where book_id = ${bookId}
         and ts >= ${from.toISOString()}::timestamptz
         and ts < ${to.toISOString()}::timestamptz
       group by 1
       order by 1 asc`);
    return [...rows].map((r) => ({
      bucket: r.bucket instanceof Date ? r.bucket : new Date(r.bucket),
      inventoryUtilMax: Number(r.inv),
      skewUtilMax: Number(r.skew),
      hedgeRatioAvg: r.hedge == null ? null : Number(r.hedge),
      drawdownMin: Number(r.dd),
      state: r.state,
      breaching: Boolean(r.breaching),
      samples: Number(r.samples),
    }));
  }

  recentKills(bookId: number, limit: number) {
    return this.db.select().from(killEvents).where(eq(killEvents.bookId, bookId)).orderBy(desc(killEvents.ts)).limit(limit);
  }

  listSettlements(bookId: number, q: Page) {
    const conds = [eq(settlements.bookId, bookId), q.beforeId !== undefined ? lt(settlements.id, q.beforeId) : undefined].filter(
      (c) => c !== undefined,
    );
    return this.db
      .select()
      .from(settlements)
      .where(and(...conds))
      .orderBy(desc(settlements.id))
      .limit(q.limit);
  }

  async getReceipt(id: number) {
    const [row] = await this.db.select().from(receipts).where(eq(receipts.id, id)).limit(1);
    return row ?? null;
  }

  receiptsInHour(bookId: number, hourStart: Date) {
    return this.db
      .select()
      .from(receipts)
      .where(and(eq(receipts.bookId, bookId), eq(receipts.hourStart, hourStart)))
      .orderBy(asc(receipts.id));
  }

  async receiptRoot(bookId: number, hourStart: Date) {
    const [row] = await this.db
      .select()
      .from(receiptRoots)
      .where(and(eq(receiptRoots.bookId, bookId), eq(receiptRoots.hourStart, hourStart)))
      .limit(1);
    return row ?? null;
  }

  receiptRootsBetween(bookId: number, from: Date, to: Date) {
    return this.db
      .select()
      .from(receiptRoots)
      .where(and(eq(receiptRoots.bookId, bookId), gte(receiptRoots.hourStart, from), lt(receiptRoots.hourStart, to)))
      .orderBy(asc(receiptRoots.hourStart));
  }

  listAgentKeys(bookId: number) {
    return this.db.select().from(agentKeys).where(eq(agentKeys.bookId, bookId)).orderBy(desc(agentKeys.updatedAt));
  }

  listRedemptions(bookId: number, wallet: string) {
    return this.db
      .select()
      .from(redemptions)
      .where(and(eq(redemptions.bookId, bookId), eq(redemptions.wallet, lower(wallet))))
      .orderBy(desc(redemptions.id))
      .limit(500);
  }

  async committedUsd(bookId: number, tranche: "senior" | "junior", wallet: string, round: number) {
    const rows = await this.db.execute<{ total: string | null }>(sql`
      select coalesce(sum(assets), 0)::text as total
        from subscriptions
       where book_id = ${bookId} and tranche = ${tranche} and lower(wallet) = ${lower(wallet)}
         and kind = 'commit' and round = ${round}`);
    return [...rows][0]?.total ?? "0";
  }

  recentEvents(q: { type?: string; bookId?: number } & Page): Promise<EventRow[]> {
    const conds = [
      q.type ? eq(events.type, q.type) : undefined,
      q.bookId !== undefined ? eq(events.bookId, q.bookId) : undefined,
      q.beforeId !== undefined ? lt(events.id, q.beforeId) : undefined,
    ].filter((c) => c !== undefined);
    return this.db
      .select()
      .from(events)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(events.id))
      .limit(q.limit);
  }

  latestOraclePrices(priceIds?: string[]): Promise<OraclePriceRow[]> {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const conds = [gte(oraclePrices.ts, since), priceIds?.length ? inArray(oraclePrices.priceId, priceIds) : undefined].filter(
      (c) => c !== undefined,
    );
    return this.db
      .selectDistinctOn([oraclePrices.priceId])
      .from(oraclePrices)
      .where(and(...conds))
      .orderBy(oraclePrices.priceId, desc(oraclePrices.ts));
  }
}

export class DrizzleWebhookStore implements WebhookStore {
  constructor(private readonly db: Db) {}

  async createSubscription(s: NewWebhookSubscription) {
    const [row] = await this.db
      .insert(webhookSubscriptions)
      .values({ url: s.url, secret: s.secret, eventTypes: s.eventTypes, bookId: s.bookId, active: true })
      .returning();
    if (!row) throw new Error("webhook subscription insert returned no row");
    return row;
  }

  listSubscriptions() {
    return this.db.select().from(webhookSubscriptions).orderBy(asc(webhookSubscriptions.id));
  }

  async getSubscription(id: number) {
    const [row] = await this.db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)).limit(1);
    return row ?? null;
  }

  async updateSubscription(id: number, patch: WebhookSubscriptionPatch) {
    const set: Partial<typeof webhookSubscriptions.$inferInsert> = {};
    if (patch.url !== undefined) set.url = patch.url;
    if (patch.eventTypes !== undefined) set.eventTypes = patch.eventTypes;
    if (patch.bookId !== undefined) set.bookId = patch.bookId;
    if (patch.active !== undefined) set.active = patch.active;
    if (patch.secret !== undefined) set.secret = patch.secret;
    if (Object.keys(set).length === 0) return this.getSubscription(id);
    const [row] = await this.db.update(webhookSubscriptions).set(set).where(eq(webhookSubscriptions.id, id)).returning();
    return row ?? null;
  }

  async deleteSubscription(id: number) {
    const rows = await this.db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)).returning({ id: webhookSubscriptions.id });
    return rows.length > 0;
  }

  activeSubscriptions() {
    return this.db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.active, true));
  }

  async getEvent(id: number) {
    const [row] = await this.db.select().from(events).where(eq(events.id, id)).limit(1);
    return row ?? null;
  }

  eventsAfter(afterId: number, types: readonly string[], limit: number) {
    return this.db
      .select()
      .from(events)
      .where(and(gt(events.id, afterId), inArray(events.type, [...types])))
      .orderBy(asc(events.id))
      .limit(limit);
  }

  async createDeliveries(eventId: number, subscriptionIds: number[]) {
    if (subscriptionIds.length === 0) return [];
    return this.db
      .insert(webhookDeliveries)
      .values(subscriptionIds.map((subscriptionId) => ({ subscriptionId, eventId, status: "pending", attempts: 0 })))
      .onConflictDoNothing({ target: [webhookDeliveries.subscriptionId, webhookDeliveries.eventId] })
      .returning();
  }

  async getDelivery(subscriptionId: number, eventId: number) {
    const [row] = await this.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.subscriptionId, subscriptionId), eq(webhookDeliveries.eventId, eventId)))
      .limit(1);
    return row ?? null;
  }

  async updateDelivery(subscriptionId: number, eventId: number, u: DeliveryUpdate) {
    await this.db
      .update(webhookDeliveries)
      .set({ status: u.status, attempts: u.attempts, responseCode: u.responseCode, lastError: u.lastError, deliveredAt: u.deliveredAt })
      .where(and(eq(webhookDeliveries.subscriptionId, subscriptionId), eq(webhookDeliveries.eventId, eventId)));
  }

  listDeliveries(subscriptionId: number, limit: number) {
    return this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.subscriptionId, subscriptionId))
      .orderBy(desc(webhookDeliveries.id))
      .limit(limit);
  }

  stalePendingDeliveries(olderThan: Date, limit: number) {
    return this.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.status, "pending"), lt(webhookDeliveries.createdAt, olderThan)))
      .orderBy(asc(webhookDeliveries.id))
      .limit(limit);
  }

  async getCursor(name: string) {
    const [row] = await this.db.select().from(chainCursor).where(eq(chainCursor.name, name)).limit(1);
    return row ? row.blockNumber : null;
  }

  async setCursor(name: string, value: number) {
    await this.db
      .insert(chainCursor)
      .values({ name, blockNumber: value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: chainCursor.name, set: { blockNumber: value, updatedAt: new Date() } });
  }
}
