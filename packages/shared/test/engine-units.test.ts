// Audit N-1: PoolEngine's market units off-chain (engineMath unitPriceWad / indexUnitWad / sharesOf), against the vectors
// of contracts/test/audit/ext2026/N1EngineSplit.t.sol (same integers, same rounding).
import { describe, expect, test } from "bun:test";
import { WAD, indexUnitWad, perSharePriceWad, sharesOf, unitFromRevert, unitPriceWad } from "../src/engineMath";

describe("market units across a split (audit N-1)", () => {
  test("unit price = per-share x shares per unit; unchanged without a split", () => {
    expect(unitPriceWad(100n * WAD, WAD, 5n)).toBe(100n * WAD);
    // 10:1 (test_N1_poc_shortBeforeSplit_gainsNothing): 10 per share x 10 shares per unit
    expect(unitPriceWad(10n * WAD, 10n * WAD, -1n)).toBe(100n * WAD);
    // 1:10 reverse: 1,000 per share x 0.1
    expect(unitPriceWad(1_000n * WAD, WAD / 10n, 1n)).toBe(100n * WAD);
  });

  test("rounding in the pool's favour: down while traders are net long, up while net short or flat", () => {
    // 1/3 share per unit after 10:1, 1:5, 3:2, 1:3 (test_N1_severalSplitsInARow_untouchedPositions)
    const px = 100_000_000_000_000_000_100n;
    const unit = 999_999_999_999_999_999n;
    expect(unitPriceWad(px, unit, 1n)).toBe(99_999_999_999_999_999_999n);
    expect(unitPriceWad(px, unit, -1n)).toBe(100n * WAD);
    expect(unitPriceWad(px, unit, 0n)).toBe(100n * WAD);
  });

  test("index unit at a component split = PoolEngineUnit (test_N1_indexMarket_oneComponentSplits vector)", () => {
    // RHX5 = 0.6 NVDA + 0.4 TSLA; TSLA splits 3:1; the round prints NVDA 105, TSLA 29: L = 74.6
    const level = (105n * WAD * 6000n + 29n * WAD * 4000n) / 10_000n;
    const comps = [
      { priceWad: 105n * WAD, weightBps: 6000n, appliedWad: WAD, factorWad: WAD },
      { priceWad: 29n * WAD, weightBps: 4000n, appliedWad: WAD, factorWad: 3n * WAD },
    ];
    expect(indexUnitWad(WAD, level, comps, -15n * WAD)).toBe(1_310_991_957_104_557_641n); // ceil: traders net short
    expect(indexUnitWad(WAD, level, comps, 15n * WAD)).toBe(1_310_991_957_104_557_640n);
    // the value of a unit is conserved at the round's prices: 74.6 x R = 97.8 = 0.6 x 105 + 0.4 x 87 (+19 wei of
    // rounding in the pool's favour: traders are net short, the unit price rounds up)
    expect(unitPriceWad(level, 1_310_991_957_104_557_641n, -1n)).toBe(97_800_000_000_000_000_019n);
    // nothing to apply: unchanged; a component not seen yet (applied 0) counts nothing
    expect(indexUnitWad(WAD, level, [{ ...comps[1]!, appliedWad: 3n * WAD }], 1n)).toBe(WAD);
    expect(indexUnitWad(WAD, level, [{ ...comps[1]!, appliedWad: 0n }], 1n)).toBe(WAD);
  });

  test("display conversions and the unitAt revert names", () => {
    expect(sharesOf(100n * WAD, 10n * WAD)).toBe(1_000n * WAD);
    expect(perSharePriceWad(100n * WAD, 10n * WAD)).toBe(10n * WAD);
    expect(unitFromRevert("SplitUnrecorded")).toEqual({ kind: "unrecorded" });
    expect(unitFromRevert("IndexSnapshot")).toEqual({ kind: "pending" });
    expect(unitFromRevert("PriceBeforeSplit")).toEqual({ kind: "pending" });
    expect(unitFromRevert("StalePrice")).toBeUndefined();
  });
});
