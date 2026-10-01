// Integration tests against a private database (bkrn_api_it) + the shared Redis with an isolated
// BullMQ prefix. Run with: BKRN_IT=1 bun test test/integration.test.ts
// Setup once: docker exec bookrunner-postgres-1 psql -U bookrunner -c "CREATE DATABASE bkrn_api_it"
//             DATABASE_URL=postgres://bookrunner:bookrunner@127.0.0.1:54400/bkrn_api_it bun run --cwd packages/db migrate
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  agentKeys,
  books,
  charters,
  committee,
  createDb,
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
  subscriptions,
  webhookDeliveries,
  webhookSubscriptions,
  chainCursor,
} from "@bookrunner/db";
import { CHANNELS, payloadHash } from "@bookrunner/shared";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { createApp } from "../src/app";
import type { ApiDeps } from "../src/deps";
import { DrizzleReadModel, DrizzleWebhookStore } from "../src/data/drizzle";
import { MemoryKv } from "../src/kv";
import { createCaller } from "../src/router";
import { WebhookDispatcher } from "../src/webhooks/dispatcher";
import { createWebhookQueue, createWebhookWorker } from "../src/webhooks/queue";
import { verifyWebhookSignature } from "../src/webhooks/signature";
import { silentLog } from "./fakes";
import { ALICE, BOOK, SPONSOR, sampleCharter } from "./fixtures";
import { charterToJson } from "../src/domain/charter";

const IT = process.env.BKRN_IT === "1";
const DB_URL = process.env.API_IT_DATABASE_URL ?? "postgres://bookrunner:bookrunner@127.0.0.1:54400/bkrn_api_it";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:63790";

describe.skipIf(!IT)("integration (bkrn_api_it)", () => {
  if (!IT) return;
  const { db, close } = createDb(DB_URL, 4);
  const data = new DrizzleReadModel(db);
  const store = new DrizzleWebhookStore(db);
  const now = Date.now();
  const t = (sec: number) => new Date(Math.floor(now / 300_000) * 300_000 + sec * 1000);
  let deps: ApiDeps;

  beforeAll(async () => {
    // private database: clear every table we seed
    for (const tbl of [webhookDeliveries, webhookSubscriptions, events, receipts, receiptRoots, settlements, limits, marks, books, charters, juryVerdicts, committee, agentKeys, redemptions, subscriptions, killEvents, oraclePrices, chainCursor]) {
      await db.delete(tbl);
    }
    const c = sampleCharter();
    await db.insert(charters).values([
      { id: 1, sponsor: SPONSOR.toLowerCase(), structJson: charterToJson(c), status: "Approved", underlying: c.underlying, symbol: "PERP_NVDA_USDC", venue: 0, filedAt: t(-86_400), meta: { name: "NVDA" } },
      { id: 2, sponsor: SPONSOR.toLowerCase(), structJson: charterToJson(c), status: "Filed", underlying: c.underlying, symbol: "PERP_TSLA_USDC", venue: 0, filedAt: t(-600) },
    ]);
    await db.insert(juryVerdicts).values({ charterId: 2, cid: "bafkrei2", digest: "0x02", recommendApprove: true, verdict: { summary: "ok" } });
    await db.insert(committee).values({ member: "0x00000000000000000000000000000000000000a8", bond: "1", votesJson: [{ charterId: 2, approve: true, tx: "0xv" }], seat: 0 });
    await db.insert(books).values({
      id: 1, charterId: 1, seniorAddr: BOOK.senior.toLowerCase(), juniorAddr: BOOK.junior.toLowerCase(), vaultAddr: BOOK.vault.toLowerCase(), venue: 0, symbol: "PERP_NVDA_USDC",
      createdAt: t(-7200), bookAddr: BOOK.book.toLowerCase(), mandateAddr: BOOK.mandate.toLowerCase(), routerAddr: BOOK.router.toLowerCase(), deskAddr: BOOK.desk.toLowerCase(),
      adapterAddr: BOOK.adapter.toLowerCase(), underlying: c.underlying, name: "NVDA", state: "Live", navUsd: "100300.000000", seniorNav: "70100", juniorNav: "30200",
    });
    for (let i = 1; i <= 3; i++) {
      await db.insert(marks).values({
        id: i, bookId: 1, periodEnd: t(-300 * (4 - i)), navUsd: `${100000 + i}`, seniorNav: "70000", juniorNav: "30000", pnlJson: {}, receiptsRoot: "0x00", txHash: `0x${i}`,
        inventoryRoot: "0x00", pnlJsonHash: "0x00", deployedValueUsd: "100000", flowNonce: 1, signer: "0x51", signature: "0x", seniorPrice: 1 + i / 1000, juniorPrice: 1 + i / 100, committedAt: t(-300 * (4 - i) + 30),
      });
    }
    await db.insert(limits).values([
      { bookId: 1, ts: t(-200), inventoryUtil: 0.3, skewUtil: 0.1, hedgeRatio: 8000, drawdownBps: -5, state: "ok" },
      { bookId: 1, ts: t(-100), inventoryUtil: 0.9, skewUtil: 0.4, hedgeRatio: 6000, drawdownBps: -15, state: "warn" },
      { bookId: 1, ts: t(-40), inventoryUtil: 1.1, skewUtil: 0.5, hedgeRatio: null, drawdownBps: -30, state: "breach", breaches: ["INVENTORY"] },
    ]);
    await db.insert(settlements).values({ bookId: 1, ts: t(-300), source: "distribution", grossUsd: "100", txHash: "0xd", logIndex: 0, period: 1 });
    await db.insert(subscriptions).values([
      { bookId: 1, tranche: "senior", wallet: ALICE.toLowerCase(), shares: "0", ts: t(-500), kind: "commit", assets: "1000.5", round: 0, txHash: "0xs1", logIndex: 0 },
      { bookId: 1, tranche: "senior", wallet: ALICE.toLowerCase(), shares: "0", ts: t(-400), kind: "commit", assets: "99.5", round: 0, txHash: "0xs2", logIndex: 0 },
      { bookId: 1, tranche: "senior", wallet: ALICE.toLowerCase(), shares: "0", ts: t(-300), kind: "refund", assets: "50", round: 0, txHash: "0xs3", logIndex: 0 },
    ]);
    const payload = { bid: 1, ask: 2 };
    await db.insert(receipts).values({ bookId: 1, kind: 0, ts: t(-590), payload, payloadHash: payloadHash(payload), hourStart: t(-600) });
    await db.insert(oraclePrices).values([
      { priceId: "NVDA", ts: new Date(now - 20_000), price: 190, held: false, sourceCount: 3, sources: [], sourcesHash: "0x", signature: "0x" },
      { priceId: "NVDA", ts: new Date(now - 10_000), price: 191, held: false, sourceCount: 3, sources: [], sourcesHash: "0x", signature: "0x" },
    ]);
    deps = {
      settings: { chainId: 31337, markIntervalSeconds: 300, receiptsIntervalSeconds: 60, maxPriceAgeSeconds: 300 },
      log: silentLog,
      data,
      webhooks: store,
      kv: new MemoryKv(),
      chain: () => null,
      charterService: null,
      now: () => now,
    };
  });

  afterAll(async () => {
    await close();
  });

  test("read model queries (DISTINCT ON, time_bucket + last(), sums)", async () => {
    expect(await data.ping()).toBe(true);
    expect((await data.latestMarks([1])).map((m) => m.id)).toEqual([3]);
    expect((await data.listMarks(1, { limit: 2 })).map((m) => m.id)).toEqual([3, 2]);
    expect((await data.listMarks(1, { limit: 5, beforeId: 2 })).map((m) => m.id)).toEqual([1]);
    expect((await data.markCovering(1, t(-650)))?.id).toBe(2);
    expect((await data.latestLimits([1]))[0]?.state).toBe("breach");
    const series = await data.limitsSeries(1, t(-3600), t(60), 3600);
    expect(series.length).toBeGreaterThanOrEqual(1);
    const total = series.reduce((a, s) => a + s.samples, 0);
    expect(total).toBe(3);
    expect(series.some((s) => s.breaching)).toBe(true);
    expect(series.at(-1)?.state).toBe("breach");
    expect(await data.committedUsd(1, "senior", ALICE, 0)).toBe("1100.000000");
    expect((await data.latestOraclePrices()).map((p) => p.price)).toEqual([191]);
    expect((await data.listCharters({ status: "Filed", limit: 10 })).map((c) => c.id)).toEqual([2]);
    expect((await data.juryVerdictsFor([1, 2])).map((v) => v.charterId)).toEqual([2]);
  });

  test("procedures over Drizzle", async () => {
    const k = createCaller({ deps });
    const [b] = await k.book.list();
    expect(b).toMatchObject({ bookId: 1, navUsd: "100300.000000", seniorSharePrice: "1.003", limits: { state: "breach" } });
    const l = await k.book.limits({ bookId: 1, bucketSeconds: 60 });
    expect(l.series.reduce((a, s) => a + s.samples, 0)).toBe(3);
    const g = await k.charter.get({ charterId: 2 });
    expect(g.tally).toMatchObject({ approvals: 1, source: "db" });
    expect(g.jury?.cid).toBe("bafkrei2");
    const r = await k.receipts.root({ bookId: 1, hourStart: t(-600).getTime() });
    expect(r).toMatchObject({ computed: true, leafCount: 1 });
    expect((await k.settlements.list({ bookId: 1 })).items[0]?.grossUsd).toBe("100.000000");
  });

  test("webhook store: CRUD, idempotent deliveries, cursor upsert", async () => {
    const s = await store.createSubscription({ url: "http://127.0.0.1:1/x", secret: "whsec_it", eventTypes: ["mark.committed"], bookId: 1 });
    expect((await store.updateSubscription(s.id, { active: false }))?.active).toBe(false);
    await store.updateSubscription(s.id, { active: true });
    const [ev] = await db.insert(events).values({ type: "mark.committed", bookId: 1, payload: { bookId: 1 }, dedupeKey: `it-${now}` }).returning();
    expect((await store.createDeliveries(ev!.id, [s.id])).length).toBe(1);
    expect((await store.createDeliveries(ev!.id, [s.id])).length).toBe(0);
    await store.setCursor("it:cursor", 5);
    await store.setCursor("it:cursor", 9);
    expect(await store.getCursor("it:cursor")).toBe(9);
    expect((await store.eventsAfter(0, ["mark.committed"], 10)).map((e) => e.id)).toContain(ev!.id);
    expect(await store.deleteSubscription(s.id)).toBe(true);
    expect(await store.getSubscription(s.id)).toBeNull();
  });

  test("end to end: domain event -> pub/sub -> BullMQ -> signed POST with retries", async () => {
    const received: Array<{ body: string; sig: string | null }> = [];
    let calls = 0;
    const receiver = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        calls++;
        received.push({ body: await req.text(), sig: req.headers.get("x-bookrunner-signature") });
        return new Response(null, { status: calls <= 2 ? 500 : 200 });
      },
    });
    const prefix = `bkrn-api-it-${process.pid}-${now}`;
    const conn = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    const wconn = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    const sub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    const pub = new Redis(REDIS_URL);
    const { queue, enqueue } = createWebhookQueue(conn, 50, prefix);
    const worker = createWebhookWorker(wconn, { store, fetch, now: Date.now, timeoutMs: 2000, log: silentLog }, 2, silentLog, prefix);
    const dispatcher = new WebhookDispatcher({ store, enqueue, log: silentLog, now: Date.now, sweepIntervalMs: 60_000 });
    try {
      const app = createApp(deps, { origins: [] });
      const created = await app.request("/v1/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `http://127.0.0.1:${receiver.port}/hook`, eventTypes: ["kill.executed"], bookId: 1 }),
      });
      const { subscription, secret } = (await created.json()) as { subscription: { id: number }; secret: string };
      await dispatcher.start(sub);
      await new Promise((r) => setTimeout(r, 200));
      // producer protocol: insert into events, then publish {id, type, createdAt, data}
      const [ev] = await db
        .insert(events)
        .values({ type: "kill.executed", bookId: 1, payload: { bookId: 1, reason: "INVENTORY", actions: [], txHashes: [] }, dedupeKey: `it-kill-${now}` })
        .returning();
      await pub.publish(CHANNELS.domainEvents, JSON.stringify({ id: ev!.id, type: ev!.type, createdAt: ev!.createdAt.toISOString(), data: ev!.payload }));
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const d = await store.getDelivery(subscription.id, ev!.id);
        if (d?.status === "delivered") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const d = await store.getDelivery(subscription.id, ev!.id);
      expect(d).toMatchObject({ status: "delivered", attempts: 3, responseCode: 200 });
      expect(received).toHaveLength(3);
      const last = received[2]!;
      expect(JSON.parse(last.body)).toMatchObject({ id: ev!.id, type: "kill.executed", data: { reason: "INVENTORY" } });
      expect(verifyWebhookSignature(secret, last.body, last.sig).ok).toBe(true);
    } finally {
      await dispatcher.stop();
      await worker.close();
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close();
      receiver.stop(true);
      for (const r of [conn, wconn, sub, pub]) await r.quit().catch(() => {});
    }
  }, 20_000);
});
