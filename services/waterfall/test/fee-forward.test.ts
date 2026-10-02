// Orderly fee flow lag: ops-venue earmarks (FeesSwept, forwards nothing: the venue payout is not on the
// adapter yet), then forwardPendingFees carries the USDC to the router seconds later. The period must
// distribute its own fees, not wait a whole period for them.
import { describe, expect, test } from "bun:test";
import { VENUE, createLogger, usd } from "@bookrunner/shared";
import { MemoryEventSink, SettlementRunner, forwardLanded, venueForwarded } from "../src/index";
import type { FeeForwarding, SettlementReceivedLog } from "../src/ports";
import { FakeBooks, FakeSettlementChain, FakeSettlementStore, FakeVenueOps, bookRef, fakeHash } from "./fakes";

const log = createLogger("waterfall-test", "silent");
const P = 1_790_000_100;
const NEXT = P + 300;

function setup(forwardWaitMs = 1_000) {
  const ref = bookRef(1, VENUE.ORDERLY);
  const chain = new FakeSettlementChain();
  chain.params.pendingGross = 0n;
  const store = new FakeSettlementStore();
  const venueOps = new FakeVenueOps();
  const runner = new SettlementRunner({
    books: new FakeBooks([ref]),
    chain,
    store,
    venueOps,
    events: new MemoryEventSink(),
    expensesFor: () => 0n,
    log,
    sweepWaitMs: 200,
    forwardWaitMs,
    pollMs: 5,
  });
  return { ref, chain, store, venueOps, runner };
}

const gross = (out: Awaited<ReturnType<SettlementRunner["run"]>>) => (out.status === "distributed" ? out.split.gross : null);
const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

describe("Orderly: wait for the earmark's forward before distributing", () => {
  test("earmark then forward (the live 23:00 sequence): the period distributes its own fees", async () => {
    const { ref, chain, store, runner } = setup();
    // ops-venue earmarked before the waterfall looked (FeesSwept already on-chain, nothing forwarded yet)
    const tx = await chain.earmark(ref, P, usd("23.285895"));
    later(30, () => chain.forward(tx, usd("23.285895")));
    const out = await runner.run({ bookId: 1, period: P });
    expect(gross(out)).toBe(usd("23.285895"));
    expect(chain.feeForwardingCalls).toBeGreaterThan(1); // it waited
    expect(store.received.map((r) => r.amount)).toEqual([usd("23.285895")]);
    expect(chain.params.pendingGross).toBe(0n); // nothing left behind for the next period

    // the next period distributes the next period's fees only
    const tx2 = await chain.earmark(ref, NEXT, usd("26.099904"));
    later(20, () => chain.forward(tx2, usd("26.099904")));
    expect(gross(await runner.run({ bookId: 1, period: NEXT }))).toBe(usd("26.099904"));
  });

  test("router still holds the previous period's late fees: both go out now, none waits a period", async () => {
    const { ref, chain, runner } = setup();
    chain.params.pendingGross = usd("26.099904"); // P-1's fees that landed after P-1 distributed (old behaviour)
    const tx = await chain.earmark(ref, P, usd("23.285895"));
    later(30, () => chain.forward(tx, usd("23.285895")));
    expect(gross(await runner.run({ bookId: 1, period: P }))).toBe(usd("26.099904") + usd("23.285895"));
  });

  test("waterfall enqueues the sweep, ops-venue earmarks, then forwards: waits for both", async () => {
    const { ref, chain, venueOps, runner } = setup();
    venueOps.onEnqueue = () =>
      later(10, async () => {
        const tx = await chain.earmark(ref, P, usd("12"));
        later(20, () => chain.forward(tx, usd("12")));
      });
    const out = await runner.run({ bookId: 1, period: P });
    expect(venueOps.enqueued).toEqual([`1:${P}`]);
    expect(gross(out)).toBe(usd("12"));
  });

  test("earmark forwarded within the sweepFees tx itself: no wait", async () => {
    const { ref, chain, runner } = setup(5_000);
    chain.swept.add(`1:${P}`);
    const tx = (await chain.feesSwept(ref, P))!;
    chain.receivedByTx.set(tx, [{ source: 0, amount: usd("7"), txHash: tx, logIndex: 1, blockNumber: 9n, ts: new Date() }]);
    chain.params.pendingGross = usd("7");
    const t0 = Date.now();
    expect(gross(await runner.run({ bookId: 1, period: P }))).toBe(usd("7"));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(chain.feeForwardingCalls).toBe(1);
  });

  test("forward never lands: bounded wait, distributes what the router holds, the next period picks the rest up once", async () => {
    const { ref, chain, store, runner } = setup(60);
    chain.params.pendingGross = usd("1");
    const tx = await chain.earmark(ref, P, usd("5"));
    const t0 = Date.now();
    const out = await runner.run({ bookId: 1, period: P });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
    expect(gross(out)).toBe(usd("1"));

    // the late forward lands after P distributed; re-running P never distributes twice
    chain.forward(tx, usd("5"));
    expect((await runner.run({ bookId: 1, period: P })).status).toBe("already");
    expect(chain.calls.filter((c) => c === "distribute")).toHaveLength(1);

    // the next period's distribution carries it (with its own fees)
    const tx2 = await chain.earmark(ref, NEXT, usd("2"));
    later(10, () => chain.forward(tx2, usd("2")));
    expect(gross(await runner.run({ bookId: 1, period: NEXT }))).toBe(usd("7"));
    expect(new Set(store.received.map((r) => r.txHash)).size).toBe(store.received.length);
  });

  test("earmark cancelled (adapter has no pending fees left): stops waiting", async () => {
    const { ref, chain, runner } = setup(5_000);
    chain.params.pendingGross = usd("3");
    const tx = await chain.earmark(ref, P, usd("5"));
    later(20, () => {
      chain.pendingFees = 0n; // cancelPendingFees
    });
    const t0 = Date.now();
    expect(gross(await runner.run({ bookId: 1, period: P }))).toBe(usd("3"));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(tx).toBeTruthy();
  });

  test("forwarding state unreadable: bounded, falls back to the earmark tx's own rows", async () => {
    const { ref, chain, store, runner } = setup(30);
    const tx = await chain.earmark(ref, P, usd("5"));
    chain.receivedByTx.set(tx, []);
    chain.feeForwarding = async () => Promise.reject(new Error("rpc down"));
    chain.params.pendingGross = usd("2");
    expect(gross(await runner.run({ bookId: 1, period: P }))).toBe(usd("2"));
    expect(store.received).toEqual([]);
  });
});

describe("forwardLanded", () => {
  const row = (source: number, amount: bigint): SettlementReceivedLog => ({ source, amount, txHash: fakeHash(), logIndex: 0, blockNumber: 1n, ts: new Date() });
  const f = (earmarked: bigint, received: SettlementReceivedLog[], pendingFees: bigint): FeeForwarding => ({ earmarked, received, pendingFees });

  test("venue fee flow covering the earmark, or no pending earmark", () => {
    expect(forwardLanded(f(usd("10"), [], usd("10")))).toBe(false);
    expect(forwardLanded(f(usd("10"), [row(0, usd("4"))], usd("6")))).toBe(false);
    expect(forwardLanded(f(usd("10"), [row(0, usd("4")), row(0, usd("6"))], usd("3")))).toBe(true); // an older earmark still pending
    expect(forwardLanded(f(usd("10"), [], 0n))).toBe(true); // forwarded or cancelled
  });

  test("only SRC_VENUE_TAKER_SHARE counts toward the earmark", () => {
    const x = f(usd("10"), [row(4, usd("10")), row(0, usd("2"))], usd("8"));
    expect(venueForwarded(x)).toBe(usd("2"));
    expect(forwardLanded(x)).toBe(false);
  });
});
