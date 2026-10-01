// Distribution preview + reconciliation against the on-chain Distributed event, using the NORMATIVE
// splitDistribution from packages/shared/src/waterfall.ts.
import { type SplitInput, type SplitResult, splitDistribution } from "@bookrunner/shared";

export type { SplitResult };

export function previewDistribution(i: SplitInput): SplitResult {
  return splitDistribution(i);
}

/** Distributed(bookId, period, uint256[5] amounts) -> named split. */
export function amountsToSplit(a: readonly bigint[]): SplitResult {
  if (a.length !== 5) throw new Error(`Distributed amounts must have 5 entries, got ${a.length}`);
  const [gross, expenses, carry, senior, junior] = a as [bigint, bigint, bigint, bigint, bigint];
  return { gross, expenses, carry, senior, junior };
}

export const SPLIT_FIELDS = ["gross", "expenses", "carry", "senior", "junior"] as const;

/** Field names where the on-chain split differs from the normative preview (empty = equal). */
export function splitMismatches(expected: SplitResult, actual: SplitResult): Array<(typeof SPLIT_FIELDS)[number]> {
  return SPLIT_FIELDS.filter((f) => expected[f] !== actual[f]);
}

/**
 * Re-derives the split from the event's own gross/expenses (the gross may legitimately differ from the
 * pre-tx preview if fee flow arrived in between); only a mismatch here is a waterfall parity break.
 */
export function parityCheck(actual: SplitResult, params: Omit<SplitInput, "gross" | "expensesRequested">): Array<(typeof SPLIT_FIELDS)[number]> {
  const expected = splitDistribution({ ...params, gross: actual.gross, expensesRequested: actual.expenses });
  return splitMismatches(expected, actual);
}

/** Conservation: gross == expenses + carry + senior + junior. */
export function conserves(s: SplitResult): boolean {
  return s.gross === s.expenses + s.carry + s.senior + s.junior;
}
