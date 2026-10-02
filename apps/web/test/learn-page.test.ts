import { describe, expect, test } from "bun:test";
import { filterGroups, glossaryGroups, GLOSSARY_GROUPS, matchesGlossary, termFromHash } from "../src/components/learn/glossaryGroups";
import { LEARN_SECTIONS, pickActive, sectionPosition } from "../src/components/learn/sections";
import { GLOSSARY_IDS } from "../src/lib/glossary";

describe("Learn sections and scroll spy", () => {
  test("nine sections with unique anchor ids, in the brief's order", () => {
    const ids = LEARN_SECTIONS.map((s) => s.id);
    expect(ids).toEqual(["problem", "lifecycle", "tranches", "simulator", "mark", "risk", "low-gas", "bkrn", "glossary"]);
    expect(new Set(ids).size).toBe(ids.length);
    // section anchors must never collide with glossary anchors (term-<id>)
    for (const id of ids) expect(id.startsWith("term-")).toBe(false);
  });

  test("pickActive picks the last section whose top passed the offset", () => {
    expect(pickActive([], 140)).toBe(-1);
    expect(pickActive([400, 900, 1600], 140)).toBe(0); // above the first section: first counts
    expect(pickActive([50, 300, 900], 140)).toBe(0);
    expect(pickActive([-500, 100, 900], 140)).toBe(1);
    expect(pickActive([-1500, -900, 140], 140)).toBe(2); // exactly at the offset counts
    expect(pickActive([-1500, -900, 400], 140, true)).toBe(2); // bottom of the page: last section
    expect(pickActive([0, Number.POSITIVE_INFINITY], 140)).toBe(0); // missing element
  });

  test("sectionPosition", () => {
    expect(sectionPosition("simulator")).toEqual({ index: 3, label: "Waterfall simulator" });
    expect(sectionPosition("nope")).toBeNull();
    expect(sectionPosition(null)).toBeNull();
  });
});

describe("Glossary groups", () => {
  test("every glossary term sits in exactly one group", () => {
    const grouped = GLOSSARY_GROUPS.flatMap((g) => g.ids);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...GLOSSARY_IDS].sort());
    expect(glossaryGroups().map((g) => g.id)).not.toContain("more");
  });

  test("search matches the term name and its definitions, case- and accent-insensitive", () => {
    expect(matchesGlossary("nav", "NAV")).toBe(true);
    expect(matchesGlossary("nav", "  net asset ")).toBe(true);
    expect(matchesGlossary("senior", "")).toBe(true);
    expect(matchesGlossary("gas", "zzz-no-match")).toBe(false);
    const g = filterGroups(glossaryGroups(), "hedge");
    const ids = g.flatMap((x) => x.ids);
    expect(ids).toContain("hedgeBand");
    expect(ids).toContain("stockToken");
    expect(filterGroups(glossaryGroups(), "zzz-no-match")).toEqual([]);
  });

  test("termFromHash reads /learn#term-<id> anchors", () => {
    expect(termFromHash("#term-senior")).toBe("senior");
    expect(termFromHash("term-killSwitch")).toBe("killSwitch");
    expect(termFromHash("#term-apy")).toBeNull();
    expect(termFromHash("#simulator")).toBeNull();
    expect(termFromHash("#term-%E0%A4%A")).toBeNull();
    expect(termFromHash("")).toBeNull();
  });
});
