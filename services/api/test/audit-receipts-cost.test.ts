// AUDIT 2026-10 M-4: the public receipts.proof / receipts.root rebuilt an hour's Merkle tree on every
// call (no cache), so a 10-call tRPC batch cost 160-840 ms of CPU on Bun's single thread and one IP at the
// nginx limit (20 req/s) used 3.2-16.7 s of API CPU per second. PoC reproduced here on a closed hour of
// LEAVES receipts: ten proofs of that hour must build its tree once, and a GET batch of ten receipts.proof
// is refused (receipts.* calls are heavy: one fills a batch). receipts.root checks the book exists first.
import { describe, expect, test } from "bun:test";
import { RECEIPT_KIND, RECEIPT_LEAF, payloadHash, verifyProof } from "@bookrunner/shared";
import { TRPCError } from "@trpc/server";
import { MAX_TRPC_BATCH, createApp, trpcBatchWeight } from "../src/app";
import { webOrigins } from "../src/config";
import { RECEIPT_TREE_CACHE, WeightedLru, receiptCaches } from "../src/domain/receiptCache";
import { hourlyTree } from "../src/domain/receipts";
import { NOW, type World, makeWorld, seedBook } from "./fixtures";

const LEAVES = 600;
const HOUR = 3600;

/** A closed mainnet-sized hour (receipts interval 3600 s) of book 1 with its stored root. */
function closedHour(w: World, opts: { stored?: boolean; hourStart?: Date; firstId?: number } = {}) {
  w.deps.settings.receiptsIntervalSeconds = HOUR;
  const hourStart = opts.hourStart ?? new Date((Math.floor(NOW / 1000 / HOUR) - 2) * HOUR * 1000);
  let id = opts.firstId ?? 10_000;
  const rows = [];
  for (let i = 0; i < LEAVES; i++) {
    const payload = { q: i, bid: 189.9 + i / 1000, ask: 190.1 + i / 1000 };
    const row = { id: id++, bookId: 1, kind: RECEIPT_KIND.QUOTE, ts: new Date(hourStart.getTime() + (i % HOUR) * 1000), payload, payloadHash: payloadHash(payload), hourStart };
    rows.push(row);
    w.data.receipts.push(row);
  }
  const t = hourlyTree(rows);
  if (opts.stored ?? true) w.data.receiptRoots.push({ id: w.data.receiptRoots.length + 1, bookId: 1, hourStart, root: t.root, leafCount: t.count, createdAt: new Date(hourStart.getTime() + HOUR * 1000 + 60_000) });
  return { hourStart, rows, root: t.root };
}

/** Counts receiptsInHour reads: every hourly tree build starts with one. */
function countHourReads(w: World) {
  const calls = { n: 0 };
  const orig = w.data.receiptsInHour.bind(w.data);
  w.data.receiptsInHour = async (bookId: number, hourStart: Date) => {
    calls.n++;
    return orig(bookId, hourStart);
  };
  return calls;
}

const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

async function trpcErr(p: Promise<unknown>): Promise<TRPCError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TRPCError) return e;
    throw e;
  }
  throw new Error("expected a TRPCError");
}

describe("audit M-4: receipts proof / root cost", () => {
  test("PoC: ten proofs of one closed hour build its tree once, and cost far less than ten builds", async () => {
    // cold cost of one proof (fresh process cache each time)
    const cold = makeWorld();
    seedBook(cold);
    const coldHour = closedHour(cold);
    const c0 = cpuMs();
    await cold.caller.receipts.proof({ receiptId: coldHour.rows[0]!.id });
    const oneBuildMs = cpuMs() - c0;

    const w = makeWorld();
    seedBook(w);
    const { rows, root } = closedHour(w);
    const reads = countHourReads(w);
    const t0 = cpuMs();
    const proofs = [];
    for (let i = 0; i < 10; i++) proofs.push(await w.caller.receipts.proof({ receiptId: rows[i * 7]!.id }));
    const tenCallsMs = cpuMs() - t0;
    console.log(`[M-4 PoC] ${LEAVES} leaves: one cold proof ${oneBuildMs.toFixed(1)} ms CPU; ten proofs of the hour ${tenCallsMs.toFixed(1)} ms CPU; hour reads ${reads.n}`);

    expect(reads.n).toBe(1); // audited code: 10 (one rebuild per call)
    expect(tenCallsMs).toBeLessThan(oneBuildMs * 3); // audited code: ~10x one build
    for (const [i, p] of proofs.entries()) {
      expect(p.receiptId).toBe(rows[i * 7]!.id);
      expect(p.hourly).toMatchObject({ root, storedRoot: root, matchesStored: true, verified: true, leafCount: LEAVES });
      expect(verifyProof(root, RECEIPT_LEAF, p.leaf.values, p.hourly.proof)).toBe(true);
    }
    // receipts.root of the same hour reuses the tree too (no extra read)
    const r = await w.caller.receipts.root({ bookId: 1, hourStart: rows[0]!.hourStart });
    expect(r).toMatchObject({ kind: "hour", computed: false, matches: true, leafCount: LEAVES });
    expect(reads.n).toBe(1);
  });

  test("cached proofs equal freshly built ones", async () => {
    const a = makeWorld();
    seedBook(a);
    const ha = closedHour(a);
    const pick = [0, 1, 299, LEAVES - 1].map((i) => ha.rows[i]!.id);
    const warm = [];
    for (const id of pick) warm.push(await a.caller.receipts.proof({ receiptId: id }));
    for (const [i, id] of pick.entries()) {
      const fresh = makeWorld();
      seedBook(fresh);
      closedHour(fresh);
      expect(warm[i]).toEqual(await fresh.caller.receipts.proof({ receiptId: id }));
    }
  });

  test("an hour still open (no stored root) is cached briefly; a receipt the cached tree lacks forces a rebuild", async () => {
    const w = makeWorld();
    seedBook(w);
    const { hourStart, rows } = closedHour(w, { stored: false, hourStart: new Date((Math.floor(NOW / 1000 / HOUR) * HOUR) * 1000) });
    const reads = countHourReads(w);
    await w.caller.receipts.proof({ receiptId: rows[0]!.id });
    await w.caller.receipts.proof({ receiptId: rows[1]!.id });
    expect(reads.n).toBe(1);
    // a new receipt lands in the open hour: its proof includes it
    const payload = { late: true };
    w.data.receipts.push({ id: 99_999, bookId: 1, kind: RECEIPT_KIND.QUOTE, ts: new Date(hourStart.getTime() + 5_000), payload, payloadHash: payloadHash(payload), hourStart });
    const p = await w.caller.receipts.proof({ receiptId: 99_999 });
    expect(reads.n).toBe(2);
    expect(p.hourly).toMatchObject({ leafCount: LEAVES + 1, verified: true });
    // after the open-hour TTL the tree is rebuilt
    w.now.ms += RECEIPT_TREE_CACHE.openTtlMs + 1;
    await w.caller.receipts.proof({ receiptId: rows[0]!.id });
    expect(reads.n).toBe(3);
  });

  test("receipts.root by hour checks the book exists before reading receipts", async () => {
    const w = makeWorld();
    seedBook(w);
    const reads = countHourReads(w);
    expect((await trpcErr(w.caller.receipts.root({ bookId: 42, hourStart: NOW / 1000 }))).code).toBe("NOT_FOUND");
    expect(reads.n).toBe(0);
  });

  test("a GET batch of ten receipts.proof is refused; receipts.* calls fill a batch on their own", async () => {
    const w = makeWorld();
    seedBook(w);
    const { rows } = closedHour(w);
    const reads = countHourReads(w);
    const app = createApp(w.deps, { origins: webOrigins("http://127.0.0.1:5180") });
    const batch = (calls: Array<[string, unknown]>) => {
      const paths = calls.map(([p]) => p).join(",");
      const input = Object.fromEntries(calls.map(([, v], i) => [String(i), { json: v }]));
      return app.request(`/trpc/${paths}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`);
    };
    const ten = await batch(Array.from({ length: 10 }, (_, i) => ["receipts.proof", { receiptId: rows[i]!.id }]));
    expect(ten.status).toBe(400); // audited code: 200, ten tree builds
    expect(reads.n).toBe(0);
    expect((await batch([["receipts.proof", { receiptId: rows[0]!.id }], ["book.get", { bookId: 1 }]])).status).toBe(400);
    expect((await batch([["receipts.proof", { receiptId: rows[0]!.id }]])).status).toBe(200);
    expect((await batch(Array.from({ length: 10 }, () => ["book.get", { bookId: 1 }]))).status).toBe(200);
    // the same call unbatched (the web client sends receipts.* through httpLink)
    const single = await app.request(`/trpc/receipts.proof?input=${encodeURIComponent(JSON.stringify({ json: { receiptId: rows[1]!.id } }))}`);
    expect(single.status).toBe(200);
    expect(trpcBatchWeight(["receipts.proof"])).toBe(MAX_TRPC_BATCH);
    expect(trpcBatchWeight(["book.get", "book.nav"])).toBe(2);
  });
});

describe("audit M-4: bounded tree cache", () => {
  test("LRU evicts the least recently used entry by count and by weight; oversized values are not cached", () => {
    const lru = new WeightedLru<string>({ maxEntries: 3, maxWeight: 10 });
    lru.set("a", "A", 2);
    lru.set("b", "B", 2);
    lru.set("c", "C", 2);
    expect(lru.get("a", 0)).toBe("A"); // a is now the most recent
    lru.set("d", "D", 2); // 4 entries > 3: evicts b
    expect(lru.get("b", 0)).toBeUndefined();
    lru.set("e", "E", 7); // weight 2+2+2+7 > 10: evicts c, then a (order c, a, d)
    expect(lru.get("c", 0)).toBeUndefined();
    expect(lru.get("a", 0)).toBeUndefined();
    expect(lru.get("d", 0)).toBe("D");
    expect(lru.weight).toBe(9);
    expect(lru.set("huge", "H", 11)).toBe(false);
    expect(lru.get("huge", 0)).toBeUndefined();
    lru.set("ttl", "T", 1, 100);
    expect(lru.get("ttl", 99)).toBe("T");
    expect(lru.get("ttl", 100)).toBeUndefined();
  });

  test("the hour cache is bounded in leaves (memory) and entries", async () => {
    const w = makeWorld();
    seedBook(w);
    const caches = receiptCaches(w.deps);
    expect(caches.hours.maxWeight).toBe(RECEIPT_TREE_CACHE.maxLeaves);
    expect(caches.hours.maxEntries).toBe(RECEIPT_TREE_CACHE.maxEntries);
    const { rows } = closedHour(w);
    await w.caller.receipts.proof({ receiptId: rows[0]!.id });
    expect(caches.hours.weight).toBe(LEAVES);
    expect(caches.hours.size).toBe(1);
  });
});
