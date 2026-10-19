import { describe, expect, test } from "bun:test";
import { codeOnly, generate, sample, score, wilson95 } from "./mutation-gen";

const SRC = `// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;
import {X} from "./X.sol";
contract C {
    uint256 internal constant BPS = 10_000;
    /// @notice a < b in a comment is not code
    error Bad(); // a == b
    mapping(address => uint256) public bal;
    function pay(address to, uint256 amt)
        external
        onlyBook
        nonReentrant
    {
        if (amt == 0 || to == address(0)) revert Bad();
        require(amt <= BPS, "too big: a > b");
        bal[to] += amt;
        uint256 left = amt - 1;
        total = total + left * 2;
        ok = !paused && true;
    }
}
`;

describe("mutation-gen", () => {
  test("comments and string contents are blanked, code and lengths kept", () => {
    const [a, b] = codeOnly(['x = 1; // a < b', 'require(y, "a > b");']);
    expect(a).toBe("x = 1;         ");
    expect(b!.length).toBe('require(y, "a > b");'.length);
    expect(b).not.toContain(">");
  });

  test("one mutant per site, each operator, never in comments, strings, pragmas, imports or errors", () => {
    const ms = generate(SRC);
    const by = (op: string) => ms.filter((m) => m.op === op).map((m) => m.text.trim());
    expect(by("constant")).toEqual(["uint256 internal constant BPS = (10_000 + 1);"]);
    expect(by("access")).toEqual([""]); // the `onlyBook` line of the multi-line signature, removed
    expect(by("guard")).toEqual(["if (false) revert Bad();"]);
    expect(by("require")).toEqual(['require(true, "too big: a > b");']);
    expect(by("cmp")).toEqual([
      "if (amt != 0 || to == address(0)) revert Bad();",
      "if (amt == 0 || to != address(0)) revert Bad();",
      'require(amt < BPS, "too big: a > b");',
    ]);
    expect(by("logic")).toEqual(["if (amt == 0 && to == address(0)) revert Bad();", "ok = !paused || true;"]);
    expect(by("arith")).toEqual(["bal[to] -= amt;", "uint256 left = amt + 1;", "total = total - left * 2;", "total = total + left / 2;"]);
    expect(by("delete")).toEqual(["{}", "{}", "{}"]); // bal[to] += amt; total = ...; ok = ...; (not the declaration)
    expect(by("not")).toEqual(["ok = paused && true;"]);
    expect(by("bool")).toEqual(["ok = !paused && false;"]);
    expect(ms.every((m) => m.line > 3)).toBe(true);
    expect(ms.map((m) => m.id)).toEqual(ms.map((_, i) => i + 1));
  });

  test("sampling keeps every access mutant, favours guards and money lines, is deterministic, and 0 means all", () => {
    const ms = generate(SRC);
    const a = sample(ms, 6, 7);
    expect(a.length).toBe(6);
    expect(a.some((m) => m.op === "access")).toBe(true);
    expect(sample(ms, 6, 7)).toEqual(a);
    expect(sample(ms, 0, 7)).toEqual(ms);
    // over many seeds a guard (weight 4) is picked far more often than a boolean literal (weight 1)
    let guard = 0;
    let bool = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const s = sample(ms, 4, seed);
      guard += s.filter((m) => m.op === "guard").length;
      bool += s.filter((m) => m.op === "bool").length;
    }
    expect(guard).toBeGreaterThan(2 * bool);
  });

  test("score: timeouts count as killed, stillborn mutants are excluded", () => {
    const s = score([
      { id: 1, status: "killed", test: "t" },
      { id: 2, status: "timeout", test: "" },
      { id: 3, status: "survived", test: "" },
      { id: 4, status: "stillborn", test: "" },
    ]);
    expect(s.valid).toBe(3);
    expect(s.score).toBeCloseTo(2 / 3);
  });
});

describe("wilson95", () => {
  test("95% interval of a kill rate measured on a sample", () => {
    const [lo, hi] = wilson95(36, 40);
    expect(lo).toBeCloseTo(0.7695, 3);
    expect(hi).toBeCloseTo(0.9604, 3);
    expect(wilson95(0, 0)).toEqual([0, 1]);
  });
});
