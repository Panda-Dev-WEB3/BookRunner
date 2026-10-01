// Integration (BKRN_IT=1): CharterStore on a real Postgres *_it database — verdict content survives
// the jsonb round trip byte-exactly (CID verified on read), receipts/events protocols, committee upkeep.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Db, charters, createDb } from "@bookrunner/db";
import { RECEIPT_KIND, createLogger, payloadHash } from "@bookrunner/shared";
import { sql } from "drizzle-orm";
import { EventBus } from "../src/adapters/events";
import { CharterStore } from "../src/adapters/store";
import { charterToJson } from "../src/domain/charterJson";
import { cidOfJson } from "../src/domain/cid";
import { ruleJury } from "../src/domain/jurors";
import { runRuleChecks } from "../src/domain/ruleChecks";
import { buildVerdict } from "../src/domain/verdict";
import { lookupVerdict } from "../src/http/queries";
import { nvdaCharter, ruleContextFor } from "./fixtures";

const url = process.env.DATABASE_URL ?? "";
const IT = process.env.BKRN_IT === "1" && /\/[a-z0-9_]+_it(\?|$)/.test(url);

describe.skipIf(!IT)("CharterStore (integration)", () => {
  // created in beforeAll: the describe body also runs when the suite is skipped
  let db: Db;
  let close: () => Promise<void>;
  let store: CharterStore;
  const ID = 900_001;

  beforeAll(async () => {
    ({ db, close } = createDb(url, 2));
    store = new CharterStore(db, 60);
    for (const t of ["charters", "jury_verdicts", "receipts", "events", "committee"]) await db.execute(sql.raw(`delete from ${t}`)); // private *_it database only
    const c = nvdaCharter();
    await db.insert(charters).values({
      id: ID,
      sponsor: c.sponsor.toLowerCase(),
      structJson: charterToJson(c),
      status: "Filed",
      underlying: c.underlying,
      symbol: "PERP_NVDA_USDC",
      venue: 0,
      filedAt: new Date("2026-10-02T00:00:00Z"),
    });
  });
  afterAll(async () => {
    await close();
  });

  test("verdict JSON round-trips through jsonb and still hashes to its CID", async () => {
    const c = nvdaCharter();
    const checks = runRuleChecks(c, ruleContextFor(c, { liquidity: { mode: "unknown", usd: null } }));
    const verdict = buildVerdict({ charterId: ID, charter: c, votes: ruleJury(c, checks), ruleChecks: checks, createdAt: new Date("2026-10-02T12:00:00.000Z") });
    const id = await cidOfJson(verdict);
    expect(await store.filedWithoutPostedVerdict()).toEqual([{ id: ID, filedAt: new Date("2026-10-02T00:00:00Z") }]);
    await store.insertVerdict({ charterId: ID, cid: id.cid, digest: id.digest, recommendApprove: verdict.recommendApprove, verdict, postedTx: null });
    const r = await lookupVerdict(id.cid, store);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(new TextDecoder().decode(r.bytes)).toBe(new TextDecoder().decode(id.bytes));
    const latest = await store.latestVerdict(ID);
    expect(latest?.verdict).toEqual(verdict);

    await store.markPosted(ID, id.digest, `0x${"ab".repeat(32)}`);
    expect((await store.latestVerdict(ID))?.postedTx).toBe(`0x${"ab".repeat(32)}`);
    expect((await store.getCharter(ID))?.juryCid).toBe(id.cid);
    expect(await store.filedWithoutPostedVerdict()).toEqual([]);
  });

  test("receipts DECISION leaf with payload hash and hour bucket", async () => {
    const payload = { type: "jury_verdict", charterId: ID, cid: "bafk" };
    await store.insertReceipt({ bookId: ID, kind: RECEIPT_KIND.DECISION, ts: new Date("2026-10-02T12:00:59.900Z"), payload });
    const row = ((await db.execute(sql`select kind, payload_hash, hour_start from receipts where book_id = ${ID}`)) as unknown as Array<{ kind: number; payload_hash: string; hour_start: Date | string }>)[0]!;
    expect(row.kind).toBe(RECEIPT_KIND.DECISION);
    expect(row.payload_hash).toBe(payloadHash(payload));
    expect(new Date(row.hour_start).toISOString()).toBe("2026-10-02T12:00:00.000Z");
  });

  test("domain events are deduplicated and published once", async () => {
    const published: string[] = [];
    const bus = new EventBus(store, { publish: async (_c, m) => published.push(m) }, createLogger("it", "silent"));
    const e = { type: "jury.verdict_posted", bookId: ID, dedupeKey: `jury.verdict_posted:${ID}:x`, payload: { charterId: ID } };
    expect(await bus.emit(e)).toBe(true);
    expect(await bus.emit(e)).toBe(false);
    expect(published).toHaveLength(1);
    expect(Object.keys(JSON.parse(published[0]!)).sort()).toEqual(["createdAt", "data", "id", "type"]);
  });

  test("committee seats follow the chain", async () => {
    await store.upsertSeat("0x00000000000000000000000000000000000000A1", 0, 5n);
    await store.upsertSeat("0x00000000000000000000000000000000000000a2", 1, null);
    await store.upsertSeat("0x00000000000000000000000000000000000000a3", 0, 7n); // seat 0 replaced
    await store.unseatAllExcept(["0x00000000000000000000000000000000000000a3", "0x00000000000000000000000000000000000000a2"]);
    const rows = (await store.committeeRows()).map((r) => [r.member, r.seat, r.bond]).sort();
    expect(rows).toEqual([
      ["0x00000000000000000000000000000000000000a1", null, "5"],
      ["0x00000000000000000000000000000000000000a2", 1, "0"],
      ["0x00000000000000000000000000000000000000a3", 0, "7"],
    ]);
  });
});
