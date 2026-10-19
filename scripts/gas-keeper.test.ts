// scripts/gas-keeper.ts: which per-book desk keys get gas (Task 7b: every book has a desk key).
import { describe, expect, test } from "bun:test";
import { zeroHash } from "viem";
import { deskKeyNeedsGas } from "./gas-keeper";

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
