import { describe, expect, test } from "bun:test";
import { LIVE_SIZES, MOCK_SIZES, launchBooks, launchSizes, settlementNeeds, transferPlan } from "./launch-plan";

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
