// Audit M-2 split window (review I-1 / I-4): the multiplier in force at a price's basis, from the token's events.
import { describe, expect, test } from "bun:test";
import { WAD, inSplitWindow, multiplierAtBasis, priceBasisAt, readMultiplierAtBasis, valueAtMultiplier } from "../src/index";

const FRI = 1_000n;
const SAT = 2_000n;
const NOW = 3_000n;

describe("split window helpers", () => {
  test("basis: live publishedAt, held lastLiveAt; window when the change is after the basis", () => {
    expect(priceBasisAt({ held: false, publishedAt: 5n, lastLiveAt: 1n })).toBe(5n);
    expect(priceBasisAt({ held: true, publishedAt: 5n, lastLiveAt: 1n })).toBe(1n);
    expect(inSplitWindow({ multiplierChangedAt: SAT, priceBasisAt: FRI })).toBe(true);
    expect(inSplitWindow({ multiplierChangedAt: SAT, priceBasisAt: SAT })).toBe(false);
  });

  test("valueAtMultiplier mirrors the registry (single floor)", () => {
    expect(valueAtMultiplier(50n * WAD, WAD, 190n * WAD, 18)).toBe(9_500_000_000n);
    expect(valueAtMultiplier(50n * WAD, 0n, 190n * WAD, 18)).toBe(0n);
  });

  test("the split staged Thursday, active Saturday: the old multiplier at Friday's basis", () => {
    const ev = [{ oldMultiplier: WAD, newMultiplier: 10n * WAD, effectiveAt: SAT }];
    expect(multiplierAtBasis(ev, FRI, NOW)).toEqual({ multiplierWad: WAD, firstChangeAt: SAT });
    expect(multiplierAtBasis(ev, FRI, SAT - 1n)).toBeNull(); // not active yet
    expect(multiplierAtBasis(ev, SAT, NOW)).toBeNull(); // no change after the basis
  });

  test("a follow-up update staged after the split (review I-2) keeps the split as the first activation", () => {
    const ev = [
      { oldMultiplier: WAD, newMultiplier: 10n * WAD, effectiveAt: SAT },
      { oldMultiplier: 10n * WAD, newMultiplier: 10_010n * 10n ** 15n, effectiveAt: NOW + 86_400n },
    ];
    expect(multiplierAtBasis(ev, FRI, NOW)).toEqual({ multiplierWad: WAD, firstChangeAt: SAT });
  });

  test("an update overwritten before it took effect never activated", () => {
    const ev = [
      { oldMultiplier: WAD, newMultiplier: 10n * WAD, effectiveAt: SAT }, // overwritten (next.old == this.old)
      { oldMultiplier: WAD, newMultiplier: 2n * WAD, effectiveAt: SAT + 10n },
    ];
    expect(multiplierAtBasis(ev, FRI, NOW)).toEqual({ multiplierWad: WAD, firstChangeAt: SAT + 10n });
  });

  test("a dividend update Saturday after the basis: the pre-dividend multiplier", () => {
    const ev = [{ oldMultiplier: 1_001n * 10n ** 15n, newMultiplier: 1_002n * 10n ** 15n, effectiveAt: SAT }];
    expect(multiplierAtBasis(ev, FRI, NOW)?.multiplierWad).toBe(1_001n * 10n ** 15n);
  });

  test("readMultiplierAtBasis: decodes logs; a failed read is unknown (null)", async () => {
    const pub = { getLogs: async () => [{ args: { oldMultiplier: WAD, newMultiplier: 10n * WAD, effectiveAtTimestamp: SAT } }] };
    expect(await readMultiplierAtBasis(pub as never, "0x00000000000000000000000000000000000000d1", { basisAt: FRI, nowSec: NOW, blockNumber: 100n })).toEqual({
      multiplierWad: WAD,
      firstChangeAt: SAT,
    });
    const broken = {
      getLogs: async () => {
        throw new Error("range too large");
      },
    };
    expect(await readMultiplierAtBasis(broken as never, "0x00000000000000000000000000000000000000d1", { basisAt: FRI, nowSec: NOW, blockNumber: 100n })).toBeNull();
  });
});

describe("readMultiplierAtBasis paging", () => {
  test("pages the lookback in bounded ranges (a provider range cap is never hit) and finds an event staged far back", async () => {
    const ranges: Array<[bigint, bigint]> = [];
    const pub = {
      getLogs: async (a: { fromBlock: bigint; toBlock: bigint }) => {
        ranges.push([a.fromBlock, a.toBlock]);
        if (a.toBlock - a.fromBlock + 1n > 2_000n) throw new Error("range too large");
        return a.fromBlock <= 1_000n && 1_000n <= a.toBlock ? [{ args: { oldMultiplier: WAD, newMultiplier: 10n * WAD, effectiveAtTimestamp: SAT } }] : [];
      },
    };
    const r = await readMultiplierAtBasis(pub as never, "0x00000000000000000000000000000000000000d1", { basisAt: FRI, nowSec: NOW, blockNumber: 9_999n, lookbackBlocks: 9_999n });
    expect(r).toEqual({ multiplierWad: WAD, firstChangeAt: SAT });
    expect(ranges).toHaveLength(5);
    expect(ranges.at(-1)).toEqual([8_000n, 9_999n]);
  });
});
