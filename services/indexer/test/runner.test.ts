// Indexer: decoding, dynamic book watch, cursor advance, idempotent re-application, poison logs.
import { describe, expect, test } from "bun:test";
import { CHANNELS, createLogger } from "@bookrunner/shared";
import { bookAbi, trancheAbi } from "@bookrunner/shared/abi";
import { CURSORS } from "../src/config";
import { cidFromDigest } from "../src/convert";
import { decodeLog } from "../src/decode";
import { planRange } from "../src/range";
import { Indexer } from "../src/runner";
import { WatchSet } from "../src/watch";
import { MemoryIndexerStore, makeLog } from "./helpers";
import { ADDR, DEPLOYMENT, DIGEST, EXPECTED_EVENT_TYPES, scenarioChain } from "./scenario";

const logger = createLogger("indexer-test", "silent");

function setup(over: { batch?: number; poison?: number } = {}) {
  const chain = scenarioChain();
  const store = new MemoryIndexerStore();
  const published: Array<{ channel: string; msg: Record<string, unknown> }> = [];
  const publisher = { publish: async (channel: string, m: string) => published.push({ channel, msg: JSON.parse(m) }) };
  const make = () =>
    new Indexer({
      store,
      chain,
      watch: new WatchSet(DEPLOYMENT),
      deployment: DEPLOYMENT,
      publisher,
      logger,
      config: { confirmations: 0, batchBlocks: over.batch ?? 2000, poisonAttempts: over.poison ?? 3, startBlock: 1 },
    });
  return { chain, store, published, make, indexer: make() };
}

async function drain(ix: Indexer, max = 50) {
  const results = [];
  for (let i = 0; i < max; i++) {
    const r = await ix.step();
    results.push(r);
    if (r.status === "idle") break;
  }
  return results;
}

describe("range planning", () => {
  test("from startBlock, batched, bounded by confirmations", () => {
    expect(planRange({ protocol: null, books: null }, 10, 100n, 0, 50)).toMatchObject({ from: 10n, to: 59n });
    expect(planRange({ protocol: 59, books: 59 }, 10, 100n, 5, 50)).toMatchObject({ from: 60n, to: 95n });
    expect(planRange({ protocol: 95, books: 95 }, 10, 100n, 5, 50)).toBeNull();
    // groups that diverged restart from the lagging one
    expect(planRange({ protocol: 80, books: 40 }, 10, 100n, 0, 1000)).toMatchObject({ from: 41n, to: 100n, done: { protocol: 80n, books: 40n } });
  });
});

describe("decoding", () => {
  test("known events decode with typed args", () => {
    const raw = makeLog(bookAbi, "Retired", { bookId: 4n, finalNav: 123n }, { address: ADDR.book, block: 9, logIndex: 0, tx: 99 });
    const r = decodeLog(raw, "book", 4);
    expect(r.ok && r.log.eventName).toBe("Retired");
    expect(r.ok && r.log.args).toEqual({ bookId: 4n, finalNav: 123n });
  });

  test("ERC-20 Transfer on a tranche decodes (implementation ABI) and is ignored by handlers; bad data is a skip", () => {
    const transfer = { ...makeLog(trancheAbi, "OperatorSet", { controller: ADDR.wallet, operator: ADDR.key, approved: true }, { address: ADDR.senior, block: 1, logIndex: 0, tx: 1 }) };
    transfer.topics = ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", transfer.topics[1]!, transfer.topics[2]!];
    const r1 = decodeLog(transfer, "senior", 1);
    expect(r1.ok && r1.log.eventName).toBe("Transfer");
    const bad = { ...makeLog(bookAbi, "Retired", { bookId: 4n, finalNav: 1n }, { address: ADDR.book, block: 1, logIndex: 0, tx: 1 }), data: "0x01" as const };
    const r2 = decodeLog(bad, "book", 4);
    expect(!r2.ok && r2.skip.reason).toBe("bad_data");
  });
});

describe("indexer runner", () => {
  test("indexes the whole scenario in one range and advances both cursors", async () => {
    const { store, published, indexer, chain } = setup();
    await indexer.init();
    const [first, second] = await drain(indexer);
    expect(first?.status).toBe("indexed");
    expect(second?.status).toBe("idle");
    if (first?.status !== "indexed") return;
    expect(first.from).toBe(1n);
    expect(first.to).toBe(8n);
    expect(first.skipped).toBe(1); // Mystery topic (tranche ERC-20 Transfer now decodes and is ignored)
    expect(await store.getCursor(CURSORS.protocol)).toBe(8);
    expect(await store.getCursor(CURSORS.books)).toBe(8);

    // BookCreated extended the watch set inside the same range: book logs were fetched after it
    expect(chain.getLogsCalls).toHaveLength(2);
    expect(chain.getLogsCalls[1]!.addresses).toContain(ADDR.senior);

    const s = store.s;
    const charter = s.charters[1]!;
    expect(charter.status).toBe("Approved");
    expect(charter.juryCid).toBe(cidFromDigest(DIGEST));
    expect(charter.bookAddr).toBe(ADDR.book);
    expect(charter.feeUsd).toBe("5000");
    expect(charter.symbol).toBe("PERP_NVDA_USDC");
    // verdict posted by an external juror -> placeholder row with posted tx
    expect(s.verdicts).toHaveLength(1);
    expect(s.verdicts[0]).toMatchObject({ charterId: 1, placeholder: true, recommendApprove: true });
    // committee
    expect(s.committee[ADDR.memberA]).toMatchObject({ seat: 0, bond: (25n * 10n ** 22n).toString() });
    expect(s.committee[ADDR.memberA]!.votes).toHaveLength(1);
    expect(s.committee[ADDR.memberB]!.votes[0]).toMatchObject({ charterId: 1, approve: true });
    // book state + NAV from the mark
    const book = s.books[1]!;
    expect(book).toMatchObject({ state: "Live", name: "NVDA", symbol: "PERP_NVDA_USDC", navUsd: "101000", seniorNav: "70300", juniorNav: "30700", lastMarkId: 1 });
    // subscriptions: two commits + one allocation claim
    expect(Object.values(s.subscriptions).map((x) => [x.tranche, x.kind, x.assets, x.shares])).toEqual([
      ["senior", "commit", "70000", "0"],
      ["junior", "commit", "30000", "0"],
      ["senior", "allocation", "0", "70000"],
    ]);
    // redemption honoured at the bucket price, claimed later
    const red = Object.values(s.redemptions)[0]!;
    expect(red).toMatchObject({ tranche: "junior", wallet: ADDR.sponsor, shares: "1000", assets: "1010", honouredMarkId: 1 });
    expect(new Date(red.eligibleAt).getTime() - new Date(red.noticeAt).getTime()).toBe(900_000);
    expect(red.claimedAt).toBeDefined();
    // marks / settlements / keys / kills
    expect(s.marks[1]).toMatchObject({ bookId: 1, navUsd: "101000", flowNonce: 3, signature: "0x1234", seniorNav: "70300", pnlUsd: "1000" });
    expect(s.marks[1]!.appliedTx).toBeDefined();
    expect(Object.values(s.settlements)[0]).toMatchObject({ source: "distribution", grossUsd: "100", carryUsd: "9", seniorUsd: "51", juniorUsd: "35", period: 1_790_000_100 });
    expect(s.agentKeys[`1:${ADDR.key}`]).toMatchObject({ status: "revoked", revokedReason: "KILL", operator: ADDR.operator });
    expect(s.kills).toHaveLength(1);
    expect(s.kills[0]).toMatchObject({ bookId: 1, reason: "DRAWDOWN" });

    // domain events: persisted + published on CHANNELS.domainEvents in chain order
    expect(Object.values(s.events).map((e) => e.type)).toEqual(EXPECTED_EVENT_TYPES);
    expect(published.map((p) => p.msg.type)).toEqual(EXPECTED_EVENT_TYPES);
    expect(published.every((p) => p.channel === CHANNELS.domainEvents)).toBe(true);
    const decided = published.find((p) => p.msg.type === "charter.decided")!.msg;
    expect(decided).toMatchObject({ data: { charterId: 1, approved: true, juryCid: cidFromDigest(DIGEST), book: ADDR.book } });
    expect(Object.keys(decided).sort()).toEqual(["createdAt", "data", "id", "type"]);
  });

  test("small batches reach the same state (cursor advances range by range)", async () => {
    const big = setup();
    await big.indexer.init();
    await drain(big.indexer);
    const small = setup({ batch: 2 });
    await small.indexer.init();
    const results = await drain(small.indexer);
    expect(results.filter((r) => r.status === "indexed").map((r) => (r.status === "indexed" ? [Number(r.from), Number(r.to)] : []))).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
    ]);
    const strip = (s: typeof big.store.s) => ({ ...s, events: Object.values(s.events).map((e) => [e.type, e.payload]) });
    expect(strip(small.store.s)).toEqual(strip(big.store.s));
  });

  test("re-applying the same blocks after a cursor reset is idempotent (no new rows, no new events)", async () => {
    const { store, published, indexer, make } = setup();
    await indexer.init();
    await drain(indexer);
    const before = JSON.stringify(store.s);
    const publishedBefore = published.length;
    await store.setCursor(CURSORS.protocol, 0);
    await store.setCursor(CURSORS.books, 0);
    const again = make(); // fresh process: watch set reloaded from the books table
    await again.init();
    await drain(again);
    expect(JSON.stringify(store.s)).toBe(before);
    expect(published.length).toBe(publishedBefore);
  });

  test("a restart resumes from the cursor without refetching indexed blocks", async () => {
    const { indexer, make, chain } = setup({ batch: 4 });
    await indexer.init();
    await indexer.step(); // blocks 1..4
    chain.getLogsCalls.length = 0;
    const resumed = make();
    await resumed.init();
    const r = await resumed.step();
    expect(r.status === "indexed" && [Number(r.from), Number(r.to)]).toEqual([5, 8]);
    expect(chain.getLogsCalls.every((c) => c.from === 5n)).toBe(true);
  });

  test("a failing range is retried; after the poison threshold the bad log is skipped and the cursor advances", async () => {
    const { chain, store, indexer } = setup({ poison: 2 });
    chain.failCharterIds.add(1n); // CharterFiled enrichment keeps failing
    await indexer.init();
    await expect(indexer.step()).rejects.toThrow("reverted");
    expect(await store.getCursor(CURSORS.protocol)).toBeNull();
    await expect(indexer.step()).rejects.toThrow("reverted");
    const r = await indexer.step(); // isolated mode
    expect(r.status === "indexed" && r.isolated).toBe(true);
    expect(r.status === "indexed" && r.skipped).toBe(2); // Mystery topic + the poison log
    expect(await store.getCursor(CURSORS.protocol)).toBe(8);
    expect(store.s.books[1]?.state).toBe("Live"); // everything else applied
    expect(store.s.charters[1]).toBeUndefined();
  });

  test("RPC errors leave the cursor untouched", async () => {
    const { chain, store, indexer } = setup();
    chain.getLogs = async () => {
      throw new Error("ECONNRESET");
    };
    await indexer.init();
    await expect(indexer.step()).rejects.toThrow("ECONNRESET");
    expect(await store.getCursor(CURSORS.books)).toBeNull();
  });
});
