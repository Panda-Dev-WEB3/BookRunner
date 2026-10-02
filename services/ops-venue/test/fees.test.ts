import { describe, expect, test } from "bun:test";
import { ACCOUNT } from "@bookrunner/shared";
import { completedPeriods, type FeeSaga, feeInFlight, periodReady, planFeeSweep, type SettlementRow, unpaidEarmarks } from "../src/domain/fees";
import { ADAPTER, BUILDER_ID, OPS, ROUTER, SYMBOL, setupFees, VAULT } from "./helpers";

const row = (period: number, amount: bigint, symbol = SYMBOL): SettlementRow => ({ id: `${symbol}-${period}`, symbol, amountUsd: amount, period, ts: period * 1000 });

describe("fee sweep planning (pure)", () => {
  test("cumulative pending minus swept and in-flight, capped per period", () => {
    const settlements = [row(300, 5_000_000n), row(600, 7_000_000n), row(900, 11_000_000n), row(600, 99n, "PERP_TSLA_USDC")];
    expect(planFeeSweep({ symbol: SYMBOL, period: 600, settlements, sweptTotalUsd: 0n, inFlightUsd: 0n, capUsd: 10n ** 12n })).toEqual({ amount: 12_000_000n, settledUpTo: 12_000_000n, pending: 12_000_000n, carried: 0n });
    expect(planFeeSweep({ symbol: SYMBOL, period: 900, settlements, sweptTotalUsd: 12_000_000n, inFlightUsd: 0n, capUsd: 4_000_000n })).toEqual({ amount: 4_000_000n, settledUpTo: 23_000_000n, pending: 11_000_000n, carried: 7_000_000n });
    expect(planFeeSweep({ symbol: SYMBOL, period: 900, settlements, sweptTotalUsd: 20_000_000n, inFlightUsd: 3_000_000n, capUsd: 10n ** 12n }).amount).toBe(0n);
    expect(planFeeSweep({ symbol: SYMBOL, period: 900, settlements, sweptTotalUsd: 30_000_000n, inFlightUsd: 0n, capUsd: 10n ** 12n }).pending).toBe(0n);
  });

  test("in-flight excludes sagas already earmarked (counted in Σ FeesSwept); unpaid earmarks of other sagas", () => {
    const saga = (period: number, stage: FeeSaga["stage"], o: Partial<FeeSaga> = {}): FeeSaga => ({ key: `1:${period}`, bookId: 1, adapter: ADAPTER, symbol: SYMBOL, period, amount: "10", stage, attempts: 0, createdAt: 0, updatedAt: 0, ...o });
    const sagas = [saga(300, "planned"), saga(600, "requested", { earmarkTx: "0x01" }), saga(900, "paid", { earmarkTx: "0x02", payTx: "0x03" }), saga(1200, "swept")];
    expect(feeInFlight(sagas, 1, new Set([600, 900]))).toBe(10n);
    expect(feeInFlight(sagas, 1, new Set())).toBe(30n);
    expect(unpaidEarmarks(sagas, 1, "1:900")).toBe(10n); // 600 is earmarked but unpaid
    expect(unpaidEarmarks(sagas, 1, "1:600")).toBe(0n);
  });

  test("periods and readiness", () => {
    expect(completedPeriods(1000, 300, 0)).toEqual([300, 600, 900]);
    expect(completedPeriods(1000, 300, 600)).toEqual([900]);
    expect(periodReady({ period: 900, nowSec: 905, graceSec: 20, settlements: [], symbol: SYMBOL })).toBe(false);
    expect(periodReady({ period: 900, nowSec: 921, graceSec: 20, settlements: [], symbol: SYMBOL })).toBe(true);
    expect(periodReady({ period: 900, nowSec: 901, graceSec: 20, settlements: [row(900, 1n)], symbol: SYMBOL })).toBe(true);
  });
});

// (the reviewed-finding scenarios live in regressions.test.ts)
describe("FeeSweeper (mock venue + fake chain)", () => {
  const setup = setupFees;

  test("earmarks first, then pays the adapter, then forwards to the router — exactly once per period", async () => {
    const t = await setup();
    const s = await t.sweeper.sweep(1, t.period);
    expect(s.stage).toBe("swept");
    expect(s.amount).toBe("3000000");
    expect(t.chain.order("sweepFees", "operatorWithdraw", "usdcTransfer", "forwardPendingFees")).toEqual(["sweepFees", "operatorWithdraw", "usdcTransfer", "forwardPendingFees"]);
    expect(t.chain.calls.filter((c) => c.fn === "sweepFees").map((c) => c.args)).toEqual([[ADAPTER, BigInt(t.period), 3_000_000n]]);
    expect(t.chain.bal(ROUTER)).toBe(3_000_000n);
    expect(t.chain.bal(ADAPTER)).toBe(0n);
    expect(t.chain.adapter(ADAPTER).pendingFees).toBe(0n);
    expect(t.chain.count("creditFees")).toBe(1);
    expect(t.chain.count("operatorWithdraw")).toBe(1);
    expect(t.mock.venue.getAccount(BUILDER_ID).holding).toBe(0);
    expect(t.store.settlements).toHaveLength(1);
    // idempotent: same period again (job replay, auto loop) -> no second sweep
    await t.sweeper.sweep(1, t.period);
    await t.sweeper.auto();
    expect(t.chain.count("sweepFees")).toBe(1);
    expect(t.chain.count("usdcTransfer")).toBe(1);
  });

  test("a fee transfer recorded before its lost receipt is recognised on retry; the ops EOA's other USDC is untouched", async () => {
    const t = await setup();
    t.chain.balances.set(OPS.address.toLowerCase(), 10_000_000n);
    t.chain.lostReceipt.usdcTransfer = true;
    await expect(t.sweeper.sweep(1, t.period)).rejects.toThrow(/receipt/);
    const mid = Object.values(t.sagas.get().fees)[0] as FeeSaga;
    expect([mid.stage, mid.txs?.pay?.hash?.startsWith("0x")]).toEqual(["received", true]);
    const s = await t.sweeper.sweep(1, t.period);
    expect(s.stage).toBe("swept");
    expect([t.chain.count("usdcTransfer"), t.chain.bal(OPS.address), t.chain.bal(ROUTER), t.chain.bal(VAULT)]).toEqual([1, 10_000_000n, 3_000_000n, 0n]);
  });

  test("a failed earmark moves nothing; resumed, then the next period sweeps only the remainder", async () => {
    const t = await setup();
    t.chain.failNext.sweepFees = "nonce too low";
    await expect(t.sweeper.sweep(1, t.period)).rejects.toThrow(/nonce/);
    expect([t.chain.count("operatorWithdraw"), t.chain.count("usdcTransfer"), t.chain.bal(ADAPTER)]).toEqual([0, 0, 0n]);
    expect((await t.sweeper.sweep(1, t.period)).stage).toBe("swept");
    expect([t.chain.count("sweepFees"), t.chain.count("usdcTransfer"), t.chain.bal(ROUTER)]).toEqual([1, 1, 3_000_000n]);
    // nothing new settled -> next period is skipped (no chain calls)
    t.advance(300_000);
    expect((await t.sweeper.sweep(1, t.period + 300)).stage).toBe("skipped");
    expect(t.chain.count("sweepFees")).toBe(1);
  });

  test("an earmark tx that landed while its receipt was lost is recognised, not repeated", async () => {
    const t = await setup();
    t.chain.lostReceipt.sweepFees = true;
    await expect(t.sweeper.sweep(1, t.period)).rejects.toThrow(/receipt/);
    const s = await t.sweeper.sweep(1, t.period);
    expect(s.stage).toBe("swept");
    expect(t.chain.count("sweepFees")).toBe(1);
    expect(t.chain.bal(ROUTER)).toBe(3_000_000n);
  });

  test("forward waits while the fee USDC is held behind in-transit principal, then completes", async () => {
    const t = await setup();
    t.chain.adapter(ADAPTER).inTransit = 50_000_000n; // confirmed recall whose payout has not landed yet
    let s = await t.sweeper.sweep(1, t.period);
    expect(s.stage).toBe("paid");
    expect(t.chain.bal(ROUTER)).toBe(0n);
    t.chain.balances.set(ADAPTER.toLowerCase(), t.chain.bal(ADAPTER) + 50_000_000n); // the recall payout lands
    t.chain.thirdPartySweep(ADAPTER);
    expect(t.chain.bal(VAULT)).toBe(50_000_000n); // principal only; the earmarked fee stays
    await t.sweeper.auto();
    s = Object.values(t.sagas.get().fees)[0] as FeeSaga;
    expect(s.stage).toBe("swept");
    expect(t.chain.bal(ROUTER)).toBe(3_000_000n);
  });

  test("stricter adapter (requested withdrawals reserved): fees wait for the recall to be confirmed and land", async () => {
    const t = await setup();
    t.chain.strictReserve = true;
    const req = t.chain.requestWithdraw(ADAPTER, ACCOUNT.MM, 50_000_000n);
    expect((await t.sweeper.sweep(1, t.period)).stage).toBe("paid");
    expect(t.chain.bal(ROUTER)).toBe(0n);
    await t.chain.confirmWithdraw(ADAPTER, req.nonce);
    t.chain.balances.set(ADAPTER.toLowerCase(), t.chain.bal(ADAPTER) + 50_000_000n);
    t.chain.thirdPartySweep(ADAPTER);
    await t.sweeper.auto();
    expect(Object.values(t.sagas.get().fees)[0]?.stage).toBe("swept");
    expect([t.chain.bal(ROUTER), t.chain.bal(VAULT)]).toEqual([3_000_000n, 50_000_000n]);
  });

  test("a saga persisted by the old pay-before-earmark order is earmarked before anything else", async () => {
    const t = await setup();
    const key = `1:${t.period}`;
    t.sagas.get().fees[key] = { key, bookId: 1, adapter: ADAPTER, symbol: SYMBOL, period: t.period, amount: "3000000", stage: "paid", withdrawId: "1", payTx: "0x01", attempts: 0, createdAt: 0, updatedAt: 0 };
    t.chain.balances.set(ADAPTER.toLowerCase(), 3_000_000n); // the old order's transfer already landed, unearmarked
    const s = await t.sweeper.sweep(1, t.period);
    expect(s.stage).toBe("swept");
    expect(t.chain.count("sweepFees")).toBe(1);
    expect(t.chain.count("usdcTransfer")).toBe(0);
    expect(t.chain.bal(ROUTER)).toBe(3_000_000n);
  });

  test("a venue fee withdrawal that FAILED is requested again (new client ref), nothing paid twice", async () => {
    const t = await setup();
    t.chain.failNext.mint = "rpc down"; // stop after the venue request
    await expect(t.sweeper.sweep(1, t.period)).rejects.toThrow(/rpc/);
    let s = Object.values(t.sagas.get().fees)[0] as FeeSaga;
    expect(s.stage).toBe("requested");
    t.mock.venue.failWithdraw(Number(s.withdrawId), "test");
    s = await t.sweeper.sweep(1, t.period);
    expect([s.stage, s.reqSeq]).toEqual(["swept", 1]);
    expect(t.chain.count("sweepFees")).toBe(1);
    expect(t.chain.count("usdcTransfer")).toBe(1);
    expect(t.mock.venue.getAccount(BUILDER_ID).holding).toBe(0);
    expect(t.chain.bal(ROUTER)).toBe(3_000_000n);
  });

  test("a period already swept on-chain (e.g. by another instance) is never swept again", async () => {
    const t = await setup();
    t.chain.adapterLogList.push({ kind: "FeesSwept", adapter: ADAPTER, period: BigInt(t.period), amount: 3_000_000n, block: 2n, txHash: "0x99", logIndex: 1 });
    const s = await t.sweeper.sweep(1, t.period);
    expect(s.stage).toBe("swept");
    expect(t.chain.count("sweepFees")).toBe(0);
    expect(t.chain.count("operatorWithdraw")).toBe(0);
  });

  test("a period already recorded in settlements is skipped", async () => {
    const t = await setup();
    t.store.settlements.push({ bookId: 1, period: t.period, amountUsd: 3_000_000n, txHash: "0x77", logIndex: 0 });
    expect((await t.sweeper.sweep(1, t.period)).stage).toBe("swept");
    expect(t.chain.count("sweepFees")).toBe(0);
  });

  test("cap per period carries the excess to later periods", async () => {
    const t = await setup();
    t.chain.cap = 1_000_000n;
    expect((await t.sweeper.sweep(1, t.period)).amount).toBe("1000000");
    t.advance(300_000);
    expect((await t.sweeper.sweep(1, t.period + 300)).amount).toBe("1000000");
    expect(t.mock.venue.getAccount(BUILDER_ID).holding).toBe(1_000_000);
    expect(t.chain.bal(ROUTER)).toBe(2_000_000n);
  });

  test("auto mode sweeps the last completed period once settlements are in", async () => {
    const t = await setup();
    await t.sweeper.auto();
    expect(t.chain.count("sweepFees")).toBe(1);
    await t.sweeper.auto();
    expect(t.chain.count("sweepFees")).toBe(1);
  });
});
