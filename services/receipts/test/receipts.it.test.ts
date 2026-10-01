// Integration (BKRN_IT=1, DATABASE_URL -> a migrated scratch database).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, receiptRoots, receipts } from "@bookrunner/db";
import { RECEIPT_KIND, createLogger, payloadHash } from "@bookrunner/shared";
import { eq } from "drizzle-orm";
import {
  PgReceiptsStore,
  type ReceiptsDeps,
  closeReceiptsDefaults,
  configureReceipts,
  periodReceiptsRoot,
  processClosedWindows,
  receiptProof,
  verifyReceiptProof,
  windowRoot,
} from "../src/index";

const IT = process.env.BKRN_IT === "1";
const BOOK = 9101;
const IV = 60;
const T0 = 1_790_000_100;

describe.skipIf(!IT)("receipts (postgres)", () => {
  const { db, close } = createDb(process.env.DATABASE_URL, 2);
  const store = new PgReceiptsStore(db);
  const deps = (now: number): ReceiptsDeps => ({ store, intervalSeconds: IV, graceSeconds: 5, markIntervalSeconds: 300, now: () => now, log: createLogger("it", "silent") });
  const ids: number[] = [];

  beforeAll(async () => {
    await db.delete(receipts).where(eq(receipts.bookId, BOOK));
    await db.delete(receiptRoots).where(eq(receiptRoots.bookId, BOOK));
    for (let i = 0; i < 10; i++) {
      const payload = { i, px: 190.5 + i / 100, side: i % 2 ? "buy" : "sell", nested: { b: 2, a: 1 } };
      const ts = new Date((T0 + i * 29) * 1000 + 123);
      const [row] = await db
        .insert(receipts)
        .values({ bookId: BOOK, kind: i % 4, ts, payload, payloadHash: payloadHash(payload), hourStart: new Date(Math.floor((T0 + i * 29) / IV) * IV * 1000) })
        .returning({ id: receipts.id });
      ids.push(row!.id);
    }
  });

  afterAll(async () => {
    await closeReceiptsDefaults();
    await close();
  });

  test("service tick roots closed windows idempotently", async () => {
    const s1 = await processClosedWindows(deps(T0 + 310), { backfillSeconds: 3600, maxWindowsPerTick: 100 });
    expect(s1.windows).toBeGreaterThanOrEqual(5);
    const rows1 = await store.rootsInRange(BOOK, T0, T0 + 300);
    expect(rows1.map((r) => r.hourStart)).toEqual([T0, T0 + 60, T0 + 120, T0 + 180, T0 + 240]);
    expect(rows1.reduce((n, r) => n + r.leafCount, 0)).toBe(10);
    await processClosedWindows(deps(T0 + 310), { backfillSeconds: 3600, maxWindowsPerTick: 100 });
    expect(await store.insertRoots(rows1)).toBe(0); // unique (book_id, hour_start)
    expect(await store.rootsInRange(BOOK, T0, T0 + 300)).toEqual(rows1);
  });

  test("period root + proofs through the default (configured) entry points", async () => {
    configureReceipts({ db, intervalSeconds: IV, graceSeconds: 5, markIntervalSeconds: 300, now: () => T0 + 400 });
    const period = await periodReceiptsRoot(BOOK, T0, T0 + 300);
    expect(period.complete).toBe(true);
    expect(period.receiptCount).toBe(10);
    for (const id of ids) {
      const res = await receiptProof(id);
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.proof.period.root).toBe(period.root);
        expect(verifyReceiptProof(res.proof, period.root)).toBe(true); // jsonb round-trip did not change hashes
      }
    }
    expect((await windowRoot(BOOK, T0))?.leafCount).toBeGreaterThan(0);
  });
});
