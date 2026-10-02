import { describe, expect, test } from "bun:test";
import { ACCOUNT } from "@bookrunner/shared";
import { WITHDRAW_STATUS } from "../src/chain";
import { matchPriorWithdrawal, newWithdrawSaga, nextStep, shortfall, transition, type WithdrawSaga } from "../src/domain/withdraw";
import { ADAPTER, MM_ID, setupWithdraw, SYMBOL, VAULT } from "./helpers";

const base = () => newWithdrawSaga({ bookId: 1, adapter: ADAPTER, account: ACCOUNT.MM, accountId: MM_ID, amount: 5_000_000_000n, nonce: 7n }, 1000);

describe("withdraw state machine (pure)", () => {
  test("happy path detected -> requested -> confirmed -> paid -> swept (confirm BEFORE the payout)", () => {
    let s = base();
    expect(nextStep(s)).toBe("request");
    s = transition(s, { type: "venue_requested", withdrawId: "9" }, 1001);
    expect([s.stage, s.withdrawId, nextStep(s)]).toEqual(["requested", "9", "confirm"]);
    s = transition(s, { type: "confirmed", confirmTx: "0x02" }, 1002);
    expect(nextStep(s)).toBe("pay");
    s = transition(s, { type: "venue_paid", payTx: "0x01" }, 1003);
    expect(nextStep(s)).toBe("sweep");
    s = transition(s, { type: "swept", sweepTx: "0x03" }, 1004);
    expect(s.stage).toBe("swept");
    expect(nextStep(s)).toBeNull();
    expect(() => transition(s, { type: "error", error: "x" }, 1005)).toThrow(/terminal/);
  });

  test("illegal transitions throw; errors retry then fail after max attempts", () => {
    const s = base();
    expect(() => transition(s, { type: "confirmed" }, 1)).toThrow(/illegal/);
    expect(() => transition(s, { type: "venue_paid" }, 1)).toThrow(/illegal/);
    const requested = transition(s, { type: "venue_requested", withdrawId: "1" }, 1);
    expect(() => transition(requested, { type: "venue_paid" }, 1)).toThrow(/illegal/); // never pay before confirm
    let e: WithdrawSaga = s;
    for (let i = 0; i < 2; i++) e = transition(e, { type: "error", error: "boom" }, 2, 3);
    expect([e.stage, e.attempts]).toEqual(["detected", 2]);
    e = transition(e, { type: "error", error: "boom" }, 3, 3);
    expect(e.stage).toBe("failed");
    expect(transition(base(), { type: "error", error: "fatal", fatal: true }, 4).stage).toBe("failed");
  });

  test("skipped / cancelled are terminal", () => {
    const sk = transition(base(), { type: "skipped", reason: "on-chain request is Confirmed" }, 2);
    expect([sk.stage, nextStep(sk)]).toEqual(["skipped", null]);
    const req = transition(base(), { type: "venue_requested", withdrawId: "1" }, 2);
    const c = transition(req, { type: "cancelled", reason: "venue FAILED", cancelTx: "0x05" }, 3);
    expect([c.stage, c.cancelTx]).toEqual(["cancelled", "0x05"]);
    expect(() => transition(c, { type: "confirmed" }, 4)).toThrow(/terminal/);
  });

  test("success resets attempts and clears the error", () => {
    const e = transition(base(), { type: "error", error: "boom" }, 2);
    const ok = transition(e, { type: "venue_requested", withdrawId: "1" }, 3);
    expect(ok.attempts).toBe(0);
    expect(ok.lastError).toBeUndefined();
  });

  test("helpers: shortfall, prior venue withdrawal matching", () => {
    expect(shortfall(null, 10n)).toBe(0n);
    expect(shortfall(4n, 10n)).toBe(6n);
    expect(shortfall(12n, 10n)).toBe(0n);
    const row = (id: number, o: Partial<{ status: string; amountUsd: bigint; clientRef: string | null; receiver: string | null; createdAt: number | null }> = {}) => ({
      id,
      status: "NEW",
      amountUsd: 5n,
      clientRef: null,
      receiver: ADAPTER.toLowerCase(),
      createdAt: 10_000,
      ...o,
    });
    const p = { ref: "wr-7", amount: 5n, receiver: ADAPTER, sinceMs: 9_000, claimed: new Set<string>() };
    expect(matchPriorWithdrawal([row(1, { clientRef: "wr-7", createdAt: 0 })], p)?.id).toBe(1); // own ref wins regardless of time
    expect(matchPriorWithdrawal([row(2)], p)?.id).toBe(2);
    expect(matchPriorWithdrawal([row(3, { createdAt: 1_000 })], p)).toBeNull(); // older than the on-chain request
    expect(matchPriorWithdrawal([row(4, { createdAt: null })], p)).toBeNull(); // no creation time: never adopted
    expect(matchPriorWithdrawal([row(5, { status: "FAILED" })], p)).toBeNull();
    expect(matchPriorWithdrawal([row(6, { amountUsd: 6n })], p)).toBeNull();
    expect(matchPriorWithdrawal([row(7, { receiver: "0x0000000000000000000000000000000000000bad" })], p)).toBeNull();
    expect(matchPriorWithdrawal([row(8)], { ...p, claimed: new Set(["8"]) })).toBeNull();
  });
});

// (the reviewed-finding scenarios live in regressions.test.ts)
describe("WithdrawProcessor (mock venue + fake chain)", () => {
  const setup = setupWithdraw;

  test("full saga: venue request -> confirmWithdraw -> operatorWithdraw -> sweepToVault; replays are no-ops", async () => {
    const t = await setup();
    const log = t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 5_000_000_000n);
    await t.wp.onRequested(log);
    await t.wp.onRequested(log); // replay
    await t.wp.processAll();
    const s = Object.values(t.sagas.get().withdrawals)[0];
    expect(s?.stage).toBe("swept");
    expect(t.chain.order("confirmWithdraw", "operatorWithdraw", "sweepToVault")).toEqual(["confirmWithdraw", "operatorWithdraw", "sweepToVault"]);
    expect(t.chain.count("creditFees")).toBe(0);
    expect(t.mock.venue.getAccount(MM_ID).holding).toBe(70_000_000_000);
    expect([...t.mock.venue.withdrawals.values()][0]?.status).toBe("COMPLETED");
    expect(t.chain.bal(VAULT)).toBe(5_000_000_000n);
    expect(t.adapterState().inTransit).toBe(0n);
    await t.wp.processAll();
    await t.wp.onRequested(log); // replay after completion
    expect(t.chain.count("operatorWithdraw")).toBe(1);
  });

  test("venue PnL beyond the mock vault ledger is materialised (mint + creditFees) before the payout, once", async () => {
    const t = await setup();
    t.chain.ledger.set(MM_ID, 1_000_000_000n);
    await t.wp.onRequested(t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 3_000_000_000n));
    await t.wp.processAll();
    expect(t.chain.calls.find((c) => c.fn === "creditFees")?.args[1]).toBe(2_000_000_000n);
    expect(t.chain.order("confirmWithdraw", "mint", "creditFees", "operatorWithdraw")).toEqual(["confirmWithdraw", "mint", "creditFees", "operatorWithdraw"]);
    expect(Object.values(t.sagas.get().withdrawals)[0]?.stage).toBe("swept");
  });

  test("a recorded tx that is still pending is waited for, never re-sent", async () => {
    const t = await setup();
    t.chain.lostReceipt.operatorWithdraw = true;
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 5_000_000_000n);
    await t.wp.onRequested(req);
    let s = await t.wp.processNonce(1, req.nonce.toString());
    expect(s.stage).toBe("confirmed");
    const hash = s.txs?.pay?.hash as string; // recorded before the (failed) receipt wait
    expect(hash).toMatch(/^0x/);
    t.chain.txStates.set(hash, "pending");
    s = await t.wp.processNonce(1, req.nonce.toString());
    expect([s.stage, s.attempts, t.chain.count("operatorWithdraw")]).toEqual(["confirmed", 1, 1]);
    t.chain.txStates.set(hash, "success");
    s = await t.wp.processNonce(1, req.nonce.toString());
    expect([s.stage, t.chain.count("operatorWithdraw")]).toEqual(["swept", 1]);
  });

  test("insufficient venue balance keeps the saga waiting (retry), not failed", async () => {
    const t = await setup();
    await t.wp.onRequested(t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 900_000_000_000n));
    await t.wp.processAll();
    const s = Object.values(t.sagas.get().withdrawals)[0];
    expect(s?.stage).toBe("detected");
    expect(s?.attempts).toBe(1);
    expect(s?.lastError).toMatch(/exceeds/);
    expect(t.chain.count("confirmWithdraw")).toBe(0);
  });

  test("venue rejects the withdrawal before confirmation: the on-chain request is cancelled, nothing moves", async () => {
    const t = await setup();
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 5_000_000_000n);
    await t.wp.onRequested(req);
    t.chain.failNext.confirmWithdraw = "rpc down";
    let s = await t.wp.processNonce(1, req.nonce.toString());
    expect(s.stage).toBe("requested");
    t.mock.venue.failWithdraw(Number(s.withdrawId), "test");
    s = await t.wp.processNonce(1, req.nonce.toString());
    expect(s.stage).toBe("cancelled");
    expect((await t.chain.withdrawStatus(ADAPTER, req.nonce)).status).toBe(WITHDRAW_STATUS.Cancelled);
    expect(t.adapterState().pendingWithdraw[ACCOUNT.MM]).toBe(0n);
    expect(t.chain.count("operatorWithdraw")).toBe(0);
    expect(t.mock.venue.getAccount(MM_ID).holding).toBe(75_000_000_000);
  });

  test("a request no longer Requested on-chain is never executed (detection and request step)", async () => {
    const t = await setup();
    const a = t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 1_000_000_000n);
    t.adapterState().requests.set(a.nonce.toString(), { status: WITHDRAW_STATUS.Confirmed, amount: a.amount, account: a.account, requestedAt: 0n });
    expect(await t.wp.onRequested(a)).toBeNull();
    const b = t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 2_000_000_000n);
    await t.wp.onRequested(b); // saga created while still Requested ...
    t.adapterState().requests.set(b.nonce.toString(), { status: WITHDRAW_STATUS.Cancelled, amount: b.amount, account: b.account, requestedAt: 0n });
    const s = await t.wp.processNonce(1, b.nonce.toString()); // ... cancelled before the venue request
    expect([s.stage, s.reason]).toEqual(["skipped", "on-chain request is Cancelled"]);
    expect(t.mock.venue.withdrawals.size).toBe(0);
  });

  test("mark-window gate closed: the sweep waits (no error, no attempt burnt) and completes once it opens", async () => {
    const t = await setup();
    t.chain.sweepBlocked = true;
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 5_000_000_000n);
    await t.wp.onRequested(req);
    let s = await t.wp.processNonce(1, req.nonce.toString());
    expect([s.stage, s.attempts]).toEqual(["paid", 0]);
    s = await t.wp.processNonce(1, req.nonce.toString());
    expect([s.stage, s.attempts]).toEqual(["paid", 0]);
    t.chain.sweepBlocked = false;
    s = await t.wp.processNonce(1, req.nonce.toString());
    expect(s.stage).toBe("swept");
    expect(t.adapterState().inTransit).toBe(0n);
  });

  test("a saga persisted by the old pay-before-confirm order is confirmed before it is swept", async () => {
    const t = await setup();
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 5_000_000_000n);
    await t.wp.onRequested(req);
    const key = `${ADAPTER.toLowerCase()}:${req.nonce}`;
    const legacy = t.sagas.get().withdrawals[key] as WithdrawSaga;
    t.sagas.get().withdrawals[key] = { ...legacy, stage: "paid", withdrawId: "1", payTx: "0x01" };
    t.chain.balances.set(ADAPTER.toLowerCase(), 5_000_000_000n); // the old order's payout already landed
    const s = await t.wp.processNonce(1, req.nonce.toString());
    expect(s.stage).toBe("swept");
    expect(t.chain.order("confirmWithdraw", "sweepToVault")).toEqual(["confirmWithdraw", "sweepToVault"]);
    expect(t.adapterState().inTransit).toBe(0n);
    expect(t.chain.bal(VAULT)).toBe(5_000_000_000n);
  });

  test("retiring book: IF withdrawal delists the symbol to release the insurance fund", async () => {
    const t = await setup("Retiring");
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.IF, 25_000_000_000n);
    await t.wp.onRequested(req);
    await t.wp.processAll();
    expect(t.mock.venue.symbolStatus(t.mock.venue.requireSymbol(SYMBOL))).toBe("DELISTED");
    expect(Object.values(t.sagas.get().withdrawals)[0]?.stage).toBe("swept");
  });
});
