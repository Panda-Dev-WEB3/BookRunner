// Distribution preview + reconciliation against the on-chain Distributed event, using the NORMATIVE
// splitDistribution from packages/shared/src/waterfall.ts. 2026-10 insurance pool: a pool-funded book pays the pool
// its premium (charter.premiumBps of gross, RevenueRouter.PremiumPaid) before the split; `Distributed` keeps the whole
// gross, so premium + expenses + carry + senior + junior == gross (splitPoolDistribution).
import { type SplitInput, type SplitResult, splitDistribution, splitPoolDistribution } from "@bookrunner/shared";

export type { SplitResult };

/** A split with the pool premium (0 for a book-funded IF). */
export type PremiumSplit = SplitResult & { premium: bigint };

/** The normative split of `gross`: premium first when `premiumBps` > 0 (pool-funded book), then the ordinary split. */
export function previewDistribution(i: SplitInput, premiumBps = 0n): PremiumSplit {
  return premiumBps > 0n ? splitPoolDistribution(i, premiumBps) : { ...splitDistribution(i), premium: 0n };
}

/** Distributed(bookId, period, uint256[5] amounts) -> named split (+ the PremiumPaid amount of the same tx). */
export function amountsToSplit(a: readonly bigint[], premium = 0n): PremiumSplit {
  if (a.length !== 5) throw new Error(`Distributed amounts must have 5 entries, got ${a.length}`);
  const [gross, expenses, carry, senior, junior] = a as [bigint, bigint, bigint, bigint, bigint];
  return { gross, expenses, carry, senior, junior, premium };
}

export const SPLIT_FIELDS = ["gross", "premium", "expenses", "carry", "senior", "junior"] as const;
type Field = (typeof SPLIT_FIELDS)[number];

const premiumOf = (s: SplitResult & { premium?: bigint }) => s.premium ?? 0n;

/** Field names where the on-chain split differs from the normative preview (empty = equal). */
export function splitMismatches(expected: SplitResult & { premium?: bigint }, actual: SplitResult & { premium?: bigint }): Field[] {
  return SPLIT_FIELDS.filter((f) => (f === "premium" ? premiumOf(expected) !== premiumOf(actual) : expected[f] !== actual[f]));
}

/**
 * Re-derives the split from the event's own gross/expenses (the gross may legitimately differ from the
 * pre-tx preview if fee flow arrived in between); only a mismatch here is a waterfall parity break.
 */
export function parityCheck(actual: SplitResult & { premium?: bigint }, params: Omit<SplitInput, "gross" | "expensesRequested">, premiumBps = 0n): Field[] {
  const expected = previewDistribution({ ...params, gross: actual.gross, expensesRequested: actual.expenses }, premiumBps);
  return splitMismatches(expected, actual);
}

/** Conservation: gross == premium + expenses + carry + senior + junior. */
export function conserves(s: SplitResult & { premium?: bigint }): boolean {
  return s.gross === premiumOf(s) + s.expenses + s.carry + s.senior + s.junior;
}
