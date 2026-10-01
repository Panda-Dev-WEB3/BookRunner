import { describe, expect, test } from "bun:test";
import { RECEIPT_KIND, VENUE, createLogger, usd } from "@bookrunner/shared";
import { Cooldowns, KeeperRunner, MemoryEventSink, SettlementRunner, distributionDedupeKey, receiptRow } from "../src/index";
import { FakeBooks, FakeKeeperChain, FakeSettlementChain, FakeSettlementStore, FakeVenueOps, bookRef, fakeHash } from "./fakes";

const log = createLogger("waterfall-test", "silent");
const P = 1_790_000_100;

function setup(venue: 0 | 1 = VENUE.POOL_ENGINE) {
  const ref = bookRef(1, venue);
  const chain = new FakeSettlementChain();
  const store = new FakeSettlementStore();
  const venueOps = new FakeVenueOps();
  const events = new MemoryEventSink();
  const charged: bigint[] = [];
  const runner = new SettlementRunner({
    books: new FakeBooks([ref]),
    chain,
    store,
    venueOps,
    events,
    expensesFor: () => usd("1.00"),
    onDistributed: (_id, e) => charged.push(e),
    log,
    sweepWaitMs: 50,
    pollMs: 5,
  });
  return { ref, chain, store, venueOps, events, runner, charged };
}

describe("SettlementRunner", () => {
  test("engine book: sweep -> distribute -> persist -> distribution.paid; second run is idempotent", async () => {
    const { chain, store, events, runner, charged } = setup();
    chain.sweepAdds = usd("50");
    const out = await runner.run({ bookId: 1, period: P });
    expect(out.status).toBe("distributed");
    if (out.status !== "distributed") return;
    expect(out.split.gross).toBe(usd("1050"));
    expect(out.parityMismatches).toEqual([]);
    expect(out.previewMismatches).toEqual([]);
    expect(chain.calls.filter((c) => c === "sweepEngineFees").length).toBe(1);
    expect(store.received.map((r) => r.amount)).toEqual([usd("50")]);
    expect(store.rows.get(`1:${P}`)?.amounts.senior).toBe(out.split.senior);
    expect(events.events).toHaveLength(1);
    expect(events.events[0]?.type).toBe("distribution.paid");
    expect(events.events[0]?.dedupeKey).toBe(distributionDedupeKey(1, P));
    expect((events.events[0]?.data as { grossUsd: string }).grossUsd).toBe("1050.000000");
    expect(charged).toEqual([usd("1.00")]);

    const again = await runner.run({ bookId: 1, period: P });
    expect(again).toEqual({ status: "already", source: "db", txHash: out.txHash });
    expect(chain.calls.filter((c) => c === "distribute").length).toBe(1);
    expect(events.events).toHaveLength(1); // dedupe
  });

  test("recovers a distribution that exists on-chain but not in the DB", async () => {
    const { ref, chain, store, events, runner } = setup();
    await chain.distribute(ref, P, usd("1"));
    chain.calls.length = 0;
    const out = await runner.run({ bookId: 1, period: P });
    expect(out.status).toBe("already");
    expect(chain.calls).not.toContain("distribute");
    expect(store.rows.has(`1:${P}`)).toBe(true);
    expect(events.events).toHaveLength(1);
  });

  test("distribute revert caused by a concurrent distribution is treated as done", async () => {
    const { chain, runner, store } = setup();
    chain.failDistribute = "race";
    const out = await runner.run({ bookId: 1, period: P });
    expect(out.status).toBe("already");
    expect(store.rows.has(`1:${P}`)).toBe(true);
  });

  test("other distribute reverts propagate (job retried)", async () => {
    const { chain, runner, store } = setup();
    chain.failDistribute = "revert";
    await expect(runner.run({ bookId: 1, period: P })).rejects.toThrow("execution reverted");
    expect(store.rows.size).toBe(0);
  });

  test("non-distributing states are skipped", async () => {
    const { chain, runner } = setup();
    chain.state = "Subscription";
    expect((await runner.run({ bookId: 1, period: P })).status).toBe("skipped");
    expect((await runner.run({ bookId: 99, period: P })).status).toBe("skipped");
  });

  test("orderly book: enqueues ops-venue sweep, waits for FeesSwept, records its SettlementReceived", async () => {
    const { ref, chain, venueOps, runner, store } = setup(VENUE.ORDERLY);
    venueOps.onEnqueue = () =>
      setTimeout(async () => {
        chain.swept.add(`${ref.bookId}:${P}`);
        const tx = (await chain.feesSwept(ref, P))!;
        chain.receivedByTx.set(tx, [{ source: 0, amount: usd("12"), txHash: tx, logIndex: 1, blockNumber: 9n, ts: new Date() }]);
      }, 10);
    const out = await runner.run({ bookId: 1, period: P });
    expect(venueOps.enqueued).toEqual([`1:${P}`]);
    expect(out.status).toBe("distributed");
    expect(chain.calls).not.toContain("sweepEngineFees");
    expect(store.received.map((r) => [r.source, r.amount])).toEqual([[0, usd("12")]]);
  });

  test("orderly book: bounded wait, then distributes what the router holds", async () => {
    const { venueOps, runner } = setup(VENUE.ORDERLY);
    const t0 = Date.now();
    const out = await runner.run({ bookId: 1, period: P });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
    expect(venueOps.enqueued).toHaveLength(1);
    expect(out.status).toBe("distributed");
  });

  test("orderly book: completed sweep job ends the wait early", async () => {
    const { venueOps, runner } = setup(VENUE.ORDERLY);
    venueOps.state = "completed";
    const t0 = Date.now();
    expect((await runner.run({ bookId: 1, period: P })).status).toBe("distributed");
    expect(Date.now() - t0).toBeLessThan(45);
  });

  test("parity break against the normative split is reported", async () => {
    const { chain, runner } = setup();
    chain.tamper = (s) => ({ ...s, senior: s.senior + 1n, junior: s.junior - 1n });
    const out = await runner.run({ bookId: 1, period: P });
    expect(out.status === "distributed" && out.parityMismatches).toEqual(["senior", "junior"]);
  });
});

describe("KeeperRunner", () => {
  function keeper(chain: FakeKeeperChain) {
    const decisions: Array<Record<string, unknown>> = [];
    let now = 0;
    const runner = new KeeperRunner({
      chain,
      cooldowns: new Cooldowns(() => now),
      cfg: { bufferBps: 0n, minRecallUsd: usd("1"), flatThresholdUsd: usd("1"), recallAllWhenRetiring: true, cooldownMs: 1000 },
      log,
      recordDecision: async (_b, p) => {
        decisions.push(p);
      },
    });
    return { runner, decisions, advance: (ms: number) => (now += ms) };
  }

  test("closes the window when due and stops for the tick", async () => {
    const chain = new FakeKeeperChain();
    chain.snap.state = "Subscription";
    chain.snap.subscriptionEnds = chain.snap.nowSec - 1;
    const { runner } = keeper(chain);
    const r = await runner.tick(bookRef(1));
    expect(chain.sent).toEqual(["closeWindow"]);
    expect(r.actions.map((a) => a.kind)).toEqual(["closeWindow"]);
  });

  test("recall-before-mark: queued redemptions above idle -> MM recall + DECISION receipt; cooldown prevents repeats", async () => {
    const chain = new FakeKeeperChain();
    chain.pending = { senior: usd("3000"), junior: usd("500") };
    const { runner, decisions, advance } = keeper(chain);
    const r = await runner.tick(bookRef(1));
    // next mark = latest closed period (1_790_000_100): buckets (lastMark/300, P/300]
    expect(chain.pendingArgs[0]).toEqual([5_966_666n, 5_966_667n]);
    expect(r.plan?.shortfall).toBe(usd("2500"));
    expect(chain.sent).toEqual([`recall:1:${usd("2500")}`]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.type).toBe("keeper.recall");
    expect(decisions[0]?.amountUsd).toBe("2500.000000");
    await runner.tick(bookRef(1));
    expect(chain.sent).toHaveLength(1);
    advance(1000);
    chain.snap.inTransit = usd("2500"); // venue reflects the request
    await runner.tick(bookRef(1));
    expect(chain.sent).toHaveLength(1);
  });

  test("funds claims, finalizes retirement, cools down failing actions", async () => {
    const chain = new FakeKeeperChain();
    chain.snap.state = "Retiring";
    chain.snap.unfundedClaims = usd("10");
    chain.snap.insuranceEquity = 0n;
    chain.snap.marginEquity = 0n;
    chain.snap.lastMark = { markId: 4n, applied: true, deployedValueUsd: 0n };
    chain.failing.add("finalizeRetirement");
    const { runner, advance } = keeper(chain);
    const r1 = await runner.tick(bookRef(1));
    expect(chain.sent).toEqual(["fundClaims"]);
    expect(r1.actions.find((a) => a.kind === "finalizeRetirement")?.error).toContain("finalizeRetirement failed");
    const r2 = await runner.tick(bookRef(1));
    expect(r2.actions.find((a) => a.kind === "finalizeRetirement")?.error).toBe("cooldown");
    chain.failing.clear();
    advance(1000);
    await runner.tick(bookRef(1));
    expect(chain.sent).toContain("finalizeRetirement");
  });
});

describe("receipts protocol row", () => {
  test("payload hash + hour_start floor", () => {
    const row = receiptRow({ bookId: 2, kind: RECEIPT_KIND.DECISION, ts: new Date(1_790_000_159_500), payload: { b: 1, a: fakeHash() } }, 60);
    expect(row.hourStart.getTime()).toBe(1_790_000_100_000);
    expect(row.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
