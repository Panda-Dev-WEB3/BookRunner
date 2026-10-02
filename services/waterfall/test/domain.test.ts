import { describe, expect, test } from "bun:test";
import { ACCOUNT, WAD, splitDistribution, usd } from "@bookrunner/shared";
import {
  Cooldowns,
  amountsToSplit,
  canFinalizeRetirement,
  conserves,
  expensesRequested,
  gasCostUsd,
  GasMeter,
  isNewPeriod,
  nextMarkPeriodEnd,
  parityCheck,
  periodEndAt,
  planRecall,
  previewDistribution,
  scanRanges,
  settlesUpToIndex,
  shouldCloseWindow,
  shouldFundClaims,
  splitMismatches,
  usd6,
  wad18,
  type RecallInput,
} from "../src/index";
import { looksLikeAlready } from "../src/kit/tx";

describe("period math", () => {
  test("label = floor(now / interval) * interval", () => {
    expect(periodEndAt(1_790_000_100, 300)).toBe(1_790_000_100);
    expect(periodEndAt(1_790_000_399, 300)).toBe(1_790_000_100);
    expect(periodEndAt(1_790_000_400, 300)).toBe(1_790_000_400);
    expect(periodEndAt(86_399, 86_400)).toBe(0);
    expect(() => periodEndAt(1, 0)).toThrow();
  });

  test("next mark period and settled bucket index", () => {
    // latest closed period P = 1_790_000_100; not yet marked -> next mark is P
    expect(nextMarkPeriodEnd(1_790_000_150, 300, 1_789_999_800)).toBe(1_790_000_100);
    // already marked P -> next is P + interval
    expect(nextMarkPeriodEnd(1_790_000_150, 300, 1_790_000_100)).toBe(1_790_000_400);
    expect(settlesUpToIndex(1_790_000_100, 300)).toBe(5_966_667n);
    expect(isNewPeriod(600, undefined)).toBe(true);
    expect(isNewPeriod(600, 600)).toBe(false);
    expect(isNewPeriod(900, 600)).toBe(true);
    expect(isNewPeriod(0, undefined)).toBe(false);
  });

  test("log scan ranges", () => {
    expect(scanRanges({ fromBlock: 0n, toBlock: 25n, chunk: 10n })).toEqual([
      [0n, 9n],
      [10n, 19n],
      [20n, 25n],
    ]);
    expect(scanRanges({ fromBlock: 5n, toBlock: 4n, chunk: 10n })).toEqual([]);
  });
});

describe("distribution split (normative splitDistribution)", () => {
  const params = { expenseCapBps: 2000n, carryBps: 1000n, seniorHurdleBps: 6000n, seniorSupply: 70n, juniorSupply: 30n };

  test("preview equals splitDistribution and conserves", () => {
    const p = previewDistribution({ ...params, gross: usd("1000"), expensesRequested: usd("1") });
    expect(p).toEqual(splitDistribution({ ...params, gross: usd("1000"), expensesRequested: usd("1") }));
    expect(p).toEqual({ gross: usd("1000"), expenses: usd("1"), carry: usd("99.9"), senior: usd("539.46"), junior: usd("359.64") });
    expect(conserves(p)).toBe(true);
  });

  test("expenses capped on-chain at expenseCapBps of gross", () => {
    const p = previewDistribution({ ...params, gross: usd("2"), expensesRequested: usd("1") });
    expect(p.expenses).toBe(usd("0.4"));
    expect(previewDistribution({ ...params, gross: 0n, expensesRequested: usd("1") })).toEqual({ gross: 0n, expenses: 0n, carry: 0n, senior: 0n, junior: 0n });
  });

  test("event decoding and parity check", () => {
    const actual = amountsToSplit([usd("1000"), usd("1"), usd("99.9"), usd("539.46"), usd("359.64")]);
    expect(parityCheck(actual, params)).toEqual([]);
    const broken = { ...actual, senior: actual.senior + 1n, junior: actual.junior - 1n };
    expect(parityCheck(broken, params)).toEqual(["senior", "junior"]);
    expect(splitMismatches(actual, { ...actual, gross: 1n })).toEqual(["gross"]);
    expect(() => amountsToSplit([1n, 2n])).toThrow();
  });
});

describe("expenses", () => {
  test("fixed vs metered", () => {
    const base = { fixedUsd: usd("1.00"), oracleCostUsd: usd("0.50"), ethUsdWad: 3000n * WAD };
    expect(expensesRequested({ ...base, mode: "fixed" }, 10n ** 18n)).toBe(usd("1.00"));
    // 0.001 ETH of gas at 3000 USD = 3 USD + 0.50 oracle
    expect(gasCostUsd(10n ** 15n, 3000n * WAD)).toBe(usd("3"));
    expect(expensesRequested({ ...base, mode: "metered" }, 10n ** 15n)).toBe(usd("3.5"));
  });

  test("gas meter per book; reset after distribution", () => {
    const m = new GasMeter();
    m.add(1, 5n);
    m.add(1, 7n);
    m.add(undefined, 100n);
    m.add(2, 1n);
    expect(m.pending(1)).toBe(12n);
    m.reset(1);
    expect(m.pending(1)).toBe(0n);
    expect(m.pending(2)).toBe(1n);
  });
});

describe("recall planning", () => {
  const base: RecallInput = {
    state: "Live",
    dueShares: { senior: 0n, junior: 0n },
    sharePriceWad: { senior: WAD, junior: WAD },
    unfundedClaims: 0n,
    vaultIdle: usd("1000"),
    inTransit: 0n,
    pendingWithdraw: 0n,
    mmWithdrawable: null,
    insuranceEquity: usd("25000"),
    marginEquity: usd("75000"),
    netExposure: usd("5000"),
    bufferBps: 0n,
    minRecallUsd: usd("1"),
    flatThresholdUsd: usd("1"),
    recallAllWhenRetiring: true,
  };

  test("no shortfall -> no recall", () => {
    const p = planRecall({ ...base, dueShares: { senior: usd("400"), junior: usd("500") } });
    expect(p.shortfall).toBe(0n);
    expect(p.recalls).toEqual([]);
  });

  test("shortfall recalled from MM at share prices, with buffer and unfunded claims", () => {
    const p = planRecall({
      ...base,
      dueShares: { senior: usd("2000"), junior: usd("1000") },
      sharePriceWad: { senior: WAD, junior: (WAD * 9n) / 10n }, // junior at 0.9
      unfundedClaims: usd("100"),
      bufferBps: 100n,
    });
    // due = 2000 + 900 = 2900; need = 2900 + 29 + 100 = 3029; available = 1000
    expect(p.dueAssets).toBe(usd("2900"));
    expect(p.need).toBe(usd("3029"));
    expect(p.recalls).toEqual([{ account: ACCOUNT.MM, amount: usd("2029"), reason: "redemptions" }]);
    expect(p.uncovered).toBe(0n);
  });

  test("withdrawals in flight count as available (no double recall)", () => {
    const p = planRecall({ ...base, dueShares: { senior: usd("3000"), junior: 0n }, inTransit: usd("2000") });
    expect(p.shortfall).toBe(0n);
    expect(p.recalls).toEqual([]);
  });

  test("MM capacity caps the recall; remainder uncovered", () => {
    const p = planRecall({ ...base, dueShares: { senior: usd("10000"), junior: 0n }, marginEquity: usd("4000") });
    expect(p.recalls).toEqual([{ account: ACCOUNT.MM, amount: usd("4000"), reason: "redemptions" }]);
    expect(p.uncovered).toBe(usd("5000"));
    expect(planRecall({ ...base, dueShares: { senior: usd("10000"), junior: 0n }, marginEquity: -5n }).recalls).toEqual([]);
  });

  test("dust below the minimum is not recalled", () => {
    expect(planRecall({ ...base, dueShares: { senior: usd("1000.5"), junior: 0n } }).recalls).toEqual([]);
  });

  test("retiring + flat: recall all venue capital once nothing is in flight", () => {
    const p = planRecall({ ...base, state: "Retiring", netExposure: 0n });
    expect(p.recalls).toEqual([
      { account: ACCOUNT.MM, amount: usd("75000"), reason: "retire" },
      { account: ACCOUNT.IF, amount: usd("25000"), reason: "retire" },
    ]);
    expect(planRecall({ ...base, state: "Retiring", netExposure: 0n, inTransit: 1n }).recalls).toEqual([]);
    // still exposed: only redemption-driven MM recalls
    expect(planRecall({ ...base, state: "Retiring" }).recalls).toEqual([]);
  });

  test("requested-but-unconfirmed withdrawals count as in flight: no re-recall every cooldown", () => {
    // 20k due, idle 1k: the first tick recalls 19k of MM
    const first = planRecall({ ...base, dueShares: { senior: usd("20000"), junior: 0n } });
    expect(first.recalls).toEqual([{ account: ACCOUNT.MM, amount: usd("19000"), reason: "redemptions" }]);
    // Orderly has not confirmed yet (pendingWithdrawUsd), the reporter already shows the lower margin
    const again = planRecall({ ...base, dueShares: { senior: usd("20000"), junior: 0n }, pendingWithdraw: usd("19000"), marginEquity: usd("56000") });
    expect(again.available).toBe(usd("20000"));
    expect(again.recalls).toEqual([]);
    // the Retiring recall-all waits for requested withdrawals too
    expect(planRecall({ ...base, state: "Retiring", netExposure: 0n, pendingWithdraw: 1n }).recalls).toEqual([]);
  });

  test("engine MM recall capped at what withdrawLiquidity accepts (pool cash, required margin)", async () => {
    // pool cash 100k, equity ~100,037, required 7,400 (traders net long 74k): 98k due, idle ~0
    const { engineWithdrawableUsd } = await import("../src/domain/recall");
    const withdrawable = usd("92266"); // equity - required - (5% of required + 1 USD) buffer
    expect(engineWithdrawableUsd(usd("100000"), usd("100037"), usd("7400"))).toBe(withdrawable);
    const p = planRecall({ ...base, vaultIdle: 0n, dueShares: { senior: usd("98000"), junior: 0n }, marginEquity: usd("100037"), mmWithdrawable: withdrawable });
    expect(p.recalls).toEqual([{ account: ACCOUNT.MM, amount: withdrawable, reason: "redemptions" }]);
    expect(p.uncovered).toBe(usd("98000") - withdrawable);
    // nothing withdrawable -> no reverting recall
    expect(planRecall({ ...base, vaultIdle: 0n, dueShares: { senior: usd("98000"), junior: 0n }, mmWithdrawable: 0n }).recalls).toEqual([]);
    // a flat pool needs no buffer: the whole cash is withdrawable
    expect(engineWithdrawableUsd(usd("50000"), usd("50000"), 0n)).toBe(usd("50000"));
    expect(engineWithdrawableUsd(usd("50000"), usd("1000"), usd("1000"))).toBe(0n);
  });

  test("retiring + flat: sub-dollar venue residue is still recalled (final mark needs deployedValueUsd == 0)", () => {
    const p = planRecall({ ...base, state: "Retiring", netExposure: 0n, marginEquity: usd("0.43"), insuranceEquity: usd("0.2") });
    expect(p.recalls).toEqual([
      { account: ACCOUNT.MM, amount: usd("0.43"), reason: "retire" },
      { account: ACCOUNT.IF, amount: usd("0.2"), reason: "retire" },
    ]);
    // engine: capped by withdrawable
    const e = planRecall({ ...base, state: "Retiring", netExposure: 0n, marginEquity: usd("500"), mmWithdrawable: usd("400"), insuranceEquity: 0n });
    expect(e.recalls).toEqual([{ account: ACCOUNT.MM, amount: usd("400"), reason: "retire" }]);
  });

  test("non-live books never recall", () => {
    expect(planRecall({ ...base, state: "Subscription", dueShares: { senior: usd("9999"), junior: 0n } }).recalls).toEqual([]);
  });
});

describe("keeper decisions", () => {
  test("closeWindow / fundClaims / finalizeRetirement", () => {
    expect(shouldCloseWindow("Subscription", 100, 99)).toBe(false);
    expect(shouldCloseWindow("Subscription", 100, 100)).toBe(true);
    expect(shouldCloseWindow("Live", 100, 200)).toBe(false);
    expect(shouldFundClaims("Live", 1n, 1n)).toBe(true);
    expect(shouldFundClaims("Retired", 1n, 1n)).toBe(true);
    expect(shouldFundClaims("Live", 1n, 0n)).toBe(false);
    expect(shouldFundClaims("Cancelled", 1n, 1n)).toBe(false);
    expect(canFinalizeRetirement("Retiring", { markId: 3n, applied: true, deployedValueUsd: 0n })).toBe(true);
    expect(canFinalizeRetirement("Retiring", { markId: 3n, applied: false, deployedValueUsd: 0n })).toBe(false);
    expect(canFinalizeRetirement("Retiring", { markId: 3n, applied: true, deployedValueUsd: 1n })).toBe(false);
    expect(canFinalizeRetirement("Live", { markId: 3n, applied: true, deployedValueUsd: 0n })).toBe(false);
    expect(canFinalizeRetirement("Retiring", null)).toBe(false);
  });

  test("cooldowns", () => {
    let now = 0;
    const c = new Cooldowns(() => now);
    expect(c.ready("a")).toBe(true);
    c.hold("a", 100);
    expect(c.ready("a")).toBe(false);
    now = 100;
    expect(c.ready("a")).toBe(true);
  });
});

describe("formatting / revert classification", () => {
  test("usd6 and wad18", () => {
    expect(usd6(usd("1234.5"))).toBe("1234.500000");
    expect(usd6(-usd("0.000001"))).toBe("-0.000001");
    expect(usd6(0n)).toBe("0.000000");
    expect(wad18(WAD + 5n)).toBe("1.000000000000000005");
    expect(wad18(WAD)).toBe("1.000000000000000000");
  });

  test("already-style reverts", () => {
    expect(looksLikeAlready({ message: "execution reverted", reason: "already distributed" })).toBe(true);
    expect(looksLikeAlready({ message: "execution reverted", errorName: "PeriodAlreadyDistributed" })).toBe(true);
    expect(looksLikeAlready({ message: "insufficient funds for gas" })).toBe(false);
  });
});
