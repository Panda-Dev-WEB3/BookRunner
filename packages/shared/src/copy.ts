// "What not to say" (Overview §10) enforced in CI by scripts/check-copy.ts over user-facing copy
// (apps/web/src, docs/public, README). Tranches are described by seniority and loss order only.

export interface BannedTerm {
  pattern: RegExp;
  term: string;
  use: string;
}

export const BANNED_TERMS: BannedTerm[] = [
  { term: "APY", pattern: /\bAPY\b/i, use: "fee flow / observed accrual over the mark period" },
  { term: "APR", pattern: /\bAPR\b/i, use: "fee flow / observed accrual over the mark period" },
  { term: "yield", pattern: /\byields?\b/i, use: "fee flow" },
  { term: "returns", pattern: /\breturns?\b/i, use: "NAV / observed accrual" },
  { term: "target", pattern: /\btargets?\b/i, use: "size / limit" },
  { term: "guaranteed", pattern: /\bguarantee(d|s)?\b/i, use: "last loss in the waterfall" },
  { term: "protected", pattern: /\bprotect(ed|ion)?\b/i, use: "last loss in the waterfall / backstop up to the pool" },
  { term: "insured", pattern: /\binsured\b/i, use: "backstop up to the pool" },
  { term: "risk-free", pattern: /\brisk[- ]free\b/i, use: "last loss in the waterfall" },
  { term: "we market-make for you", pattern: /\bmarket[- ]make for you\b/i, use: "bookrunner agents quote the book under its mandate" },
  { term: "partner", pattern: /\b(orderly|arcus|chainlink)\b[^.\n]{0,40}\bpartners?\b|\bpartners?\b[^.\n]{0,40}\b(orderly|arcus|chainlink)\b/i, use: "listed on X's public contracts" },
];

export interface CopyViolation {
  term: string;
  use: string;
  line: number;
  text: string;
}

/**
 * Checks prose. For source files pass only extracted user-visible strings (JSX text, string
 * literals); property access like `e.target` and identifiers like `ifTargetUsd` are not prose.
 */
export function checkCopy(text: string): CopyViolation[] {
  const out: CopyViolation[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const b of BANNED_TERMS) {
      if (b.pattern.test(line)) out.push({ term: b.term, use: b.use, line: i + 1, text: line.trim() });
    }
  });
  return out;
}
