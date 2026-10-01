import { describe, expect, test } from "bun:test";
import { completedPeriods, periodReady, planFeeSweep, type SettlementRow } from "../src/domain/fees";
import { keyFromSecret } from "../src/orderly/auth";
import { BookRegistry } from "../src/worker/books";
import { FeeSweeper } from "../src/worker/fees";
import { loadOrCreateBuilderKey, Provisioner } from "../src/worker/provision";
import { ADAPTER, BUILDER_ID, IF_ID, makeCtx, MM_ID, SYMBOL, trackedBook } from "./helpers";

const row = (period: number, amount: bigint, symbol = SYMBOL): SettlementRow => ({ id: `${symbol}-${period}`, symbol, amountUsd: amount, period, ts: period * 1000 });

describe("fee sweep planning (pure)", () => {
  test("cumulative pending minus swept and in-flight, capped per period", () => {
    const settlements = [row(300, 5_000_000n), row(600, 7_000_000n), row(900, 11_000_000n), row(600, 99n, "PERP_TSLA_USDC")];
    expect(planFeeSweep({ symbol: SYMBOL, period: 600, settlements, sweptTotalUsd: 0n, inFlightUsd: 0n, capUsd: 10n ** 12n })).toEqual({ amount: 12_000_000n, settledUpTo: 12_000_000n, pending: 12_000_000n, carried: 0n });
    expect(planFeeSweep({ symbol: SYMBOL, period: 900, settlements, sweptTotalUsd: 12_000_000n, inFlightUsd: 0n, capUsd: 4_000_000n })).toEqual({ amount: 4_000_000n, settledUpTo: 23_000_000n, pending: 11_000_000n, carried: 7_000_000n });
    expect(planFeeSweep({ symbol: SYMBOL, period: 900, settlements, sweptTotalUsd: 20_000_000n, inFlightUsd: 3_000_000n, capUsd: 10n ** 12n }).amount).toBe(0n);
    expect(planFeeSweep({ symbol: SYMBOL, period: 900, settlements, sweptTotalUsd: 30_000_000n, inFlightUsd: 0n, capUsd: 10n ** 12n }).pending).toBe(0n);
  });

  test("periods and readiness", () => {
    expect(completedPeriods(1000, 300, 0)).toEqual([300, 600, 900]);
    expect(completedPeriods(1000, 300, 600)).toEqual([900]);
    expect(periodReady({ period: 900, nowSec: 905, graceSec: 20, settlements: [], symbol: SYMBOL })).toBe(false);
    expect(periodReady({ period: 900, nowSec: 921, graceSec: 20, settlements: [], symbol: SYMBOL })).toBe(true);
    expect(periodReady({ period: 900, nowSec: 901, graceSec: 20, settlements: [row(900, 1n)], symbol: SYMBOL })).toBe(true);
  });
});

describe("FeeSweeper (mock venue + fake chain)", () => {
  async function setup() {
    let now = 1_700_000_400_000; // inside the period ending 1_700_000_400 + ...
    const t = await makeCtx({ now: () => now });
    t.chain.books = [trackedBook()];
    const reg = new BookRegistry(t.ctx);
    await reg.refresh();
    await new Provisioner(t.ctx, await loadOrCreateBuilderKey(t.keys, BUILDER_ID, undefined, 86_400_000, keyFromSecret)).ensure(reg.list()[0] as ReturnType<typeof trackedBook>);
    const v = t.mock.venue;
    v.credit(IF_ID, 25_000_000_000);
    v.credit(MM_ID, 75_000_000_000);
    v.setPrice("NVDA", 200, false);
    // 10,000 notional of taker flow -> 6.00 base taker fee -> 3.00 builder share
    v.placeOrder({ accountId: MM_ID, keyId: null }, { symbol: SYMBOL, order_type: "LIMIT", side: "SELL", order_price: 200, order_quantity: 50 });
    v.externalTaker(SYMBOL, "BUY", 50);
    const period = Math.floor(now / 1000 / 300) * 300 + 300;
    now = period * 1000 + 1000; // period complete
    v.settleDue();
    return { ...t, reg, sweeper: new FeeSweeper(t.ctx, reg), period, advance: (ms: number) => (now += ms) };
  }

  test("withdraws the builder share to the adapter and sweeps it exactly once per period", async () => {
    const t = await setup();
    const s = await t.sweeper.sweep(1, t.period);
    expect(s.stage).toBe("swept");
    expect(s.amount).toBe("3000000");
    expect(t.chain.calls.filter((c) => c.fn === "sweepFees").map((c) => c.args)).toEqual([[ADAPTER, BigInt(t.period), 3_000_000n]]);
    expect(t.chain.count("creditFees")).toBe(1);
    expect(t.chain.count("operatorWithdraw")).toBe(1);
    expect(t.mock.venue.getAccount(BUILDER_ID).holding).toBe(0);
    expect(t.store.settlements).toHaveLength(1);
    // idempotent: same period again (job replay, auto loop) -> no second sweep
    await t.sweeper.sweep(1, t.period);
    await t.sweeper.auto();
    expect(t.chain.count("sweepFees")).toBe(1);
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

  test("resumes after a failed sweepFees without withdrawing twice; next period sweeps only the remainder", async () => {
    const t = await setup();
    t.chain.failNext.sweepFees = "nonce too low";
    await expect(t.sweeper.sweep(1, t.period)).rejects.toThrow(/nonce/);
    expect(t.chain.count("operatorWithdraw")).toBe(1);
    const s = await t.sweeper.sweep(1, t.period);
    expect(s.stage).toBe("swept");
    expect(t.chain.count("operatorWithdraw")).toBe(1);
    expect(t.chain.count("sweepFees")).toBe(1);
    // nothing new settled -> next period is skipped (no chain calls)
    t.advance(300_000);
    expect((await t.sweeper.sweep(1, t.period + 300)).stage).toBe("skipped");
    expect(t.chain.count("sweepFees")).toBe(1);
  });

  test("cap per period carries the excess to later periods", async () => {
    const t = await setup();
    t.chain.cap = 1_000_000n;
    expect((await t.sweeper.sweep(1, t.period)).amount).toBe("1000000");
    t.advance(300_000);
    expect((await t.sweeper.sweep(1, t.period + 300)).amount).toBe("1000000");
    expect(t.mock.venue.getAccount(BUILDER_ID).holding).toBe(1_000_000);
  });

  test("auto mode sweeps the last completed period once settlements are in", async () => {
    const t = await setup();
    await t.sweeper.auto();
    expect(t.chain.count("sweepFees")).toBe(1);
    await t.sweeper.auto();
    expect(t.chain.count("sweepFees")).toBe(1);
  });
});
