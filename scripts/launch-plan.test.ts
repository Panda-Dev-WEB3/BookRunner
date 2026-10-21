import { describe, expect, test } from "bun:test";
import { COMMIT_SHARES, LIVE_SIZES, MOCK_SIZES, commitPlan, launchBooks, launchSizes, poolSeedUsd, raiseOf, settlementNeeds, transferPlan } from "./launch-plan";

const testnetMin = (v: 0 | 1) => (v === 0 ? 101 : 10_000);

describe("launch plan (mock venue vs live Orderly rehearsal, VERIFY O17)", () => {
  test("books: all three on the mock venue, the Orderly books only on the live venue; LAUNCH_BOOKS overrides", () => {
    expect(launchBooks(false, {})).toEqual(["NVDA", "TSLA", "RHX5"]);
    expect(launchBooks(true, {})).toEqual(["NVDA", "TSLA"]);
    expect(launchBooks(true, { LAUNCH_BOOKS: "nvda, RHX5,NVDA" })).toEqual(["NVDA", "RHX5"]);
    expect(() => launchBooks(true, { LAUNCH_BOOKS: "AAPL" })).toThrow("unknown book AAPL");
  });

  test("sizes: demo sizes unchanged on the mock venue; rehearsal sizes live; IF never below venueMinIf", () => {
    expect(launchSizes(false, ["NVDA", "TSLA", "RHX5"], (v) => (v === 0 ? 25_001 : 10_000), {})).toEqual([
      { name: "NVDA", ...MOCK_SIZES.NVDA },
      { name: "TSLA", ...MOCK_SIZES.TSLA },
      { name: "RHX5", ...MOCK_SIZES.RHX5 },
    ]);
    const live = launchSizes(true, ["NVDA", "TSLA"], testnetMin, {});
    expect(live).toEqual([{ name: "NVDA", ...LIVE_SIZES }, { name: "TSLA", ...LIVE_SIZES }]);
    expect(live[0]!.ifUsd).toBeGreaterThan(100); // Orderly testnet: IF strictly above 100 USDG per market
    // overrides, raised to the venue minimum (RHX5 on the PoolEngine: 10,000)
    expect(launchSizes(true, ["NVDA", "RHX5"], testnetMin, { LAUNCH_IF_USD: "50", LAUNCH_MM_USD: "200" })).toEqual([
      { name: "NVDA", ifUsd: 101, mmUsd: 200, maxInventoryUsd: 250 },
      { name: "RHX5", ifUsd: 10_000, mmUsd: 200, maxInventoryUsd: 250 },
    ]);
    expect(() => launchSizes(true, ["NVDA"], testnetMin, { LAUNCH_MM_USD: "-1" })).toThrow("LAUNCH_MM_USD");
    // whole USD only: launchBook works in whole USD (a fractional amount would be truncated after the funding check)
    expect(() => launchSizes(true, ["NVDA"], testnetMin, { LAUNCH_IF_USD: "150.5" })).toThrow("not a positive whole number of USD");
    expect(() => launchSizes(true, ["NVDA"], testnetMin, { LAUNCH_MAX_INVENTORY_USD: "1e-3" })).toThrow("LAUNCH_MAX_INVENTORY_USD");
  });

  test("commit plan: the one source of the subscription amounts (launchBook and the funding check)", () => {
    expect(commitPlan(650)).toEqual([
      { who: "sponsor", tranche: "junior", usd: 78 },
      { who: "a2", tranche: "junior", usd: 195 },
      { who: "a0", tranche: "senior", usd: 325 },
      { who: "a1", tranche: "senior", usd: 260 },
    ]);
    expect(commitPlan(1000).map((c) => c.usd)).toEqual([COMMIT_SHARES.sponsorJunior, COMMIT_SHARES.a2Junior, COMMIT_SHARES.a0Senior, COMMIT_SHARES.a1Senior].map((x) => x * 1000));
    const needs = settlementNeeds([{ name: "NVDA", ifUsd: 150, mmUsd: 500, maxInventoryUsd: 250 }], 0);
    for (const c of commitPlan(650)) expect(needs[c.who]).toBe(c.usd);
  });

  test("a resumed book is never funded twice: its fee and the commits already made are left out", () => {
    const sizes = launchSizes(true, ["NVDA", "TSLA"], testnetMin, {});
    // NVDA: charter filed (fee paid), sponsor + a2 committed; TSLA untouched
    const needs = settlementNeeds(sizes, 10, { NVDA: { feePaid: true, done: new Set(["sponsor", "a2"] as const) } });
    expect(needs).toEqual({ sponsor: 10 + 78, a0: 2 * 325, a1: 2 * 260, a2: 195 });
    // window already closed: nothing more for that book
    expect(settlementNeeds(sizes.slice(0, 1), 10, { NVDA: { feePaid: true, done: new Set(["sponsor", "a0", "a1", "a2"] as const) } })).toEqual({ sponsor: 0, a0: 0, a1: 0, a2: 0 });
  });

  test("settlement needs and the deployer's transfers (only the gaps)", () => {
    const sizes = launchSizes(true, ["NVDA", "TSLA"], testnetMin, {});
    const needs = settlementNeeds(sizes, 10);
    // raise 650 per book: sponsor 12% + fee, a2 30%, a0 50%, a1 40%
    expect(needs).toEqual({ sponsor: 2 * (78 + 10), a0: 2 * 325, a1: 2 * 260, a2: 2 * 195 });
    const plan = transferPlan(needs, { sponsor: 176_000_000n, a0: 100_000_000n, a1: 0n, a2: 500_000_000n });
    expect(plan.transfers).toEqual([["a0", 550_000_000n], ["a1", 520_000_000n]]);
    expect(plan.total).toBe(1_070_000_000n);
  });
});

describe("insurance pool launch (2026-10)", () => {
  const books = (ifFromPool: boolean) => (["NVDA", "TSLA", "RHX5"] as const).map((name) => ({ name, ...MOCK_SIZES[name], ifFromPool }));

  test("a pool-funded book's window raises only the MM inventory; settlement needs follow", () => {
    expect(raiseOf({ ifUsd: 30_000, mmUsd: 75_000, ifFromPool: true })).toBe(75_000);
    expect(raiseOf({ ifUsd: 30_000, mmUsd: 75_000 })).toBe(105_000);
    const pooled = settlementNeeds([{ name: "NVDA", ifUsd: 150, mmUsd: 500, maxInventoryUsd: 250, ifFromPool: true }], 0);
    expect(pooled.a0).toBe(Math.round(500 * COMMIT_SHARES.a0Senior));
  });

  test("the first-loss seed funds every IF at window close: per-market cap 30% and the 80% above the buffer, +10%", () => {
    // mock: 3 x 30,000 -> max(30,000 / 0.3, 90,000 / 0.8) = 112,500, +10% = 123,750
    expect(poolSeedUsd(books(true))).toBe(123_750);
    const seed = poolSeedUsd(books(true));
    for (const b of books(true)) expect(b.ifUsd).toBeLessThanOrEqual(seed * 0.3);
    expect(books(true).reduce((a, b) => a + b.ifUsd, 0)).toBeLessThanOrEqual(seed * 0.8);
    // live rehearsal: two Orderly books at IF 150 -> max(500, 375) * 1.1
    expect(poolSeedUsd([{ name: "NVDA", ...LIVE_SIZES, ifFromPool: true }, { name: "TSLA", ...LIVE_SIZES, ifFromPool: true }])).toBe(550);
    expect(poolSeedUsd(books(false))).toBe(0);
  });
});
