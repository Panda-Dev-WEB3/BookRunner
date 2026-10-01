import { describe, expect, test } from "bun:test";
import { ACCOUNT } from "@bookrunner/shared";
import { looksAlreadyConfirmed, newWithdrawSaga, nextStep, shortfall, transition, type WithdrawSaga } from "../src/domain/withdraw";
import { BookRegistry } from "../src/worker/books";
import { WithdrawProcessor } from "../src/worker/withdrawals";
import { Provisioner, loadOrCreateBuilderKey } from "../src/worker/provision";
import { keyFromSecret } from "../src/orderly/auth";
import { ADAPTER, BUILDER_ID, IF_ID, makeCtx, MM_ID, SYMBOL, trackedBook } from "./helpers";

const base = () => newWithdrawSaga({ bookId: 1, adapter: ADAPTER, account: ACCOUNT.MM, accountId: MM_ID, amount: 5_000_000_000n, nonce: 7n }, 1000);

describe("withdraw state machine (pure)", () => {
  test("happy path detected -> requested -> paid -> confirmed -> swept", () => {
    let s = base();
    expect(nextStep(s)).toBe("request");
    s = transition(s, { type: "venue_requested", withdrawId: "9" }, 1001);
    expect([s.stage, s.withdrawId, nextStep(s)]).toEqual(["requested", "9", "pay"]);
    s = transition(s, { type: "venue_paid", payTx: "0x01" }, 1002);
    expect(nextStep(s)).toBe("confirm");
    s = transition(s, { type: "confirmed", confirmTx: "0x02" }, 1003);
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
    let e: WithdrawSaga = s;
    for (let i = 0; i < 2; i++) e = transition(e, { type: "error", error: "boom" }, 2, 3);
    expect([e.stage, e.attempts]).toEqual(["detected", 2]);
    e = transition(e, { type: "error", error: "boom" }, 3, 3);
    expect(e.stage).toBe("failed");
    expect(transition(base(), { type: "error", error: "fatal", fatal: true }, 4).stage).toBe("failed");
  });

  test("success resets attempts and clears the error", () => {
    const e = transition(base(), { type: "error", error: "boom" }, 2);
    const ok = transition(e, { type: "venue_requested", withdrawId: "1" }, 3);
    expect(ok.attempts).toBe(0);
    expect(ok.lastError).toBeUndefined();
  });

  test("helpers", () => {
    expect(shortfall(null, 10n)).toBe(0n);
    expect(shortfall(4n, 10n)).toBe(6n);
    expect(shortfall(12n, 10n)).toBe(0n);
    expect(looksAlreadyConfirmed("AlreadyConfirmed()")).toBe(true);
    expect(looksAlreadyConfirmed("execution reverted: OnlyOpsVenue")).toBe(false);
  });
});

describe("WithdrawProcessor (mock venue + fake chain)", () => {
  async function setup() {
    const t = await makeCtx();
    const reg = new BookRegistry(t.ctx);
    t.chain.books = [trackedBook()];
    await reg.refresh();
    const prov = new Provisioner(t.ctx, await loadOrCreateBuilderKey(t.keys, BUILDER_ID, undefined, 86_400_000, keyFromSecret));
    await prov.ensure(reg.list()[0] as ReturnType<typeof trackedBook>);
    t.mock.venue.credit(IF_ID, 25_000_000_000);
    t.mock.venue.credit(MM_ID, 75_000_000_000);
    t.mock.venue.setPrice("NVDA", 190, false);
    t.chain.ledger.set(MM_ID, 75_000_000_000n);
    const wp = new WithdrawProcessor(t.ctx, reg);
    return { ...t, reg, wp };
  }

  test("full saga: venue request -> operatorWithdraw -> confirmWithdraw -> sweepToVault; replays are no-ops", async () => {
    const t = await setup();
    t.chain.pendingNonces.add(`${ADAPTER.toLowerCase()}:7`);
    const log = { kind: "WithdrawRequested" as const, adapter: ADAPTER, account: ACCOUNT.MM, amount: 5_000_000_000n, nonce: 7n, block: 5n, txHash: "0xaa" as const, logIndex: 0 };
    t.wp.onRequested(log);
    t.wp.onRequested(log); // replay
    await t.wp.processAll();
    const s = Object.values(t.sagas.get().withdrawals)[0];
    expect(s?.stage).toBe("swept");
    expect(t.chain.count("operatorWithdraw")).toBe(1);
    expect(t.chain.count("confirmWithdraw")).toBe(1);
    expect(t.chain.count("sweepToVault")).toBe(1);
    expect(t.chain.count("creditFees")).toBe(0);
    expect(t.mock.venue.getAccount(MM_ID).holding).toBe(70_000_000_000);
    expect([...t.mock.venue.withdrawals.values()][0]?.status).toBe("COMPLETED");
    await t.wp.processAll();
    expect(t.chain.count("operatorWithdraw")).toBe(1);
  });

  test("venue PnL beyond the mock vault ledger is materialised with creditFees first", async () => {
    const t = await setup();
    t.chain.ledger.set(MM_ID, 1_000_000_000n);
    t.chain.pendingNonces.add(`${ADAPTER.toLowerCase()}:8`);
    t.wp.onRequested({ kind: "WithdrawRequested", adapter: ADAPTER, account: ACCOUNT.MM, amount: 3_000_000_000n, nonce: 8n, block: 5n, txHash: "0xab", logIndex: 0 });
    await t.wp.processAll();
    expect(t.chain.calls.find((c) => c.fn === "creditFees")?.args[1]).toBe(2_000_000_000n);
    expect(Object.values(t.sagas.get().withdrawals)[0]?.stage).toBe("swept");
  });

  test("insufficient venue balance keeps the saga waiting (retry), not failed", async () => {
    const t = await setup();
    t.wp.onRequested({ kind: "WithdrawRequested", adapter: ADAPTER, account: ACCOUNT.MM, amount: 900_000_000_000n, nonce: 9n, block: 5n, txHash: "0xac", logIndex: 0 });
    await t.wp.processAll();
    const s = Object.values(t.sagas.get().withdrawals)[0];
    expect(s?.stage).toBe("detected");
    expect(s?.attempts).toBe(1);
    expect(s?.lastError).toMatch(/exceeds/);
  });

  test("crash after payment: resumes without paying twice; already-confirmed nonce is tolerated", async () => {
    const t = await setup();
    t.chain.pendingNonces.add(`${ADAPTER.toLowerCase()}:10`);
    t.wp.onRequested({ kind: "WithdrawRequested", adapter: ADAPTER, account: ACCOUNT.MM, amount: 1_000_000_000n, nonce: 10n, block: 5n, txHash: "0xad", logIndex: 0 });
    t.chain.failNext.confirmWithdraw = "rpc down";
    await t.wp.processNonce(1, "10");
    let s = Object.values(t.sagas.get().withdrawals)[0];
    expect(s?.stage).toBe("paid");
    // simulate: the confirm actually landed before the crash
    t.chain.confirmed.add(`${ADAPTER.toLowerCase()}:10`);
    s = await t.wp.processNonce(1, "10");
    expect(s.stage).toBe("swept");
    expect(t.chain.count("operatorWithdraw")).toBe(1);
  });

  test("retiring book: IF withdrawal delists the symbol to release the insurance fund", async () => {
    const t = await setup();
    const book = t.reg.get(1);
    if (book) book.state = "Retiring";
    t.chain.ledger.set(IF_ID, 25_000_000_000n);
    t.chain.pendingNonces.add(`${ADAPTER.toLowerCase()}:11`);
    t.wp.onRequested({ kind: "WithdrawRequested", adapter: ADAPTER, account: ACCOUNT.IF, amount: 25_000_000_000n, nonce: 11n, block: 5n, txHash: "0xae", logIndex: 0 });
    await t.wp.processAll();
    expect(t.mock.venue.symbolStatus(t.mock.venue.requireSymbol(SYMBOL))).toBe("DELISTED");
    expect(Object.values(t.sagas.get().withdrawals)[0]?.stage).toBe("swept");
  });
});
