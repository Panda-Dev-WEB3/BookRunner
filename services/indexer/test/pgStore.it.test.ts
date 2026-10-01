// Integration (BKRN_IT=1): the scenario through PgIndexerStore on a real Postgres database.
// DATABASE_URL must point at a dedicated *_it database (never the shared one).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Db, createDb, juryVerdicts } from "@bookrunner/db";
import { createLogger } from "@bookrunner/shared";
import { sql } from "drizzle-orm";
import { CURSORS } from "../src/config";
import { cidFromDigest } from "../src/convert";
import { PgIndexerStore } from "../src/pgStore";
import { Indexer } from "../src/runner";
import { WatchSet } from "../src/watch";
import { ADDR, DEPLOYMENT, DIGEST, EXPECTED_EVENT_TYPES, scenarioChain } from "./scenario";

const url = process.env.DATABASE_URL ?? "";
const IT = process.env.BKRN_IT === "1" && /\/[a-z0-9_]+_it(\?|$)/.test(url);
const TABLES = ["charters", "jury_verdicts", "committee", "books", "subscriptions", "redemptions", "settlements", "agent_keys", "kill_events", "marks", "events", "chain_cursor"];

describe.skipIf(!IT)("PgIndexerStore (integration)", () => {
  // created in beforeAll: the describe body also runs when the suite is skipped
  let db: Db;
  let close: () => Promise<void>;
  let store: PgIndexerStore;
  const logger = createLogger("indexer-it", "silent");
  const count = async (t: string) => Number(((await db.execute(sql.raw(`select count(*)::int as n from ${t}`))) as unknown as Array<{ n: number }>)[0]!.n);
  const run = async () => {
    const ix = new Indexer({
      store,
      chain: scenarioChain(),
      watch: new WatchSet(DEPLOYMENT),
      deployment: DEPLOYMENT,
      publisher: null,
      logger,
      config: { confirmations: 0, batchBlocks: 3, poisonAttempts: 3, startBlock: 1 },
    });
    await ix.init();
    for (let i = 0; i < 20; i++) if ((await ix.step()).status === "idle") break;
  };

  beforeAll(async () => {
    ({ db, close } = createDb(url, 2));
    store = PgIndexerStore.create(db);
    for (const t of TABLES) await db.execute(sql.raw(`delete from ${t}`)); // private *_it database only
    // the charter service stores its verdict before posting; the indexer must attach posted_tx to it
    await db.insert(juryVerdicts).values({ charterId: 1, cid: cidFromDigest(DIGEST), digest: DIGEST, recommendApprove: true, verdict: { charterId: 1, summary: "stored by the charter service" } });
  });
  afterAll(async () => {
    await close();
  });

  test("scenario indexes into Postgres", async () => {
    await run();
    expect(await store.getCursor(CURSORS.protocol)).toBe(8);
    expect(await store.getCursor(CURSORS.books)).toBe(8);
    const charter = ((await db.execute(sql`select status, jury_cid, book_addr, fee_usd, symbol from charters where id = 1`)) as unknown as Array<Record<string, unknown>>)[0]!;
    expect(charter).toEqual({ status: "Approved", jury_cid: cidFromDigest(DIGEST), book_addr: ADDR.book, fee_usd: "5000.000000", symbol: "PERP_NVDA_USDC" });
    const verdicts = (await db.execute(sql`select posted_tx, verdict from jury_verdicts`)) as unknown as Array<{ posted_tx: string | null; verdict: Record<string, unknown> }>;
    expect(verdicts).toHaveLength(1); // matched the existing row, no placeholder
    expect(verdicts[0]!.posted_tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(verdicts[0]!.verdict.summary).toBe("stored by the charter service");
    const book = ((await db.execute(sql`select state, nav_usd, senior_nav, junior_nav, last_mark_id::int as last_mark_id from books where id = 1`)) as unknown as Array<Record<string, unknown>>)[0]!;
    expect(book).toEqual({ state: "Live", nav_usd: "101000.000000", senior_nav: "70300.000000", junior_nav: "30700.000000", last_mark_id: 1 });
    const red = ((await db.execute(sql`select assets, honoured_mark_id::int as honoured_mark_id, claimed_at is not null as claimed from redemptions`)) as unknown as Array<Record<string, unknown>>)[0]!;
    expect(red).toEqual({ assets: "1010.000000", honoured_mark_id: 1, claimed: true });
    const committee = (await db.execute(sql`select member, seat, jsonb_array_length(votes_json) as votes from committee order by member`)) as unknown as Array<Record<string, unknown>>;
    expect(committee).toEqual([
      { member: ADDR.memberA, seat: 0, votes: 1 },
      { member: ADDR.memberB, seat: null, votes: 1 },
    ]);
    const types = (await db.execute(sql`select type from events order by id`)) as unknown as Array<{ type: string }>;
    expect(types.map((t) => t.type)).toEqual(EXPECTED_EVENT_TYPES);
    expect(await count("kill_events")).toBe(1);
    expect(await count("marks")).toBe(1);
    expect(await count("settlements")).toBe(1);
    expect(await count("subscriptions")).toBe(3);
    const key = ((await db.execute(sql`select status, revoked_reason from agent_keys`)) as unknown as Array<Record<string, unknown>>)[0]!;
    expect(key).toEqual({ status: "revoked", revoked_reason: "KILL" });
  });

  test("re-indexing from scratch is idempotent on every table", async () => {
    const before: Record<string, number> = {};
    for (const t of TABLES) before[t] = await count(t);
    await store.setCursor(CURSORS.protocol, 0);
    await store.setCursor(CURSORS.books, 0);
    await run();
    for (const t of TABLES) expect({ t, n: await count(t) }).toEqual({ t, n: before[t]! });
    const votes = ((await db.execute(sql`select jsonb_array_length(votes_json) as n from committee where member = ${ADDR.memberA}`)) as unknown as Array<{ n: number }>)[0]!;
    expect(votes.n).toBe(1);
  });
});
