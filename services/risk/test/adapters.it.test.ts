// Integration tests against real Postgres + Redis (guarded: BKRN_IT=1).
//   DATABASE_URL must point at a private, migrated database (e.g. bkrn_risk_it);
//   RISK_IT_REDIS_URL defaults to Redis logical db 15 so no shared keys are touched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, events, killEvents, limits, receipts } from "@bookrunner/db";
import { CHANNELS, KEYS, QUEUES, RECEIPT_KIND, VENUE } from "@bookrunner/shared";
import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { DrizzleStore } from "../src/adapters/db";
import { BullVenueOpsQueue } from "../src/adapters/queue";
import { RedisBus } from "../src/adapters/redis";
import { receiptRow } from "../src/domain/records";
import { BookMonitor } from "../src/monitor";
import type { RiskStatePayload } from "../src/types";
import { chainObs, makeRef, makeWorld, settings, silentLog } from "./fakes";

const IT = process.env.BKRN_IT === "1";
const DB_URL = process.env.DATABASE_URL ?? "";
const REDIS_URL = process.env.RISK_IT_REDIS_URL ?? "redis://127.0.0.1:63790/15";
const BOOK = 990_000 + Math.floor(Math.random() * 9_000);

describe.skipIf(!IT)("risk adapters (integration)", () => {
  if (IT && !/bkrn_.*_it/.test(DB_URL)) throw new Error("integration tests need DATABASE_URL pointing at a private bkrn_*_it database");
  const handle = IT ? createDb(DB_URL, 2) : null;
  const store = handle ? new DrizzleStore(handle.db) : null;
  let redis: Redis;
  let sub: Redis;
  let queueConn: Redis;
  let bus: RedisBus;
  let queue: BullVenueOpsQueue;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
    sub = new Redis(REDIS_URL);
    queueConn = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    bus = new RedisBus(redis, 2000);
    queue = new BullVenueOpsQueue(queueConn, 5000, () => {});
  });

  afterAll(async () => {
    const q = new Queue(QUEUES.venueOps, { connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }) });
    await q.obliterate({ force: true }).catch(() => {});
    await q.close();
    await redis.del(KEYS.riskState(BOOK), KEYS.liveNav(BOOK), KEYS.agentQuote(BOOK));
    await queue.close();
    await Promise.all([redis.quit(), sub.quit(), queueConn.quit()]);
    await handle?.close();
  });

  test("events: ON CONFLICT (dedupe_key) DO NOTHING returns the existing row", async () => {
    if (!store) return;
    const key = `it:${BOOK}:${Date.now()}`;
    const a = await store.insertEvent({ type: "limit.breached", bookId: BOOK, payload: { x: 1 }, dedupeKey: key });
    const b = await store.insertEvent({ type: "limit.breached", bookId: BOOK, payload: { x: 2 }, dedupeKey: key });
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.id).toBe(a.id);
  });

  test("limits, receipts, kill_events, hedges round-trip", async () => {
    if (!store || !handle) return;
    const ts = new Date();
    await store.insertLimits({
      bookId: BOOK,
      ts,
      inventoryUtil: 0.4,
      skewUtil: 0.1,
      hedgeRatio: null,
      drawdownBps: -12,
      state: "ok",
      offHours: false,
      breaches: [],
      netExposureUsd: -20000,
      liveNavUsd: 100000,
    });
    await store.insertReceipt(receiptRow(BOOK, RECEIPT_KIND.DECISION, Math.floor(Date.now() / 1000), { type: "kill" }, 60));
    await store.insertKillEvent({ bookId: BOOK, ts, reason: "INVENTORY", breaches: ["INVENTORY"], actions: ["mandate_kill"], txHashes: ["0xabc"] });
    await store.insertHedge({ bookId: BOOK, ts, asset: "0xa1", qtyRaw: "-1000", px: 190, mult: 1, txHash: "0xdef", venue: "UNIV3", valueUsd: "19000" });
    expect(await store.killEvents(BOOK)).toEqual([{ reason: "INVENTORY", txHashes: ["0xabc"] }]);
    const lim = await handle.db.select().from(limits).where(eq(limits.bookId, BOOK));
    expect(lim[0]).toMatchObject({ state: "ok", hedgeRatio: null, offHours: false });
    expect(await store.liveBooks()).toBeArray();
    expect(await store.venueAccountId(BOOK)).toBeNull();
  });

  test("redis: risk state SET + PUBLISH, quote parse, kill broadcast", async () => {
    const got: Array<{ ch: string; msg: string }> = [];
    await sub.subscribe(CHANNELS.riskState(BOOK), CHANNELS.kill(BOOK));
    sub.on("message", (ch, msg) => got.push({ ch, msg }));
    const payload = { state: "ok", breaches: [], meta: { bookId: BOOK } } as unknown as RiskStatePayload;
    await bus.saveRiskState(BOOK, payload);
    await bus.publishKill(BOOK, { bookId: BOOK, ts: 1, reason: "INVENTORY", breaches: ["INVENTORY"] });
    await redis.set(KEYS.agentQuote(BOOK), JSON.stringify({ bookId: BOOK, ts: 5, bid: 1, ask: 2, oracle: 1.5, sides: { bid: true, ask: true } }));
    expect(await bus.loadRiskState(BOOK)).toMatchObject({ state: "ok", meta: { bookId: BOOK } });
    expect(await bus.latestQuote(BOOK)).toMatchObject({ ts: 5, bid: 1, ask: 2 });
    await Bun.sleep(150);
    expect(got.map((g) => g.ch)).toEqual([CHANNELS.riskState(BOOK), CHANNELS.kill(BOOK)]);
    await sub.unsubscribe();
  });

  test("venue-ops queue: duplicate jobId is enqueued once", async () => {
    await queue.enqueueVenueOp({ kind: "revoke_key", bookId: BOOK }, `revoke_key-${BOOK}-x`);
    await queue.enqueueVenueOp({ kind: "revoke_key", bookId: BOOK }, `revoke_key-${BOOK}-x`);
    const q = new Queue(QUEUES.venueOps, { connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }) });
    const job = await q.getJob(`revoke_key-${BOOK}-x`);
    expect(job?.name).toBe("revoke_key");
    expect(job?.data).toEqual({ kind: "revoke_key", bookId: BOOK });
    expect((await q.getJobs(["waiting", "delayed", "prioritized"])).filter((j) => j.data.bookId === BOOK)).toHaveLength(1);
    await q.close();
  });

  test("monitor end-to-end on real DB + Redis: breach -> limit.breached -> kill -> rows", async () => {
    if (!store || !handle) return;
    const w = makeWorld({ obs: chainObs({ adapter: { ...chainObs().adapter, netExposureUsd: 60_000_000_000n, deployedValueUsd: 100_000_000_000n }, desk: { hedgeNotionalUsd: 0n, valueUsd: 0n } }) });
    const ref = { ...makeRef(BOOK, VENUE.ORDERLY), bookId: BOOK };
    await redis.del(KEYS.riskState(BOOK));
    const m = new BookMonitor(ref, {
      chain: w.chain,
      store,
      bus,
      queue,
      venues: { forBook: async () => null },
      clock: { nowMs: () => Date.now() },
      settings: settings({ breachConfirmTicks: 1 }),
      log: silentLog,
    });
    const r = await m.tick();
    expect(r.killComplete).toBe(true);
    const evs = (await handle.db.select().from(events).where(eq(events.bookId, BOOK))).filter((e) => !e.dedupeKey?.startsWith("it:"));
    expect(evs.map((e) => e.type).sort()).toEqual(["kill.executed", "limit.breached"]);
    expect(evs.find((e) => e.type === "kill.executed")?.dedupeKey).toBe(`kill.executed:${BOOK}:${w.chain.state.killLogs[0]?.txHash.toLowerCase()}`);
    const kills = await handle.db.select().from(killEvents).where(eq(killEvents.bookId, BOOK));
    expect(kills.some((k) => k.reason === "INVENTORY")).toBe(true);
    const rc = await handle.db.select().from(receipts).where(eq(receipts.bookId, BOOK));
    expect(rc.filter((x) => x.kind === RECEIPT_KIND.DECISION).length).toBeGreaterThanOrEqual(2);
    const persisted = await bus.loadRiskState(BOOK);
    expect(persisted?.meta.monitor.handledKill).toBe(w.chain.state.killLogs[0]?.txHash.toLowerCase() ?? null);
  });
});
