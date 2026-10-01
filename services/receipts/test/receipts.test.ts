import { describe, expect, test } from "bun:test";
import { PERIOD_LEAF, RECEIPT_KIND, createLogger, payloadHash, receiptsTree, verifyProof } from "@bookrunner/shared";
import { zeroHash } from "viem";
import {
  MemoryReceiptsStore,
  type ReceiptsDeps,
  closedWindowStarts,
  ensureWindowRoots,
  hourlyTree,
  isWindowClosed,
  periodOfWindow,
  periodReceiptsRoot,
  periodRootWith,
  processClosedWindows,
  receiptProof,
  receiptProofWith,
  toLeaf,
  verifyReceiptProof,
  windowStartOf,
  windowsInPeriod,
} from "../src/index";

const log = createLogger("receipts-test", "silent");
const IV = 60;
const MARK = 300;
const T0 = 1_790_000_100; // aligned to 300 (1790000100 / 300 = 5966667)

function deps(store: MemoryReceiptsStore, now: number): ReceiptsDeps {
  return { store, intervalSeconds: IV, graceSeconds: 5, markIntervalSeconds: MARK, now: () => now, log };
}

function addReceipt(store: MemoryReceiptsStore, bookId: number, tsSec: number, payload: Record<string, unknown>, kind: number = RECEIPT_KIND.QUOTE) {
  const ts = new Date(tsSec * 1000 + 250);
  return store.addReceipt({ bookId, kind, ts, payload, payloadHash: payloadHash(payload), hourStart: new Date(windowStartOf(tsSec, IV) * 1000) });
}

describe("window math", () => {
  test("alignment, closure and period membership", () => {
    expect(T0 % MARK).toBe(0);
    expect(windowStartOf(T0 + 59, IV)).toBe(T0);
    expect(windowStartOf(T0 + 60, IV)).toBe(T0 + 60);
    expect(isWindowClosed(T0, IV, T0 + 60, 0)).toBe(true);
    expect(isWindowClosed(T0, IV, T0 + 64, 5)).toBe(false);
    expect(isWindowClosed(T0, IV, T0 + 65, 5)).toBe(true);
    expect(windowsInPeriod(T0, T0 + MARK, IV)).toEqual([T0, T0 + 60, T0 + 120, T0 + 180, T0 + 240]);
    expect(windowsInPeriod(T0 + 1, T0 + 121, IV)).toEqual([T0 + 60, T0 + 120]);
    expect(closedWindowStarts(T0, T0 + 184, IV, 5)).toEqual([T0, T0 + 60]);
    expect(closedWindowStarts(T0, T0 + 185, IV, 5)).toEqual([T0, T0 + 60, T0 + 120]);
    expect(closedWindowStarts(T0 + 1, T0 + 1000, IV, 0, 2)).toEqual([T0 + 60, T0 + 120]);
    expect(periodOfWindow(T0 + 240, MARK)).toEqual({ periodStart: T0, periodEnd: T0 + MARK });
  });
});

describe("hourly roots", () => {
  test("stored-hash tree equals shared receiptsTree when hashes match", () => {
    const store = new MemoryReceiptsStore();
    const a = addReceipt(store, 1, T0 + 1, { bid: 1, ask: 2 });
    const b = addReceipt(store, 1, T0 + 2, { qty: 3, px: 4 }, RECEIPT_KIND.FILL);
    const ours = hourlyTree([a, b].map(toLeaf));
    const shared = receiptsTree([a, b].map((r) => ({ kind: r.kind as 0 | 1 | 2 | 3, bookId: 1n, ts: BigInt(Math.floor(r.ts.getTime() / 1000)), payload: r.payload })));
    expect(ours.root).toBe(shared.root);
    expect(hourlyTree([b, a].map(toLeaf)).root).toBe(ours.root); // order independent
    expect(hourlyTree([]).root).toBe(zeroHash);
  });

  test("ensureWindowRoots is idempotent per (book, window) and only roots closed windows", async () => {
    const store = new MemoryReceiptsStore();
    addReceipt(store, 7, T0 + 10, { n: 1 });
    addReceipt(store, 7, T0 + 70, { n: 2 });
    const d = deps(store, T0 + 130); // windows T0, T0+60 closed (grace 5); T0+120 open
    const first = await ensureWindowRoots(d, 7, [T0, T0 + 60, T0 + 120]);
    expect(first.map((r) => r.hourStart)).toEqual([T0, T0 + 60]);
    expect(first.map((r) => r.leafCount)).toEqual([1, 1]);
    // a late receipt in an already-rooted window must not change the persisted root
    addReceipt(store, 7, T0 + 20, { n: 3 });
    const again = await ensureWindowRoots(d, 7, [T0, T0 + 60]);
    expect(again).toEqual(first);
    expect(store.roots.size).toBe(2);
  });
});

describe("period roots + proofs", () => {
  test("period root over window roots; complete flag; deterministic", async () => {
    const store = new MemoryReceiptsStore();
    for (let i = 0; i < 12; i++) addReceipt(store, 3, T0 + i * 25, { i, side: i % 2 ? "buy" : "sell" }, i % 4);
    const open = await periodRootWith(deps(store, T0 + 200), 3, T0, T0 + MARK);
    expect(open.complete).toBe(false);
    const d = deps(store, T0 + MARK + 10);
    const p1 = await periodReceiptsRoot(3, T0, T0 + MARK, d);
    const p2 = await periodReceiptsRoot(3n, BigInt(T0), BigInt(T0 + MARK), d);
    expect(p1.complete).toBe(true);
    expect(p1.windows.length).toBe(5);
    expect(p1.receiptCount).toBe(12);
    expect(p1.root).toBe(p2.root);
    expect(p1.root).not.toBe(zeroHash);
    // each window root verifies against the period root
    for (const w of p1.windows) {
      const proof = p1.tree.tree!.getProof([String(3), String(w.hourStart), w.root, w.leafCount]);
      expect(verifyProof(p1.root, PERIOD_LEAF, [3n, BigInt(w.hourStart), w.root, w.leafCount], proof as `0x${string}`[])).toBe(true);
    }
  });

  test("empty windows are committed explicitly (zero root, zero count)", async () => {
    const store = new MemoryReceiptsStore();
    const p = await periodReceiptsRoot(9, T0, T0 + MARK, deps(store, T0 + MARK + 10));
    expect(p.complete).toBe(true);
    expect(p.windows.every((w) => w.root === zeroHash && w.leafCount === 0)).toBe(true);
  });

  test("leaf proof verifies against the period root through the hourly root", async () => {
    const store = new MemoryReceiptsStore();
    const rows = [];
    for (let i = 0; i < 9; i++) rows.push(addReceipt(store, 5, T0 + i * 31, { i, px: 190 + i / 10 }, i % 3));
    const d = deps(store, T0 + MARK + 10);
    const period = await periodReceiptsRoot(5, T0, T0 + MARK, d);
    for (const r of rows) {
      const res = await receiptProof(r.id, d);
      expect(res.status).toBe("ok");
      if (res.status !== "ok") continue;
      expect(res.proof.period.root).toBe(period.root);
      expect(res.proof.period.complete).toBe(true);
      expect(verifyReceiptProof(res.proof)).toBe(true);
      expect(verifyReceiptProof(res.proof, period.root)).toBe(true);
      // tampering breaks verification at either level
      expect(verifyReceiptProof({ ...res.proof, leaf: { ...res.proof.leaf, ts: String(Number(res.proof.leaf.ts) + 1) } })).toBe(false);
      expect(verifyReceiptProof({ ...res.proof, hourly: { ...res.proof.hourly, leafCount: res.proof.hourly.leafCount + 1 } })).toBe(false);
      expect(verifyReceiptProof(res.proof, zeroHash)).toBe(false);
    }
  });

  test("late receipts: excluded from the root, earlier receipts still provable", async () => {
    const store = new MemoryReceiptsStore();
    const a = addReceipt(store, 2, T0 + 5, { a: 1 });
    const b = addReceipt(store, 2, T0 + 6, { b: 1 });
    const d = deps(store, T0 + 70);
    await ensureWindowRoots(d, 2, [T0]);
    const late = addReceipt(store, 2, T0 + 7, { late: true });
    expect((await receiptProofWith(d, late.id)).status).toBe("not_included");
    for (const r of [a, b]) {
      const res = await receiptProofWith(d, r.id);
      expect(res.status).toBe("ok");
      if (res.status === "ok") expect(verifyReceiptProof(res.proof)).toBe(true);
    }
    expect((await receiptProofWith(d, 999)).status).toBe("not_found");
    const open = addReceipt(store, 2, T0 + 65, { open: true });
    expect((await receiptProofWith(d, open.id)).status).toBe("window_open");
  });
});

describe("service tick", () => {
  test("roots closed windows for active books, resumes from the last root, bounded backfill", async () => {
    const store = new MemoryReceiptsStore();
    store.books.set(1, "Live");
    store.books.set(2, "Retired");
    addReceipt(store, 1, T0 + 3, { x: 1 });
    addReceipt(store, 4, T0 + 61, { y: 1 }); // book only known from receipts
    const opts = { backfillSeconds: 3600, maxWindowsPerTick: 100 };
    const s1 = await processClosedWindows(deps(store, T0 + 130), opts);
    expect(s1.books).toBe(2);
    expect((await store.rootsInRange(1, 0, 2 ** 40)).map((r) => r.hourStart)).toEqual([T0, T0 + 60]);
    expect((await store.rootsInRange(4, 0, 2 ** 40)).map((r) => r.hourStart)).toEqual([T0 + 60]);
    expect(await store.rootsInRange(2, 0, 2 ** 40)).toEqual([]);
    await processClosedWindows(deps(store, T0 + 250), opts);
    expect((await store.rootsInRange(1, 0, 2 ** 40)).map((r) => r.hourStart)).toEqual([T0, T0 + 60, T0 + 120, T0 + 180]);
    // late receipt detection
    addReceipt(store, 1, T0 + 185, { late: 1 });
    const s3 = await processClosedWindows(deps(store, T0 + 250), opts);
    expect(s3.lateReceipts).toBe(1);
  });
});
