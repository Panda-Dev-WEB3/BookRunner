// 2026-10 insurance pool keeper duties: InsurancePool.processEpoch once the oldest epoch is processable (ended, every
// active pool-funded book marked after its end, or the grace passed), several ended epochs per pass, cooldown on
// failure; Book.settleInsurance for a Retired pool-funded book whose final pool mark failed.
import { describe, expect, test } from "bun:test";
import { createLogger, usd } from "@bookrunner/shared";
import type { Hex } from "viem";
import { Cooldowns, KeeperRunner, type PoolKeeperChain, type PoolQueueSnapshot, PoolKeeperRunner, planEpoch, settleBackoffMs, shouldSettleInsurance } from "../src/index";
import { FakeKeeperChain, bookRef, fakeHash } from "./fakes";

const log = createLogger("pool-keeper-test", "silent");
const END = 1_790_208_000;
const DAY = 86_400;
const S = (n: number) => BigInt(n) * 10n ** 12n;

const snap = (o: Partial<PoolQueueSnapshot> = {}): PoolQueueSnapshot => ({
  nowSec: END + 60,
  procEpoch: 5,
  procEndsAt: END,
  fillEpoch: 5,
  pendingShares: S(100),
  depositsPending: usd("1000"),
  epochDepositAssets: usd("1000"),
  epochWithdrawShares: S(100),
  staleBooks: 0,
  staleBookIds: [],
  processGrace: DAY,
  ...o,
});

describe("planEpoch (InsurancePool.processEpoch gate)", () => {
  test("idle queue and open epoch: nothing to send", () => {
    expect(planEpoch(snap({ pendingShares: 0n, depositsPending: 0n }))).toMatchObject({ kind: "wait", reason: "idle" });
    expect(planEpoch(snap({ nowSec: END - 1 }))).toEqual({ kind: "wait", reason: "open", epoch: 5, until: END });
  });

  test("ended: processed once every book marked after the end; else waits until the grace, then processes stale", () => {
    expect(planEpoch(snap())).toEqual({ kind: "process", epoch: 5, stale: false });
    expect(planEpoch(snap({ staleBooks: 1, staleBookIds: [2] }))).toEqual({ kind: "wait", reason: "awaiting_marks", epoch: 5, until: END + DAY });
    expect(planEpoch(snap({ staleBooks: 1, nowSec: END + DAY }))).toEqual({ kind: "process", epoch: 5, stale: true });
  });

  test("an empty epoch with later requests is processed without waiting for marks (it prices nothing)", () => {
    expect(planEpoch(snap({ staleBooks: 3, epochDepositAssets: 0n, epochWithdrawShares: 0n }))).toEqual({ kind: "process", epoch: 5, stale: false });
    // but unfilled withdrawals of older epochs are priced too: gated
    expect(planEpoch(snap({ staleBooks: 3, epochDepositAssets: 0n, epochWithdrawShares: 0n, fillEpoch: 4 })).kind).toBe("wait");
  });
});

class FakePool implements PoolKeeperChain {
  queue: PoolQueueSnapshot[] = [];
  sent: Hex[] = [];
  fail = false;
  async poolQueue() {
    return this.queue[0] ?? null;
  }
  async processEpoch() {
    if (this.fail) throw new Error("execution reverted: BooksNotMarked");
    this.queue.shift();
    const h = fakeHash();
    this.sent.push(h);
    return h;
  }
}

describe("PoolKeeperRunner", () => {
  test("processes every processable ended epoch in one pass, stops at the first that must wait", async () => {
    const chain = new FakePool();
    chain.queue = [snap({ procEpoch: 5 }), snap({ procEpoch: 6, procEndsAt: END + 7 * DAY, nowSec: END + 60 })];
    const r = await new PoolKeeperRunner({ chain, cooldowns: new Cooldowns(), cooldownMs: 1000, log }).tick();
    expect(r.processed.map((p) => p.epoch)).toEqual([5]);
    expect(r.plan).toMatchObject({ kind: "wait", reason: "open", epoch: 6 });
  });

  test("no pool in the deployment: nothing; a failed processEpoch cools down", async () => {
    const none = new FakePool();
    expect((await new PoolKeeperRunner({ chain: none, cooldowns: new Cooldowns(), cooldownMs: 1000, log }).tick()).processed).toEqual([]);
    const chain = new FakePool();
    chain.queue = [snap()];
    chain.fail = true;
    let now = 0;
    const runner = new PoolKeeperRunner({ chain, cooldowns: new Cooldowns(() => now), cooldownMs: 1000, log });
    expect((await runner.tick()).error).toContain("BooksNotMarked");
    chain.fail = false;
    expect((await runner.tick()).processed).toEqual([]); // cooldown
    now += 1000;
    expect((await runner.tick()).processed).toHaveLength(1);
  });
});

describe("settleInsurance (retired pool-funded book, final mark not reported)", () => {
  test("only a Retired pool-funded book whose pool position is not closed", () => {
    expect(shouldSettleInsurance("Retired", { closed: false })).toBe(true);
    expect(shouldSettleInsurance("Retired", { closed: true })).toBe(false);
    expect(shouldSettleInsurance("Retired", null)).toBe(false);
    expect(shouldSettleInsurance("Retiring", { closed: false })).toBe(false);
  });

  test("review I-2: a confirmed settleInsurance that does not close the position is not resent within the backoff", async () => {
    const chain = new FakeKeeperChain();
    chain.snap.state = "Retired";
    chain.snap.insurance = { debt: usd("25000"), due: true, closed: false };
    let now = 0;
    const runner = new KeeperRunner({ chain, cooldowns: new Cooldowns(() => now), cfg: { bufferBps: 0n, minRecallUsd: usd("1"), flatThresholdUsd: usd("1"), recallAllWhenRetiring: true, cooldownMs: 1000 }, log });
    const count = () => chain.sent.filter((x) => x === "settleInsurance").length;
    await runner.tick(bookRef(1));
    expect(count()).toBe(1);
    await runner.tick(bookRef(1)); // tx confirmed, position still open: held
    expect(count()).toBe(1);
    now += 1000;
    await runner.tick(bookRef(1)); // first backoff (1 s) over: second attempt
    expect(count()).toBe(2);
    now += 1000;
    await runner.tick(bookRef(1)); // now 2 s
    expect(count()).toBe(2);
    now += 1000;
    await runner.tick(bookRef(1));
    expect(count()).toBe(3);
    // closed: nothing more, and the backoff resets
    chain.snap.insurance = { debt: 0n, due: true, closed: true };
    now += 60_000;
    await runner.tick(bookRef(1));
    expect(count()).toBe(3);
    expect(settleBackoffMs(1000, 0)).toBe(1000);
    expect(settleBackoffMs(1000, 3)).toBe(8000);
    expect(settleBackoffMs(30_000, 30)).toBe(6 * 3_600_000);
  });

  test("the book keeper sends it", async () => {
    const chain = new FakeKeeperChain();
    chain.snap.state = "Retired";
    chain.snap.insurance = { debt: usd("25000"), due: true, closed: false };
    const runner = new KeeperRunner({ chain, cooldowns: new Cooldowns(), cfg: { bufferBps: 0n, minRecallUsd: usd("1"), flatThresholdUsd: usd("1"), recallAllWhenRetiring: true, cooldownMs: 1000 }, log });
    const r = await runner.tick(bookRef(1));
    expect(chain.sent).toContain("settleInsurance");
    expect(r.actions.map((a) => a.kind)).toContain("settleInsurance");
  });
});
