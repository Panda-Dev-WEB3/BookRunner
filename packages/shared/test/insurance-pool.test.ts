import { describe, expect, test } from "bun:test";
import { DEFAULT_IF_FROM_POOL, DEFAULT_MIN_OWN_CAPITAL_BPS, MAX_PREMIUM_BPS, poolCharterReason } from "../src/insurancePool";

// Same table as contracts/test/gov/MarketCharter.t.sol test_validate_insurancePool (CharterRules.poolReason).
describe("poolCharterReason (MarketCharter BAD_PREMIUM / NO_POOL)", () => {
  test("a book-funded IF pays no premium", () => {
    expect(poolCharterReason({ ifFromPool: false, premiumBps: 0 }, false)).toBeNull();
    expect(poolCharterReason({ ifFromPool: false, premiumBps: 1 }, true)).toBe("BAD_PREMIUM");
  });

  test("a pool-funded IF needs a pool and a premium <= 50%", () => {
    expect(poolCharterReason({ ifFromPool: true, premiumBps: 0 }, false)).toBe("NO_POOL");
    expect(poolCharterReason({ ifFromPool: true, premiumBps: 0 }, true)).toBeNull();
    expect(poolCharterReason({ ifFromPool: true, premiumBps: MAX_PREMIUM_BPS }, true)).toBeNull();
    expect(poolCharterReason({ ifFromPool: true, premiumBps: MAX_PREMIUM_BPS + 1 }, true)).toBe("BAD_PREMIUM");
    expect(poolCharterReason({ ifFromPool: true, premiumBps: MAX_PREMIUM_BPS + 1 }, false)).toBe("BAD_PREMIUM");
  });

  // contracts/test/gov/MarketCharter.t.sol test_validate_poolMinimumOwnCapital (pool audit 2026-10-23 B-M2)
  test("a pool-funded IF needs an MM inventory of at least the pool's minimum own capital (50%)", () => {
    const c = { ifFromPool: true, premiumBps: 0, ifTargetUsd: 30_000_000_000n, mmInventoryUsd: 15_000_000_000n };
    expect(poolCharterReason(c, true)).toBeNull();
    expect(poolCharterReason({ ...c, mmInventoryUsd: c.mmInventoryUsd - 1n }, true)).toBe("UNDERCAPITALISED");
    expect(poolCharterReason({ ...c, mmInventoryUsd: 0n }, true, 0)).toBeNull();
    expect(poolCharterReason({ ...c, mmInventoryUsd: 0n, ifFromPool: false }, true)).toBeNull();
    expect(DEFAULT_MIN_OWN_CAPITAL_BPS).toBe(5000);
  });

  test("new charters default to a pool-funded IF", () => {
    expect(DEFAULT_IF_FROM_POOL).toBe(true);
  });
});
