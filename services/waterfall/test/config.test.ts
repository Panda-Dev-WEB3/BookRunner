import { describe, expect, test } from "bun:test";
import { WAD, usd } from "@bookrunner/shared";
import { loadWaterfallConfig } from "../src/index";

describe("waterfall config", () => {
  test("defaults (devnet)", () => {
    const c = loadWaterfallConfig({});
    expect(c.WATERFALL_EXPENSE_MODE).toBe("fixed");
    expect(c.WATERFALL_EXPENSES_USD).toBe(usd("1.00"));
    expect(c.WATERFALL_ETH_USD).toBe(0n);
    expect(c.WATERFALL_RETIRE_RECALL).toBe(true);
    expect(c.WATERFALL_LOG_LOOKBACK_BLOCKS).toBe(0n);
    expect(c.MARK_INTERVAL_SECONDS).toBe(300);
    expect(c.CHAIN_ID).toBe(31337);
  });

  test("parsing + validation", () => {
    const c = loadWaterfallConfig({ WATERFALL_EXPENSES_USD: "2.5", WATERFALL_ETH_USD: "3000.5", WATERFALL_RETIRE_RECALL: "0", WATERFALL_EXPENSE_MODE: "metered" });
    expect(c.WATERFALL_EXPENSES_USD).toBe(usd("2.5"));
    expect(c.WATERFALL_ETH_USD).toBe(3000n * WAD + WAD / 2n);
    expect(c.WATERFALL_RETIRE_RECALL).toBe(false);
    expect(() => loadWaterfallConfig({ WATERFALL_EXPENSES_USD: "-1" })).toThrow("invalid environment");
    expect(() => loadWaterfallConfig({ WATERFALL_EXPENSE_MODE: "free" })).toThrow("invalid environment");
  });
});
