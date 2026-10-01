// Integration (BKRN_IT=1, DATABASE_URL -> a migrated scratch database).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, events, receipts, redemptions, settlements } from "@bookrunner/db";
import { CHANNELS, RECEIPT_KIND, createLogger, usd } from "@bookrunner/shared";
import { eq } from "drizzle-orm";
import { DbRedeemCandidates, PgRedisEventSink, PgSettlementStore, distributionDedupeKey, distributionPaidPayload, insertReceipt } from "../src/index";
import { bookRef } from "./fakes";

const IT = process.env.BKRN_IT === "1";
const BOOK = 9201;
const P = 1_790_000_100;

describe.skipIf(!IT)("waterfall stores (postgres)", () => {
  const { db, close } = createDb(process.env.DATABASE_URL, 2);
  const log = createLogger("it", "silent");

  beforeAll(async () => {
    await db.delete(settlements).where(eq(settlements.bookId, BOOK));
    await db.delete(events).where(eq(events.bookId, BOOK));
    await db.delete(redemptions).where(eq(redemptions.bookId, BOOK));
    await db.delete(receipts).where(eq(receipts.bookId, BOOK));
  });
  afterAll(() => close());

  test("distribution row: insert, lookup by (book, period), conflict-safe on (tx, logIndex)", async () => {
    const store = new PgSettlementStore(db);
    expect(await store.distributionFor(BOOK, P)).toBeNull();
    const d = {
      bookId: BOOK,
      period: P,
      amounts: { gross: usd("1000"), expenses: usd("1"), carry: usd("99.9"), senior: usd("539.46"), junior: usd("359.64") },
      txHash: `0x${"ab".repeat(32)}` as const,
      logIndex: 2,
      blockNumber: 5n,
      ts: new Date(P * 1000 + 3000),
    };
    await store.insertDistribution(d);
    await store.insertDistribution(d);
    const got = await store.distributionFor(BOOK, P);
    expect(got?.amounts).toEqual(d.amounts);
    await store.insertReceived(BOOK, P, [{ source: 1, amount: usd("50"), txHash: `0x${"cd".repeat(32)}`, logIndex: 0, blockNumber: 4n, ts: new Date(P * 1000) }]);
    const rows = await db.select().from(settlements).where(eq(settlements.bookId, BOOK));
    expect(rows.map((r) => r.source).sort()).toEqual(["distribution", "engine_fees"]);
  });

  test("domain events: persisted once per dedupe key, published on the domain channel", async () => {
    const published: Array<[string, string]> = [];
    const sink = new PgRedisEventSink(db, { publish: async (c, m) => published.push([c, m]) }, log);
    const payload = distributionPaidPayload(BOOK, P, { gross: 1n, expenses: 0n, carry: 0n, senior: 1n, junior: 0n }, "0x01");
    const a = await sink.publish("distribution.paid", BOOK, payload, distributionDedupeKey(BOOK, P));
    const b = await sink.publish("distribution.paid", BOOK, payload, distributionDedupeKey(BOOK, P));
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(published).toHaveLength(1);
    expect(published[0]?.[0]).toBe(CHANNELS.domainEvents);
    const msg = JSON.parse(published[0]![1]);
    expect(msg).toMatchObject({ id: a.id, type: "distribution.paid", data: { bookId: BOOK, period: P, grossUsd: "0.000001" } });
  });

  test("redemption candidates from the indexer table + DECISION receipt", async () => {
    const wallet = "0x00000000000000000000000000000000000000f1";
    await db.insert(redemptions).values([
      { bookId: BOOK, tranche: "junior", wallet, shares: "10", noticeAt: new Date(), requestId: "100", eligibleAt: new Date(), requestTx: "0x1", logIndex: 0 },
      { bookId: BOOK, tranche: "senior", wallet, shares: "5", noticeAt: new Date(), requestId: "98", eligibleAt: new Date(), requestTx: "0x1", logIndex: 1 },
      { bookId: BOOK, tranche: "senior", wallet, shares: "5", noticeAt: new Date(), requestId: "101", eligibleAt: new Date(), requestTx: "0x1", logIndex: 2 },
    ]);
    const c = await new DbRedeemCandidates(db).candidates(bookRef(BOOK), 98n, 100n);
    expect(c.map((x) => [x.kind, x.requestId])).toEqual([[1, 100n]]);
    const id = await insertReceipt(db, { bookId: BOOK, kind: RECEIPT_KIND.DECISION, ts: new Date(P * 1000 + 61_000), payload: { type: "keeper.recall" } }, 60);
    const [row] = await db.select().from(receipts).where(eq(receipts.id, id!));
    expect(row?.hourStart.getTime()).toBe((P + 60) * 1000);
  });
});
