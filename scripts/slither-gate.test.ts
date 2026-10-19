import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type AllowEntry, gate, type SlitherResult, targetOf } from "./slither-gate";

const fn = (contract: string, name: string) => ({ type: "function", name, type_specific_fields: { parent: { type: "contract", name: contract } } });
const local = (contract: string, f: string, name: string) => ({ type: "variable", name, type_specific_fields: { parent: { type: "function", name: f, type_specific_fields: { parent: { type: "contract", name: contract } } } } });
const finding = (check: string, impact: string, element: SlitherResult["elements"][number]): SlitherResult => ({ check, impact, confidence: "Medium", description: `${check} finding`, elements: [element] });

describe("scripts/slither-gate.ts", () => {
  test("targets are named by contract / function / variable, never by line", () => {
    expect(targetOf(finding("unused-return", "Medium", fn("Book", "applyMark")))).toBe("Book.applyMark");
    expect(targetOf(finding("uninitialized-local", "Medium", local("BookLogic", "applyMark", "sum")))).toBe("BookLogic.applyMark.sum");
    expect(targetOf(finding("uninitialized-state", "High", { type: "variable", name: "_x", type_specific_fields: { parent: { type: "contract", name: "Tranche" } } }))).toBe("Tranche._x");
  });

  test("an unlisted Medium / High finding blocks; Low and Informational never do; unused entries are stale", () => {
    const allow: AllowEntry[] = [
      { check: "unused-return", target: "Book.applyMark", reason: "tuple field not needed" },
      { check: "reentrancy-no-eth", target: "Gone.fn", reason: "was fixed" },
    ];
    const results = [
      finding("unused-return", "Medium", fn("Book", "applyMark")),
      finding("unused-return", "Medium", fn("Book", "other")), // same detector, other function: not covered
      finding("reentrancy-eth", "High", fn("Vault", "withdraw")),
      finding("timestamp", "Low", fn("Vault", "withdraw")),
    ];
    const { blocking, stale } = gate(results, allow);
    expect(blocking.map((b) => `${b.check} ${b.target}`)).toEqual(["unused-return Book.other", "reentrancy-eth Vault.withdraw"]);
    expect(stale.map((s) => s.target)).toEqual(["Gone.fn"]);
  });

  test("an entry without a reason is refused", () => {
    expect(() => gate([], [{ check: "unused-return", target: "Book.applyMark", reason: " " }])).toThrow(/no reason/);
  });

  test("the checked-in allowlist is well formed: unique entries, each with a reason", () => {
    const { entries } = JSON.parse(readFileSync(resolve(import.meta.dir, "../contracts/slither-allowlist.json"), "utf8")) as { entries: AllowEntry[] };
    expect(entries.length).toBeGreaterThan(0);
    const keys = entries.map((e) => `${e.check}|${e.target}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of entries) expect(e.reason.trim().length).toBeGreaterThan(20);
  });
});
