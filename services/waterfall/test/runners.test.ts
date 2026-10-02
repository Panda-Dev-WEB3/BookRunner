import { describe, expect, test } from "bun:test";
import { RECEIPT_KIND, VENUE, createLogger, usd } from "@bookrunner/shared";
import {
  Cooldowns,
  KeeperRunner,
  MemoryEventSink,
  MemorySettlementSignals,
  RedisSettlementSignals,
  SettlementRunner,
  distributionDedupeKey,
  noDistributionKey,
  receiptRow,
} from "../src/index";
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

describe("SettlementRunner: skip empty work (LOW_GAS §3/§4)", () => {
  function lowGas(venue: 0 | 1 = VENUE.POOL_ENGINE, o: { distributeEmpty?: boolean; failSignal?: boolean } = {}) {
    const ref = bookRef(1, venue);
    const chain = new FakeSettlementChain();
    const store = new FakeSettlementStore();
    const venueOps = new FakeVenueOps();
    const events = new MemoryEventSink();
    const signals = new MemorySettlementSignals();
    if (o.failSignal) signals.markNoDistribution = async () => Promise.reject(new Error("redis down"));
    const runner = new SettlementRunner({
      books: new FakeBooks([ref]),
      chain,
      store,
      venueOps,
      events,
      expensesFor: () => usd("1.00"),
      log,
      sweepWaitMs: 50,
      pollMs: 5,
      signals,
      distributeEmpty: o.distributeEmpty,
      now: () => 1_790_000_105_000,
    });
    return { chain, store, venueOps, events, signals, runner };
  }

  test("engine book with no accrued fees and an empty router: no sweep tx, no distribute tx, mark told not to wait", async () => {
    const { chain, signals, events, store, runner } = lowGas();
    chain.engineFees = 0n;
    chain.params.pendingGross = 0n;
    const out = await runner.run({ bookId: 1, period: P });
    expect(out).toEqual({ status: "nothing_to_distribute", reason: "no fee flow this period (router pendingGross == 0)" });
    expect(chain.calls).not.toContain("sweepEngineFees");
    expect(chain.calls).not.toContain("distribute");
    expect(await signals.noDistribution(1, P)).toEqual({ bookId: 1, period: P, reason: out.status === "nothing_to_distribute" ? out.reason : "", pendingGross: "0", at: 1_790_000_105_000 });
    expect(await signals.noDistribution(1, P + 300)).toBeNull();
    expect(events.events).toHaveLength(0); // no distribution.paid for a period that paid nothing
    expect(store.rows.size).toBe(0);
  });

  test("engine fees accrued: sweep, then distribute what landed", async () => {
    const { chain, signals, runner } = lowGas();
    chain.engineFees = usd("5");
    chain.params.pendingGross = 0n;
    chain.sweepAdds = usd("5");
    const out = await runner.run({ bookId: 1, period: P });
    expect(out.status).toBe("distributed");
    expect(chain.calls.filter((c) => c === "sweepEngineFees")).toHaveLength(1);
    expect(out.status === "distributed" && out.split.gross).toBe(usd("5"));
    expect(signals.map.size).toBe(0);
  });

  test("no engine fees but fee flow already on the router (e.g. funding / liquidation share): distribute without the sweep tx", async () => {
    const { chain, runner } = lowGas();
    chain.engineFees = 0n;
    const out = await runner.run({ bookId: 1, period: P });
    expect(out.status).toBe("distributed");
    expect(chain.calls).not.toContain("sweepEngineFees");
    expect(chain.calls.filter((c) => c === "distribute")).toHaveLength(1);
  });

  test("Orderly book: ops-venue settled nothing (job completed, no FeesSwept) and an empty router -> nothing to distribute", async () => {
    const { chain, venueOps, signals, runner } = lowGas(VENUE.ORDERLY);
    venueOps.state = "completed";
    chain.params.pendingGross = 0n;
    const out = await runner.run({ bookId: 1, period: P });
    expect(out.status).toBe("nothing_to_distribute");
    expect(venueOps.enqueued).toEqual([`1:${P}`]); // a queue job, not a tx
    expect(chain.calls).not.toContain("distribute");
    expect(chain.calls).not.toContain("engineFeesAccrued");
    expect(await signals.noDistribution(1, P)).not.toBeNull();
  });

  test("WATERFALL_DISTRIBUTE_EMPTY keeps the zero distribution (pre-low-gas behaviour)", async () => {
    const { chain, signals, runner } = lowGas(VENUE.POOL_ENGINE, { distributeEmpty: true });
    chain.engineFees = 0n;
    chain.params.pendingGross = 0n;
    const out = await runner.run({ bookId: 1, period: P });
    expect(out.status).toBe("distributed");
    expect(chain.calls).toContain("distribute");
    expect(signals.map.size).toBe(0);
  });

  test("a failing signal store never fails the job (the mark falls back to its bounded wait)", async () => {
    const { chain, runner } = lowGas(VENUE.POOL_ENGINE, { failSignal: true });
    chain.engineFees = 0n;
    chain.params.pendingGross = 0n;
    expect((await runner.run({ bookId: 1, period: P })).status).toBe("nothing_to_distribute");
  });

  test("unreadable engine fee state: sweeps as before", async () => {
    const { chain, runner } = lowGas();
    chain.engineFees = null;
    await runner.run({ bookId: 1, period: P });
    expect(chain.calls).toContain("sweepEngineFees");
  });
});

describe("RedisSettlementSignals", () => {
  test("SET with TTL, round trip, foreign / malformed values ignored", async () => {
    const kv = new Map<string, { v: string; ttl: number }>();
    const redis = {
      get: async (k: string) => kv.get(k)?.v ?? null,
      set: async (k: string, v: string, _mode: "EX", ttl: number) => {
        kv.set(k, { v, ttl });
        return "OK";
      },
    };
    const s = new RedisSettlementSignals(redis, 60);
    const d = { bookId: 2, period: P, reason: "x", pendingGross: "0", at: 1 };
    await s.markNoDistribution(d);
    expect(kv.get(noDistributionKey(2, P))).toEqual({ v: JSON.stringify(d), ttl: 60 });
    expect(noDistributionKey(2, P)).toBe(`bkrn:waterfall:nodist:2:${P}`);
    expect(await s.noDistribution(2, P)).toEqual(d);
    expect(await s.noDistribution(3, P)).toBeNull();
    kv.set(noDistributionKey(3, P), { v: "{bad", ttl: 1 });
    expect(await s.noDistribution(3, P)).toBeNull();
    kv.set(noDistributionKey(4, P), { v: JSON.stringify({ ...d, bookId: 9 }), ttl: 1 });
    expect(await s.noDistribution(4, P)).toBeNull();
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
