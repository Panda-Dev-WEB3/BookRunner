// Integration (BKRN_IT=1, DATABASE_URL -> a migrated scratch database).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { books, createDb, marks, quotes, settlements } from "@bookrunner/db";
import { WAD, usd } from "@bookrunner/shared";
import { eq } from "drizzle-orm";
import { PgMarkStore } from "../src/index";
import type { MarkRow } from "../src/ports";
import { P } from "./fixtures";

const IT = process.env.BKRN_IT === "1";
const BOOK = 9301;

describe.skipIf(!IT)("mark store (postgres)", () => {
  const { db, close } = createDb(process.env.DATABASE_URL, 2);
  const store = new PgMarkStore(db);
  const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

  beforeAll(async () => {
    await db.delete(marks).where(eq(marks.bookId, BOOK));
    await db.delete(books).where(eq(books.id, BOOK));
    await db.delete(quotes).where(eq(quotes.bookId, BOOK));
    await db.delete(settlements).where(eq(settlements.bookId, BOOK));
    await db.insert(books).values({
      id: BOOK,
      charterId: BOOK,
      seniorAddr: a(2),
      juniorAddr: a(3),
      vaultAddr: a(4),
      venue: 0,
      symbol: "PERP_TEST_USDC",
      createdAt: new Date(),
      bookAddr: a(1),
      mandateAddr: a(5),
      routerAddr: a(6),
      deskAddr: a(7),
      adapterAddr: a(8),
      underlying: `0x${"00".repeat(32)}`,
      state: "Live",
    });
    await db.insert(quotes).values([
      { bookId: BOOK, ts: new Date((P - 20) * 1000), size: 1, inventoryUsd: 0, skewBps: 3.5, bid: 1, ask: 2 },
      { bookId: BOOK, ts: new Date((P + 20) * 1000), size: 1, inventoryUsd: 0, skewBps: 9, bid: 1, ask: 2 },
    ]);
    await db.insert(settlements).values([
      { bookId: BOOK, ts: new Date((P - 100) * 1000), source: "funding", grossUsd: "1.250000", txHash: "0xf1", logIndex: 0, period: P },
      { bookId: BOOK, ts: new Date((P - 400) * 1000), source: "funding", grossUsd: "9.000000", txHash: "0xf2", logIndex: 0, period: P - 300 },
    ]);
  });
  afterAll(() => close());

  const row = (markId: number, periodEnd: number, unrealized: string): MarkRow => ({
    markId,
    bookId: BOOK,
    periodEnd,
    input: { bookId: BigInt(BOOK), periodEnd: BigInt(periodEnd), navUsd: usd("100"), deployedValueUsd: usd("90"), flowNonce: 3n, inventoryRoot: `0x${"01".repeat(32)}`, pnlJsonHash: `0x${"02".repeat(32)}`, receiptsRoot: `0x${"03".repeat(32)}` },
    pnl: { bookId: String(BOOK), periodEnd, pnl: { unrealizedUsd: unrealized } } as unknown as MarkRow["pnl"],
    signer: "0x00000000000000000000000000000000000000AA",
    signature: "0x1234",
    commitTx: `0x${"aa".repeat(32)}`,
    committedAt: new Date(periodEnd * 1000 + 10_000),
    preview: { seniorNav: usd("70"), juniorNav: usd("30"), seniorPrice: WAD, juniorPrice: WAD, pnlUsd: usd("1") },
  });

  test("committed row upsert, applied update, books NAV, period lookups", async () => {
    const m = 900_000 + Math.floor(Math.random() * 1000);
    await store.saveCommitted(row(m, P - 300, "12.500000"));
    await store.saveCommitted({ ...row(m, P - 300, "12.500000"), signature: "0xbeef" }); // upsert keeps one row
    const ev = { markId: BigInt(m), navUsd: usd("100"), pnlUsd: usd("1"), seniorNav: usd("70.5"), juniorNav: usd("29.5"), seniorPrice: WAD, juniorPrice: (WAD * 98n) / 100n };
    await store.saveApplied(m, `0x${"bb".repeat(32)}`, ev);
    await store.updateBookNav(BOOK, m, ev);
    const [mk] = await db.select().from(marks).where(eq(marks.id, m));
    expect(mk?.signature).toBe("0xbeef");
    expect(mk?.appliedTx).toBe(`0x${"bb".repeat(32)}`);
    expect(mk?.seniorNav).toBe("70.500000");
    expect(mk?.juniorPrice).toBeCloseTo(0.98, 10);
    const [bk] = await db.select().from(books).where(eq(books.id, BOOK));
    expect(bk?.navUsd).toBe("100.000000");
    expect(bk?.lastMarkId).toBe(m);

    expect((await store.markForPeriod(BOOK, P - 300))?.markId).toBe(m);
    expect(await store.markForPeriod(BOOK, P)).toBeNull();
    expect(await store.prevUnrealized(BOOK, P)).toBe(usd("12.5"));
    expect(await store.prevUnrealized(BOOK, P - 300)).toBe(0n);
    expect(await store.lastQuoteSkewBps(BOOK, P)).toBe(3.5);
    expect(await store.fundingInPeriod(BOOK, P - 300, P)).toBe(usd("1.25"));
    expect(await store.distribution(BOOK, P)).toBeNull();
  });
});
