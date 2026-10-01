// Integration test (BKRN_IT=1): DbStore against a migrated private database and RedisBus against
// Redis. Example:
//   BKRN_IT=1 DATABASE_URL=postgres://bookrunner:bookrunner@127.0.0.1:54400/bkrn_agent_it bun test test/store.it.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { createDb, fills, hedges, quotes, receipts } from "@bookrunner/db";
import { CHANNELS, KEYS, RECEIPT_KIND, payloadHash, usd } from "@bookrunner/shared";
import { eq } from "drizzle-orm";
import { RedisBus } from "../src/adapters/bus";
import { DbStore } from "../src/adapters/store";
import { fillReceipt, hedgeReceipt, quoteReceipt } from "../src/domain/receipts";
import { silentLog } from "./helpers";

const IT = process.env.BKRN_IT === "1";
const BOOK = 990_000 + Math.floor(Math.random() * 9_999); // never a real book id

describe.skipIf(!IT)("DbStore (integration)", () => {
  const h = createDb(process.env.DATABASE_URL, 2);
  const store = new DbStore(h.db);
  afterAll(async () => {
    for (const t of [quotes, fills, hedges, receipts]) await h.db.delete(t).where(eq(t.bookId, BOOK));
    await h.close();
  });

  test("quotes + quote receipts", async () => {
    const msg = { bookId: BOOK, ts: Date.now(), bid: 189.9, ask: 190.1, size: 2, mid: 190, oracle: 190, inventoryUsd: 0, skewBps: 0, widthBps: 10.5, sides: { bid: true, ask: true } };
    await store.insertQuote({ bookId: BOOK, ts: new Date(msg.ts), bid: 189.9, ask: 190.1, size: 2, inventoryUsd: 0, skewBps: 0, mid: 190, oracle: 190, widthBps: 10.5 }, quoteReceipt(msg, 60));
    await store.insertQuote({ bookId: BOOK, ts: new Date(msg.ts + 1), bid: null, ask: null, size: 0, inventoryUsd: 0, skewBps: 0, mid: null, oracle: 190, widthBps: null }, null);
    const rows = await h.db.select().from(quotes).where(eq(quotes.bookId, BOOK));
    expect(rows.length).toBe(2);
    const rec = await h.db.select().from(receipts).where(eq(receipts.bookId, BOOK));
    expect(rec.length).toBe(1);
    expect(rec[0]!.kind).toBe(RECEIPT_KIND.QUOTE);
    expect(rec[0]!.payloadHash).toBe(payloadHash(rec[0]!.payload)); // hash recomputes from stored jsonb
  });

  test("fills: duplicates ignored (ON CONFLICT DO NOTHING), receipts only for new rows", async () => {
    const ts = Date.now() - 10_000;
    const row = (id: string, t: number) => ({ bookId: BOOK, ts: new Date(t), side: "buy" as const, qty: 1, px: 190, feeUsd: 0.02, venueTradeId: id, maker: true, trader: null });
    const rf = (ins: Array<{ venueTradeId: string; ts: Date }>) =>
      ins.map((r) => fillReceipt({ bookId: BOOK, ts: r.ts.getTime(), side: "buy", qty: 1, px: 190, feeUsd: 0.02, venueTradeId: r.venueTradeId, maker: true }, 60));
    expect((await store.insertFills([row("a", ts), row("b", ts + 1)], rf)).sort()).toEqual(["a", "b"]);
    expect(await store.insertFills([row("a", ts), row("c", ts + 2)], rf)).toEqual(["c"]);
    expect((await h.db.select().from(fills).where(eq(fills.bookId, BOOK))).length).toBe(3);
    expect(await store.lastFillTs(BOOK)).toBe(ts + 2);
    const rec = await h.db.select().from(receipts).where(eq(receipts.bookId, BOOK));
    expect(rec.filter((r) => r.kind === RECEIPT_KIND.FILL).length).toBe(3);
  });

  test("hedges with signed raw qty + receipt", async () => {
    const ts = Date.now();
    await store.insertHedge(
      { bookId: BOOK, ts: new Date(ts), asset: "0xabc", qtyRaw: -(10n ** 30n), px: 190, mult: 1, txHash: "0x01", venue: "UNIV3", valueUsd: usd(1234.5) },
      hedgeReceipt({ bookId: BOOK, ts, action: "sell", token: "0xabc", venue: "UNIV3", qtyRaw: -(10n ** 30n), amountIn: 10n ** 30n, amountOut: usd(1234.5), valueUsd: usd(1234.5), txHash: "0x01" }, 60),
    );
    const r = await h.db.select().from(hedges).where(eq(hedges.bookId, BOOK));
    expect(r[0]!.qtyRaw).toBe("-1000000000000000000000000000000");
    expect(r[0]!.valueUsd).toBe("1234.500000");
  });
});

describe.skipIf(!IT)("RedisBus (integration)", () => {
  test("quote key + channel, heartbeat, subscribe", async () => {
    const url = process.env.REDIS_URL ?? "redis://127.0.0.1:63790";
    const bus = new RedisBus(url, silentLog);
    const listener = new RedisBus(url, silentLog);
    const got: string[] = [];
    await listener.subscribe(CHANNELS.quotes(BOOK), (raw) => got.push(raw));
    const msg = { bookId: BOOK, ts: Date.now(), bid: 1, ask: 2, size: 3, mid: 1.5, oracle: 1.5, inventoryUsd: 0, skewBps: 0, widthBps: 1, sides: { bid: true, ask: true } };
    await bus.publishQuote(msg, 5_000);
    await bus.heartbeat(BOOK, 5_000);
    await Bun.sleep(100);
    expect(got.length).toBe(1);
    expect(await bus.getJson<typeof msg>(KEYS.agentQuote(BOOK))).toEqual(msg);
    expect(Number(await bus.getJson<number>(KEYS.agentHeartbeat(BOOK)))).toBeGreaterThan(0);
    await bus.clearQuote(BOOK);
    expect(await bus.getJson(KEYS.agentQuote(BOOK))).toBeNull();
    await Promise.all([bus.close(), listener.close()]);
  });
});
