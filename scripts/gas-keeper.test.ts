// scripts/gas-keeper.ts: which per-book desk keys get gas (Task 7b: every book has a desk key).
import { describe, expect, test } from "bun:test";
import { zeroHash } from "viem";
import { deskKeyNeedsGas, launchRoleBookIds } from "./gas-keeper";

describe("launchRoleBookIds", () => {
  test("only the first three recorded books use (already funded) launch roles; a 4th recorded book gets its own key funded", () => {
    const launch = launchRoleBookIds([4, 2, 1, 3]);
    expect([...launch].sort()).toEqual([1, 2, 3]);
    expect(launch.has(4)).toBe(false);
    expect(launchRoleBookIds([]).size).toBe(0);
  });
});

describe("deskKeyNeedsGas", () => {
  const root = `0x${"11".repeat(32)}` as const;
  test("engine books (SetQuote) and hedging books (legs + venue-report relay) need gas; quote-only Orderly and ended books do not", () => {
    expect(deskKeyNeedsGas({ state: 2, venue: 1, hedgeAllowRoot: zeroHash })).toBe(true);
    expect(deskKeyNeedsGas({ state: 2, venue: 0, hedgeAllowRoot: root })).toBe(true);
    expect(deskKeyNeedsGas({ state: 0, venue: 0, hedgeAllowRoot: root })).toBe(true);
    expect(deskKeyNeedsGas({ state: 2, venue: 0, hedgeAllowRoot: zeroHash })).toBe(false);
    expect(deskKeyNeedsGas({ state: 4, venue: 1, hedgeAllowRoot: root })).toBe(false);
    expect(deskKeyNeedsGas({ state: 1, venue: 0, hedgeAllowRoot: root })).toBe(false);
  });
});
