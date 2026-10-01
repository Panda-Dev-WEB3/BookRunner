// Integration test (needs Postgres): BKRN_IT=1 DATABASE_URL=postgres://.../bkrn_venue_it bun test
import { afterAll, describe, expect, test } from "bun:test";
import { createDb } from "@bookrunner/db";
import { CHANNELS, RECEIPT_KIND } from "@bookrunner/shared";
import { sql } from "drizzle-orm";
import { PgOpsStore } from "../src/store";

const enabled = process.env.BKRN_IT === "1";
const d = enabled ? describe : describe.skip;

d("PgOpsStore (Postgres)", () => {
  const pg = createDb(process.env.DATABASE_URL, 2);
  const published: Array<{ channel: string; message: string }> = [];
  const store = new PgOpsStore(pg.db, { publish: async (channel, message) => published.push({ channel, message }) }, 60);
  const bookId = 900_000 + Math.floor(Math.random() * 99_999);
  afterAll(async () => {
    await pg.db.execute(sql`delete from venue_accounts where book_id = ${bookId}`);
    await pg.db.execute(sql`delete from settlements where book_id = ${bookId}`);
    await pg.db.execute(sql`delete from events where book_id = ${bookId}`);
    await pg.db.execute(sql`delete from receipts where book_id = ${bookId}`);
    await pg.db.execute(sql`delete from chain_cursor where name = ${`it-${bookId}`}`);
    await pg.close();
  });

  test("venue_accounts upsert + status transitions", async () => {
    await store.upsertVenueAccount({ bookId, kind: "mm", accountId: "0xmm", keyPrefix: "ed25519:abcdefgh", status: "pending" });
    await store.upsertVenueAccount({ bookId, kind: "mm", accountId: "0xmm", keyPrefix: "ed25519:abcdefgh", status: "active" });
    await store.setVenueAccountStatus(bookId, "mm", "revoked");
    const rows = await store.venueAccounts(bookId);
    expect(rows).toEqual([{ bookId, kind: "mm", accountId: "0xmm", keyPrefix: "ed25519:abcdefgh", status: "revoked" }]);
    const r = await pg.db.execute(sql`select revoked_at from venue_accounts where book_id = ${bookId}`);
    expect((r as unknown as Array<{ revoked_at: Date | null }>)[0]?.revoked_at).not.toBeNull();
  });

  test("fee settlements are idempotent on (tx, log)", async () => {
    expect(await store.hasFeeSettlement(bookId, 600)).toBe(false);
    await store.insertFeeSettlement({ bookId, period: 600, amountUsd: 3_000_000n, txHash: `0xit${bookId}`, logIndex: 2, ts: new Date() });
    await store.insertFeeSettlement({ bookId, period: 600, amountUsd: 3_000_000n, txHash: `0xit${bookId}`, logIndex: 2, ts: new Date() });
    expect(await store.hasFeeSettlement(bookId, 600)).toBe(true);
    const r = await pg.db.execute(sql`select gross_usd from settlements where book_id = ${bookId}`);
    expect((r as unknown as Array<{ gross_usd: string }>).map((x) => x.gross_usd)).toEqual(["3.000000"]);
  });

  test("domain events dedupe and publish once; receipts + cursors", async () => {
    const key = `it:${bookId}:revoked`;
    expect(await store.emitEvent("agent.revoked", bookId, { bookId, key: "orderly:x", reason: "TEST" }, key)).toBe(true);
    expect(await store.emitEvent("agent.revoked", bookId, { bookId, key: "orderly:x", reason: "TEST" }, key)).toBe(false);
    expect(published).toHaveLength(1);
    expect(published[0]?.channel).toBe(CHANNELS.domainEvents);
    const msg = JSON.parse(published[0]?.message ?? "{}") as { id: number; type: string; data: { reason: string } };
    expect([typeof msg.id, msg.type, msg.data.reason]).toEqual(["number", "agent.revoked", "TEST"]);
    await store.insertReceipt({ bookId, kind: RECEIPT_KIND.DECISION, tsSec: 1_700_000_123, payload: { action: "revoke_venue_key" } });
    const rr = await pg.db.execute(sql`select hour_start from receipts where book_id = ${bookId}`);
    expect(new Date((rr as unknown as Array<{ hour_start: string }>)[0]?.hour_start ?? 0).getTime()).toBe(1_700_000_100_000);
    expect(await store.getCursor(`it-${bookId}`)).toBeNull();
    await store.setCursor(`it-${bookId}`, 42n);
    await store.setCursor(`it-${bookId}`, 43n);
    expect(await store.getCursor(`it-${bookId}`)).toBe(43n);
  });
});
