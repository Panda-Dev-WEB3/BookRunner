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
  {
    why: "The sponsor's 10% of Junior is enforced only when the subscription window closes (Waterfall.allocateWindow); top-ups can dilute it",
    pattern: /sponsor[^.]*\b(always|must) (hold|keep)|\bat least 10% of (its |the book's )?Junior( tranche)?(?![^.;]*\bwindow closes)/i,
  },
  {
    why: "A mark only settles a redemption; the USDC moves in a separate claim, which waits while the book's cash is on the venue (Tranche._ensureLiquidity)",
    pattern: /\b(are|is|be|get|gets) paid (at|after)\b|\bpaid at the (next|first) mark|\byours to claim\b|\bwhen you are paid\b/i,
  },
  {
    why: "PoolEngine accrues only taker fees to feesAccruedUsd (the router's fee flow); spread capture and the IF half of liquidation fees reach the book through NAV",
    pattern: /taker fees, liquidation fees|liquidation fees and spread capture/i,
  },
  {
    why: "Waterfall.splitDistribution pays Senior a fixed share and Junior the rest in the same transaction: Senior is not 'paid first' (expenses are)",
    pattern: /(?<!are )\bpaid first\b|\bbefore Junior\b|its share, first|goes to Senior first|pays Senior first/i,
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
