import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, devAccount, usd } from "@bookrunner/shared";
import { MemoryEventSink } from "@bookrunner/waterfall";
import { LocalMarkSigner, MarkPipeline, MarkScheduler, MarkSpool, RetryableMarkError, deserializeMarkRow, markJobId, serializeMarkRow } from "../src/index";
import { parseArgs } from "../src/cli/mark-now";
import type { MarkRow } from "../src/ports";
import { FakeMarkChain, FakeMarkStore, FakeReceipts, P, ref } from "./fixtures";

const log = createLogger("mark-test", "silent");
const REGISTRY = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;

function setup(opts: { spool?: MarkSpool } = {}) {
  const chain = new FakeMarkChain();
  const store = new FakeMarkStore();
  const receipts = new FakeReceipts();
  const events = new MemoryEventSink();
  const signer = new LocalMarkSigner(devAccount("markSigner"), 31337, REGISTRY);
  const book = ref(1);
  const pipeline = new MarkPipeline({
    books: { get: async (id) => (id === 1 ? book : undefined) },
    chain,
    store,
    receipts,
    signer,
    events,
    log,
    maxRetries: 3,
    confirmations: 0n,
    receiptsWaitMs: 20,
    spool: opts.spool,
    dbRetries: 2,
    dbRetryBaseMs: 1,
  });
  return { chain, store, receipts, events, signer, pipeline };
}

describe("MarkPipeline", () => {
  test("commit -> applyMark -> persist -> mark.committed (once)", async () => {
    const { chain, store, events, pipeline, signer } = setup();
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status).toBe("applied");
    if (out.status !== "applied") return;
    expect(out.markId).toBe(1n);
    expect(out.input.navUsd).toBe(usd("110600"));
    expect(out.input.flowNonce).toBe(7n);
    expect(chain.commitCalls).toBe(1);
    expect(chain.applyCalls).toBe(1);
    const row = store.rows.get(1)!;
    expect(row.appliedTx).toBe(out.applyTx);
    expect(row.signer).toBe(signer.address);
    expect(row.pnl.pnl.feeFlowUsd).toBe("10.000000"); // senior + junior credited by the period's distribution
    expect(await signer.recover(row.input, row.signature)).toBe(signer.address);
    expect(store.bookNav.get(1)).toBe(usd("110600"));
    expect(events.events.map((e) => e.type)).toEqual(["mark.committed"]);
    expect(events.events[0]?.dedupeKey).toBe("mark.committed:1");

    // idempotent: the book already applied this period
    expect(await pipeline.run({ bookId: 1, periodEnd: P })).toEqual({ status: "already", reason: "book already applied a mark for this period" });
    expect(chain.commitCalls).toBe(1);
  });

  test("flowNonce moved after the snapshot: recompute before committing", async () => {
    const { chain, pipeline } = setup();
    chain.nonces = [8n]; // snapshot sees 7, a flow lands before the pre-commit check (8) -> recompute at 8
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status).toBe("applied");
    expect(chain.snapshots).toBe(2);
    expect(chain.commitCalls).toBe(1);
    expect(out.status === "applied" && out.input.flowNonce).toBe(8n);
  });

  test("flowNonce moved between commit and apply: bounded retry, then the period is reported unmarkable", async () => {
    const { chain, pipeline } = setup();
    chain.nonces = [7n, 9n]; // snapshot 7, pre-commit 7, a flow lands before applyMark (9)
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status).toBe("unmarkable");
    expect(chain.applyCalls).toBe(0);
    expect(chain.commitCalls).toBe(2); // second commit for the same period is refused by the registry
  });

  test("resumes a committed but unapplied mark", async () => {
    const { chain, pipeline, store } = setup();
    chain.failApply = true;
    await expect(pipeline.run({ bookId: 1, periodEnd: P })).rejects.toThrow("execution reverted");
    expect(store.rows.get(1)?.appliedTx).toBeUndefined();
    chain.failApply = false;
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status).toBe("applied");
    expect(chain.commitCalls).toBe(1);
    expect(store.rows.get(1)?.appliedTx).toBeDefined();
  });

  test("dry run sends nothing", async () => {
    const { chain, pipeline } = setup();
    const out = await pipeline.run({ bookId: 1, periodEnd: P }, { dryRun: true });
    expect(out.status).toBe("dry_run");
    expect(chain.commitCalls).toBe(0);
  });

  test("incomplete receipts root is retryable (unless explicitly allowed)", async () => {
    const { receipts, pipeline, chain } = setup();
    receipts.complete = false;
    await expect(pipeline.run({ bookId: 1, periodEnd: P })).rejects.toBeInstanceOf(RetryableMarkError);
    expect(chain.commitCalls).toBe(0);
    expect((await pipeline.run({ bookId: 1, periodEnd: P }, { allowIncompleteReceipts: true })).status).toBe("applied");
  });

  test("invalid period / unknown book", async () => {
    const { pipeline } = setup();
    expect((await pipeline.run({ bookId: 1, periodEnd: P + 1 })).status).toBe("unmarkable");
    expect((await pipeline.run({ bookId: 2, periodEnd: P })).status).toBe("unmarkable");
  });

  test("DB down right after commit: row spooled to disk, flushed later", async () => {
    const spool = new MarkSpool(mkdtempSync(join(tmpdir(), "mark-spool-")));
    const { store, pipeline } = setup({ spool });
    store.failSave = 2; // both retries fail
    const out = await pipeline.run({ bookId: 1, periodEnd: P });
    expect(out.status).toBe("applied");
    expect(store.rows.size).toBe(0);
    expect(spool.pending()).toHaveLength(1);
    expect(await spool.flush((r) => store.saveCommitted(r))).toBe(1);
    expect(store.rows.get(1)?.pnl.navUsd).toBe("110600.000000");
    expect(spool.pending()).toHaveLength(0);
  });
});

describe("spool serialisation", () => {
  test("round trip keeps bigints and dates", () => {
    const row: MarkRow = {
      markId: 3,
      bookId: 1,
      periodEnd: P,
      input: { bookId: 1n, periodEnd: BigInt(P), navUsd: 5n, deployedValueUsd: 4n, flowNonce: 2n, inventoryRoot: "0x01", pnlJsonHash: "0x02", receiptsRoot: "0x03" },
      pnl: { bookId: "1" } as MarkRow["pnl"],
      signer: "0x0000000000000000000000000000000000000001",
      signature: "0x04",
      commitTx: "0x05",
      committedAt: new Date(P * 1000),
      preview: { seniorNav: 1n, juniorNav: 2n, seniorPrice: 3n, juniorPrice: 4n, pnlUsd: -5n },
    };
    expect(deserializeMarkRow(serializeMarkRow(row))).toEqual(row);
  });
});

describe("MarkScheduler", () => {
  function sched(over: { distributed?: boolean; inTransit?: bigint; pending?: bigint; now?: number } = {}) {
    const enq: string[] = [];
    let now = over.now ?? P + 10;
    const s = new MarkScheduler({
      books: { list: async () => [ref(1)] },
      chain: {
        snapshot: async () => ({
          state: "Live",
          nowSec: now,
          markInterval: 300,
          subscriptionEnds: 0,
          unfundedClaims: 0n,
          vaultIdle: usd("100"),
          inTransit: over.inTransit ?? 0n,
          insuranceEquity: 0n,
          marginEquity: 0n,
          netExposure: 0n,
          sharePriceWad: { senior: 10n ** 18n, junior: 10n ** 18n },
          lastMarkPeriodEnd: P - 300,
          lastMark: null,
        }),
        pendingRedemptions: async () => ({ senior: over.pending ?? 0n, junior: 0n }),
        findDistributed: async () => null,
      },
      maxMarkAge: async () => 3600,
      store: { distribution: async () => (over.distributed ? { senior: 1n, junior: 1n, txHash: "0x1" } : null) },
      enqueue: async (job, g) => {
        enq.push(markJobId(job.bookId, job.periodEnd, g));
      },
      log,
      waitSeconds: 60,
      safetySeconds: 60,
    });
    return { s, enq, setNow: (t: number) => (now = t) };
  }

  test("enqueues once the period is distributed, exactly once", async () => {
    const { s, enq } = sched({ distributed: true });
    await s.tick();
    await s.tick();
    expect(enq).toEqual([`mark-1-${P}`]);
  });

  test("waits for the distribution until MARK_WAIT_SECONDS", async () => {
    const { s, enq, setNow } = sched();
    const r = await s.tick();
    expect(r[0]?.readiness).toEqual({ ready: false, reason: "waiting_distribution" });
    setNow(P + 60);
    await s.tick();
    expect(enq).toEqual([`mark-1-${P}`]);
  });

  test("waits for in-flight recalls when queued redemptions exceed idle", async () => {
    const { s, enq } = sched({ distributed: true, inTransit: usd("500"), pending: usd("400") });
    const r = await s.tick();
    expect(r[0]?.readiness).toEqual({ ready: false, reason: "waiting_liquidity" });
    expect(enq).toEqual([]);
  });

  test("exhausted jobs get a fresh generation", async () => {
    const { s, enq } = sched({ distributed: true });
    await s.tick();
    s.onJobExhausted(1, P);
    await s.tick();
    expect(enq).toEqual([`mark-1-${P}`, `mark-1-${P}-g1`]);
  });
});

describe("mark-now CLI args", () => {
  test("parses flags", () => {
    expect(parseArgs(["3"])).toEqual({ bookId: 3, dryRun: false, enqueue: false, allowIncompleteReceipts: false });
    expect(parseArgs(["2", "--dry-run", "--period", String(P)])).toEqual({ bookId: 2, period: P, dryRun: true, enqueue: false, allowIncompleteReceipts: false });
    expect(() => parseArgs([])).toThrow("usage");
    expect(() => parseArgs(["1", "--bogus"])).toThrow("unknown argument");
  });
});
