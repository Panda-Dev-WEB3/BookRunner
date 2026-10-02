// Integration tests against real Postgres + Redis. Run with BKRN_IT=1 and DATABASE_URL pointing at a
// private, migrated database (e.g. bkrn_oracle_it) and REDIS_URL at a private db index.
import { afterAll, describe, expect, test } from "bun:test";
import { books, charters, createDb, oraclePrices } from "@bookrunner/db";
import { CHANNELS, KEYS, type OraclePriceMsg, priceId } from "@bookrunner/shared";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { DrizzlePriceStore } from "../src/adapters/db";
import { RedisPricePublisher } from "../src/adapters/redis";
import { silentLog } from "./fakes";

const IT = process.env.BKRN_IT === "1";
const suite = IT ? describe : describe.skip;

suite("integration: postgres + redis adapters", () => {
  const tag = `IT${Date.now().toString(36).toUpperCase()}`;
  const database = IT ? createDb(process.env.DATABASE_URL, 2) : null;
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:63790/5";
  const redis = IT ? new Redis(redisUrl, { maxRetriesPerRequest: 1 }) : null;
  const sub = IT ? new Redis(redisUrl, { maxRetriesPerRequest: 1 }) : null;
  const bookId = 900_000_000 + Math.floor(Math.random() * 1_000_000);

  const msg: OraclePriceMsg = {
    priceId: tag,
    underlying: priceId(tag),
    priceWad: "190120000000000000000",
    price: 190.12,
    publishedAt: 1_790_000_000,
    held: false,
    sourceCount: 3,
    sources: [{ name: "synthetic-a", price: 190.12, ts: 1_790_000_000_000 }],
    sourcesHash: `0x${"11".repeat(32)}`,
    signature: `0x${"22".repeat(65)}`,
  };

  afterAll(async () => {
    if (!database || !redis || !sub) return;
    await database.db.delete(oraclePrices).where(eq(oraclePrices.priceId, tag));
    await database.db.delete(charters).where(eq(charters.id, bookId));
    await database.db.delete(books).where(eq(books.id, bookId));
    await redis.del(KEYS.oracleLast(tag));
    await database.close();
    redis.disconnect();
    sub.disconnect();
  });

  test("oracle_prices insert round-trips (hypertable, jsonb sources, pushed_tx)", async () => {
    const store = new DrizzlePriceStore(database!.db);
    await store.insertPrices([
      { msg, pushedTx: `0x${"ab".repeat(32)}` },
      { msg: { ...msg, publishedAt: msg.publishedAt + 5, held: true }, pushedTx: null },
    ]);
    const rows = await database!.db.select().from(oraclePrices).where(eq(oraclePrices.priceId, tag));
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => !r.held)!;
    expect(first.price).toBe(190.12);
    expect(first.ts.getTime()).toBe(1_790_000_000_000);
    expect(first.sources).toEqual(msg.sources);
    expect(first.pushedTx).toBe(`0x${"ab".repeat(32)}`);
    expect(rows.find((r) => r.held)!.pushedTx).toBeNull();
  });

  test("charter sessions and books are read for discovery", async () => {
    const store = new DrizzlePriceStore(database!.db);
    const sessions = `0x${"0".repeat(63)}1` as const;
    await database!.db.insert(charters).values({
      id: bookId,
      sponsor: "0x0000000000000000000000000000000000000007",
      structJson: { sessions, venue: 0 },
      status: "Approved",
      underlying: priceId("NVDA"),
      symbol: "PERP_NVDA_USDC",
      venue: 0,
      filedAt: new Date(),
    });
    expect(await store.charterSessions(bookId)).toBe(sessions);
    expect(await store.charterSessions(bookId + 1)).toBeNull();
    const z = "0x0000000000000000000000000000000000000000";
    await database!.db.insert(books).values({
      id: bookId,
      charterId: bookId,
      seniorAddr: z,
      juniorAddr: z,
      vaultAddr: z,
      venue: 0,
      symbol: "PERP_NVDA_USDC",
      createdAt: new Date(),
      bookAddr: z,
      mandateAddr: z,
      routerAddr: z,
      deskAddr: z,
      adapterAddr: z,
      underlying: priceId("NVDA"),
    });
    const all = await store.books();
    expect(all.find((b) => b.bookId === bookId)).toMatchObject({ symbol: "PERP_NVDA_USDC", venue: 0 });
  });

  test("redis: last-price key + pub/sub channel", async () => {
    const pub = new RedisPricePublisher(redis!);
    const got = new Promise<string>((resolve) => {
      sub!.on("message", (_ch, m) => resolve(m));
    });
    await sub!.subscribe(CHANNELS.oraclePrice(tag));
    await pub.publish([msg]);
    expect(JSON.parse(await got)).toEqual(msg);
    expect(await pub.loadLast(tag)).toEqual(msg);
    expect(await pub.loadLast(`${tag}-missing`)).toBeNull();
    // pull bundle: set with an expiry so a stopped oracle leaves no stale bundle behind
    const bundle = { priceData: "0x" as const, publishedAt: msg.publishedAt, chainId: 31337, oracle: "0x00000000000000000000000000000000000000aa" as const, priceIds: [tag] };
    await pub.publish([], { msg: bundle, ttlMs: 30_000 });
    expect(JSON.parse((await redis!.get(KEYS.oracleBundle))!)).toEqual(bundle);
    const ttl = await redis!.pttl(KEYS.oracleBundle);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);
    await redis!.del(KEYS.oracleBundle);
    silentLog.info("redis ok");
  });
});
