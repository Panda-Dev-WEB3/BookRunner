// Regression tests for the reviewed ops-venue findings (one describe per finding id). Each one fails on
// the pre-fix sources and passes after the fix; this file only imports symbols both versions export.
import { describe, expect, test } from "bun:test";
import { ACCOUNT } from "@bookrunner/shared";
import { MemorySagaStore } from "../src/store";
import { LOG_CURSOR, LogWatcher } from "../src/worker/logs";
import { WithdrawProcessor } from "../src/worker/withdrawals";
import { ADAPTER, MM_ID, OPS, ROUTER, setupFees, setupReporting, setupWithdraw, VAULT } from "./helpers";

describe("fee-saga-pay-before-earmark / ops-fee-transfer-before-earmark", () => {
  test("earmarks first, then pays the adapter, then forwards to the router", async () => {
    const t = await setupFees();
    const s = await t.sweeper.sweep(1, t.period);
    expect(s.stage).toBe("swept");
    expect(t.chain.order("sweepFees", "usdcTransfer", "forwardPendingFees")).toEqual(["sweepFees", "usdcTransfer", "forwardPendingFees"]);
    expect(t.chain.bal(ROUTER)).toBe(3_000_000n);
    expect(t.chain.adapter(ADAPTER).pendingFees).toBe(0n);
  });

  test("a permissionless sweepToVault right after the fee transfer cannot turn the fee into capital", async () => {
    const t = await setupFees();
    t.chain.after.usdcTransfer = () => t.chain.thirdPartySweep(ADAPTER);
    await t.sweeper.sweep(1, t.period);
    expect(t.chain.bal(VAULT)).toBe(0n);
    expect(t.chain.bal(ROUTER)).toBe(3_000_000n);
    expect(t.chain.adapter(ADAPTER).pendingFees).toBe(0n); // no stale earmark left behind
  });

  test("a failed earmark moves no USDC, and the auto loop resumes the saga to completion", async () => {
    const t = await setupFees();
    t.chain.failNext.sweepFees = "nonce too low";
    await expect(t.sweeper.sweep(1, t.period)).rejects.toThrow(/nonce/);
    expect(t.chain.bal(ADAPTER)).toBe(0n);
    expect(t.chain.count("usdcTransfer")).toBe(0);
    await t.sweeper.auto();
    expect(Object.values(t.sagas.get().fees)[0]?.stage).toBe("swept");
    expect(t.chain.bal(ROUTER)).toBe(3_000_000n);
  });
});

describe("ops-fee-transfer-retry-double-send", () => {
  test("fee transfer: receipt wait fails after broadcast -> the retry never sends USDC twice", async () => {
    const t = await setupFees();
    t.chain.balances.set(OPS.address.toLowerCase(), 10_000_000n); // another book's fee payout waiting on the ops EOA
    t.chain.lostReceipt.usdcTransfer = true;
    await t.sweeper.sweep(1, t.period).catch(() => undefined);
    await t.sweeper.sweep(1, t.period).catch(() => undefined);
    expect(t.chain.count("usdcTransfer")).toBe(1);
    expect(t.chain.bal(OPS.address)).toBe(10_000_000n);
  });

  test("withdraw payout: receipt wait fails after broadcast -> the retry never pays (or mints) again", async () => {
    const t = await setupWithdraw();
    t.chain.lostReceipt.operatorWithdraw = true;
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 5_000_000_000n);
    await t.wp.onRequested(req);
    await t.wp.processNonce(1, req.nonce.toString());
    const s = await t.wp.processNonce(1, req.nonce.toString());
    expect(s.stage).toBe("swept");
    expect(t.chain.count("operatorWithdraw")).toBe(1);
    expect(t.chain.count("creditFees")).toBe(0);
    expect(t.chain.bal(VAULT)).toBe(5_000_000_000n);
  });
});

describe("ops-withdraw-pay-before-confirm-double-count", () => {
  test("confirmWithdraw lands before the payout; a sweep right after the payout leaves no phantom in-transit", async () => {
    const t = await setupWithdraw();
    t.chain.after.operatorWithdraw = () => t.chain.thirdPartySweep(ADAPTER);
    await t.wp.onRequested(t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 20_000_000_000n));
    await t.wp.processAll();
    expect(t.chain.order("confirmWithdraw", "operatorWithdraw")).toEqual(["confirmWithdraw", "operatorWithdraw"]);
    expect(t.chain.bal(VAULT)).toBe(20_000_000_000n);
    expect(t.adapterState().inTransit).toBe(0n);
  });

  test("retiring recall-all: one saga's transient confirm failure cannot let another saga's sweep double-count it", async () => {
    const t = await setupWithdraw("Retiring");
    const ifReq = t.chain.requestWithdraw(ADAPTER, ACCOUNT.IF, 25_000_000n);
    await t.wp.onRequested(ifReq);
    await t.wp.onRequested(t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 75_000_000_000n));
    t.chain.failNext.confirmWithdraw = "rpc hiccup";
    await t.wp.processAll();
    await t.wp.processNonce(1, ifReq.nonce.toString());
    expect(t.chain.bal(VAULT)).toBe(75_025_000_000n);
    expect(t.adapterState().inTransit).toBe(0n);
  });
});

describe("ops-withdraw-replay-after-prune", () => {
  test("restart after the saga was pruned and the venue state reset: no rescan from start, no re-execution", async () => {
    const t = await setupWithdraw();
    const watch = (wp: WithdrawProcessor) => new LogWatcher(t.ctx, t.reg, { onAdapterLog: async (l) => void (l.kind === "WithdrawRequested" && (await wp.onRequested(l))), onMandateLog: () => {} });
    t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 75_000_000_000n);
    await watch(t.wp).poll();
    await t.wp.processAll();
    expect(Object.values(t.sagas.get().withdrawals)[0]?.stage).toBe("swept");
    t.chain.block += 50n;
    await watch(t.wp).poll();
    const cursor = t.store.cursors.get(LOG_CURSOR) as bigint;
    // 31 days later: saga pruned, mock-orderly snapshot reset, ops-venue restarts with the same DB cursor
    t.ctx.sagas = new MemorySagaStore();
    t.mock.venue.withdrawals.clear();
    t.mock.venue.credit(MM_ID, 75_000_000_000);
    t.chain.ledger.set(MM_ID, 75_000_000_000n);
    t.chain.logQueries = [];
    const wp2 = new WithdrawProcessor(t.ctx, t.reg);
    await watch(wp2).poll();
    await wp2.processAll();
    expect(Object.keys(t.ctx.sagas.get().withdrawals)).toEqual([]);
    expect(t.mock.venue.withdrawals.size).toBe(0);
    expect(t.chain.count("operatorWithdraw")).toBe(1);
    expect(t.chain.logQueries.every((q) => q.from >= cursor - 1n)).toBe(true);
  });

  test("a book tracked after a restart is backfilled from its own persisted cursor, not from deployment start", async () => {
    const t = await setupReporting();
    t.store.cursors.set(LOG_CURSOR, 500n);
    t.store.cursors.set(`${LOG_CURSOR}:${ADAPTER.toLowerCase()}`, 480n);
    t.chain.block = 600n;
    t.chain.logQueries = [];
    await new LogWatcher(t.ctx, t.svc.registry, { onAdapterLog: () => {}, onMandateLog: () => {} }).poll();
    expect(t.chain.logQueries.map((q) => [q.from, q.to])).toEqual([
      [480n, 499n],
      [500n, 600n],
    ]);
  });
});

describe("report-overwrites-inflight-flows", () => {
  test("no report while a withdrawal is between venue request and sweep", async () => {
    const t = await setupReporting();
    t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 30_000_000_000n);
    await t.svc.logs.poll();
    t.chain.failNext.confirmWithdraw = "rpc down"; // the saga stops after the venue debit
    await t.svc.withdrawals.processAll();
    expect(t.mock.venue.getAccount(MM_ID).holding).toBe(45_000_000_000); // venue already debited
    t.tick(60);
    await t.svc.reporter.report(t.book());
    expect(t.chain.count("report")).toBe(0);
  });

  test("no report while the adapter holds a requested-but-unconfirmed withdrawal not indexed yet", async () => {
    const t = await setupReporting();
    t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 1_000_000n);
    t.tick(60);
    await t.svc.reporter.report(t.book());
    expect(t.chain.count("report")).toBe(0);
  });

  test("no report within the settle window after a deposit (the venue credits it asynchronously)", async () => {
    const t = await setupReporting();
    t.chain.adapter(ADAPTER).lastFlowAt = t.chain.headTs - 5n;
    await t.svc.reporter.report(t.book());
    expect(t.chain.count("report")).toBe(0);
  });

  test("no report from the flow's own second, even with no settle window (A3-03: asOf must be > lastFlowAt)", async () => {
    const t = await setupReporting();
    t.ctx.settings.reportSettleSec = 0;
    t.chain.adapter(ADAPTER).lastFlowAt = t.chain.headTs;
    expect(await t.svc.reporter.holdReason(t.book(), t.chain.headTs)).toMatch(/not strictly after/);
    await t.svc.reporter.report(t.book());
    expect(t.chain.count("report")).toBe(0);
    // the wall clock lagging the head cannot produce an asOf at the flow second either
    t.tick(1);
    expect(await t.svc.reporter.holdReason(t.book(), t.chain.headTs, t.chain.headTs - 1n)).toMatch(/not strictly after/);
    expect(await t.svc.reporter.holdReason(t.book(), t.chain.headTs)).toBeNull();
    await t.svc.reporter.report(t.book());
    expect(t.chain.count("report")).toBe(1);
  });

  test("report is serialised with the book's saga lock", async () => {
    const t = await setupReporting();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const lock = t.ctx.locks.run(1, () => held); // a withdraw / fee saga step in progress
    const rep = t.svc.reporter.report(t.book());
    await Bun.sleep(20);
    expect(t.chain.count("report")).toBe(0);
    release();
    await lock;
    await rep;
    expect(t.chain.count("report")).toBe(1);
  });
});
