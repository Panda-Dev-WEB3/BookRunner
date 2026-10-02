import { describe, expect, test } from "bun:test";
import { isTopUpOpen, parseTopUp, topUpCapacity } from "../src/lib/topup";

describe("top-up rounds", () => {
  const r = parseTopUp(1, [true, 1_793_491_200n, 100_000_000_000n, 40_000_000_000n]);

  test("parses Book.topUp()", () => {
    expect(r).toEqual({ bookId: 1, open: true, endsAt: 1_793_491_200, seniorCapacityUsd: 100_000_000_000n, juniorCapacityUsd: 40_000_000_000n });
  });

  test("open only before endsAt", () => {
    expect(isTopUpOpen(r, 1_793_491_199)).toBe(true);
    expect(isTopUpOpen(r, 1_793_491_200)).toBe(false);
    expect(isTopUpOpen({ ...r, open: false }, 0)).toBe(false);
    expect(isTopUpOpen(null, 0)).toBe(false);
  });

  test("capacity per tranche, zero when closed", () => {
    expect(topUpCapacity(r, "senior", 0)).toBe(100_000_000_000n);
    expect(topUpCapacity(r, "junior", 0)).toBe(40_000_000_000n);
    expect(topUpCapacity(r, "junior", 1_793_491_200)).toBe(0n);
    expect(topUpCapacity(undefined, "senior", 0)).toBe(0n);
  });
});
