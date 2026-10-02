// Copy that must match what the contracts do, checked over every user-facing string of the app
// (the same extraction as the copy lint). Each rule names the contract behaviour it encodes, so a
// later edit cannot quietly bring back a wrong promise.
import { describe, expect, test } from "bun:test";
import { appSnippets } from "../scripts/check-copy";

interface Rule {
  /** What the protocol actually does. */
  why: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  {
    why: "A top-up round settles at the first mark whose period ends at or after the ROUND END (Tranche.settleAtMark), not at the next mark",
    pattern: /(deposit|round|escrow|allocat)[^.]*\bnext mark\b|\bnext mark\b[^.]*(deposit|round|escrow)|settle at the next mark's share price/i,
  },
];

const { snippets } = appSnippets();

describe("protocol copy", () => {
  test("extracts the app's copy", () => {
    expect(snippets.length).toBeGreaterThan(500);
  });
  for (const r of RULES) {
    test(r.why, () => {
      const hits = snippets.filter((s) => r.pattern.test(s.text)).map((s) => `${s.file}:${s.line} ${s.text}`);
      expect(hits).toEqual([]);
    });
  }
});
