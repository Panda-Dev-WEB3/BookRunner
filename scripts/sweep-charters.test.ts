// scripts/sweep-charters.ts (audit 2026-10 review M-7): which Filed charters are expired, CLI parsing.
import { describe, expect, test } from "bun:test";
import { parseArgs, planSweep } from "./sweep-charters";

describe("planSweep", () => {
  const T = 1_800_000_000;
  test("only Filed charters at or past their deadline are expired (the contract's block.timestamp >= deadline rule)", () => {
    const plan = planSweep(
      [
        { id: 1, status: "Filed", deadline: T - 1 },
        { id: 2, status: "Filed", deadline: T }, // exactly at the deadline: expire() accepts it
        { id: 3, status: "Filed", deadline: T + 60 },
        { id: 4, status: "Approved", deadline: null },
        { id: 5, status: "Expired", deadline: null },
        { id: 6, status: "Rejected", deadline: null },
        { id: 7, status: "Filed", deadline: null },
        { id: 8, status: "Filed", deadline: 0 },
      ],
      T,
    );
    expect(plan).toEqual({ expire: [1, 2], open: [{ id: 3, deadline: T + 60 }], unknown: [7, 8] });
  });

  test("nothing Filed: nothing to do", () => {
    expect(planSweep([{ id: 1, status: "Retired", deadline: null }], 0)).toEqual({ expire: [], open: [], unknown: [] });
  });
});

describe("parseArgs", () => {
  test("dry run by default; --charter, --send, id range", () => {
    expect(parseArgs([])).toEqual({ charter: null, send: false, from: null, to: null });
    expect(parseArgs(["--charter", "0x00000000000000000000000000000000000000c1", "--send", "--from", "3", "--to", "9"])).toEqual({
      charter: "0x00000000000000000000000000000000000000c1",
      send: true,
      from: 3,
      to: 9,
    });
  });
  test("bad values are refused", () => {
    expect(() => parseArgs(["--charter", "nope"])).toThrow("not an address");
    expect(() => parseArgs(["--from", "0"])).toThrow("charter id >= 1");
    expect(() => parseArgs(["--to", "x"])).toThrow("charter id >= 1");
  });
});
