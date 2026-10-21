import { describe, expect, test } from "bun:test";
import { DEFAULT_IF_FROM_POOL, MAX_PREMIUM_BPS, poolCharterReason } from "../src/insurancePool";

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

  test("new charters default to a pool-funded IF", () => {
    expect(DEFAULT_IF_FROM_POOL).toBe(true);
  });
});
