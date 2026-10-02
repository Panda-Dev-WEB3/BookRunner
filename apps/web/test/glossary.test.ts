import { describe, expect, test } from "bun:test";
import { checkCopy } from "@bookrunner/shared/copy";
import { GLOSSARY, GLOSSARY_IDS, glossaryEntry, isGlossaryId, termAnchor } from "../src/lib/glossary";
import { SERIES, SERIES_CLASS, SERIES_LABEL } from "../src/lib/palette";

const REQUIRED = [
  "book",
  "charter",
  "sponsor",
  "allocator",
  "senior",
  "junior",
  "hurdle",
  "carry",
  "waterfall",
  "nav",
  "mark",
  "merkleReceipt",
  "mandate",
  "hedgeBand",
  "killSwitch",
  "backstop",
  "bkrn",
  "staking",
  "topUpRound",
  "subscriptionWindow",
  "redemptionNotice",
  "stockToken",
  "perp",
  "marketMaker",
  "pullOracle",
];

describe("glossary", () => {
  test("covers every term the investor pages explain", () => {
    for (const id of REQUIRED) expect(isGlossaryId(id)).toBe(true);
    expect(isGlossaryId("apy")).toBe(false);
  });

  test("entries are keyed by their own id, unique, and fit a tooltip", () => {
    expect(new Set(GLOSSARY_IDS).size).toBe(GLOSSARY_IDS.length);
    for (const id of GLOSSARY_IDS) {
      const e = glossaryEntry(id);
      expect(e.id).toBe(id);
      expect(e.term.length).toBeGreaterThan(1);
      expect(e.short.length).toBeGreaterThan(20);
      expect(e.short.length).toBeLessThanOrEqual(260);
      expect(termAnchor(id)).toBe(`term-${id}`);
    }
  });

  test("related terms point at existing entries (never at themselves)", () => {
    for (const e of Object.values(GLOSSARY)) {
      for (const r of e.related ?? []) {
        expect(isGlossaryId(r)).toBe(true);
        expect(r).not.toBe(e.id);
      }
    }
  });

  test("every definition passes the copy rules", () => {
    for (const e of Object.values(GLOSSARY)) {
      const text = [e.term, e.short, e.long ?? ""].join("\n");
      expect(checkCopy(text)).toEqual([]);
    }
  });

  test("facts that must match the protocol docs", () => {
    expect(GLOSSARY.carry.short).toContain("10%");
    expect(GLOSSARY.sponsor.short).toContain("10%");
    expect(GLOSSARY.senior.short).toContain("last loss, not no loss");
    expect(GLOSSARY.redemptionNotice.short).toContain("Notice is not a gate");
    expect(GLOSSARY.backstop.short).toContain("up to what the pool holds");
    // Book.topUp() capacity is the round total; Tranche.settleAtMark settles at the first mark on or after endsAt.
    expect(GLOSSARY.topUpRound.short).toContain("until the first mark after the round ends");
    expect(GLOSSARY.topUpRound.short).toContain("fixed capacity");
    // Tranche has no cancel or withdraw path for a commitment: only settlement or a cancelled round.
    expect(GLOSSARY.topUpRound.long).toContain("cannot be cancelled or withdrawn before the round settles");
    expect(GLOSSARY.bkrn.long).toContain("never a revenue claim");
  });
});

describe("series palette", () => {
  test("fixed colour coding: one token per series, BKRN shares the backstop violet", () => {
    expect(SERIES.senior).toBe("var(--senior)");
    expect(SERIES.junior).toBe("var(--junior)");
    expect(SERIES.backstop).toBe("var(--backstop)");
    expect(SERIES.bkrn).toBe(SERIES.backstop);
    expect(SERIES.fee).toBe("var(--fee)");
    expect(SERIES.loss).toBe("var(--loss)");
    for (const k of Object.keys(SERIES) as Array<keyof typeof SERIES>) {
      expect(SERIES_LABEL[k].length).toBeGreaterThan(0);
      expect(SERIES_CLASS[k].bg.startsWith("bg-")).toBe(true);
    }
  });
});
