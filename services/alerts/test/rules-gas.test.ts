// 2026-11 GasTank alert rules (rules-gas.ts) and the collector's readGasTank.
import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { type PoolRead, readGasTank } from "../src/collect";
import { evaluate } from "../src/rules";
import { GAS_TANK_RULES, gasTankCapHit, gasTankLow, gasTankPaused } from "../src/rules-gas";
import type { GasTankSnap } from "../src/types";
import { rules, snap } from "./fixtures";

const E = parseEther;
const TANK = "0x00000000000000000000000000000000000000a1";
const A = "0x00000000000000000000000000000000000000b1";
const B = "0x00000000000000000000000000000000000000b2";

const tank = (o: Partial<GasTankSnap> = {}): GasTankSnap => ({
  address: TANK,
  balanceWei: E("0.5"),
  paused: false,
  globalDailyCapWei: E("0.1"),
  globalSentTodayWei: 0n,
  services: [
    { address: A, role: "markSigner", balanceWei: E("0.01"), floorWei: E("0.002"), dailyCapWei: E("0.02"), sentTodayWei: 0n, reason: 2 },
    { address: B, role: null, balanceWei: E("0.01"), floorWei: E("0.002"), dailyCapWei: E("0.02"), sentTodayWei: 0n, reason: 2 },
  ],
  ...o,
});
const keys = (s: GasTankSnap | null | undefined) => evaluate(snap({ gasTank: s }), rules()).filter((c) => c.rule.startsWith("gas_tank")).map((c) => [c.key, c.severity]);

describe("absent / unreadable tank", () => {
  test("a healthy tank raises nothing; none in the deployment (null) or a failed read (undefined) is quiet", () => {
    for (const rule of Object.values(GAS_TANK_RULES)) expect(rule(snap({ gasTank: tank() }), rules())).toEqual([]);
    expect(keys(null)).toEqual([]);
    expect(keys(undefined)).toEqual([]);
    expect(keys(tank({ balanceWei: 0n }))).not.toEqual([]); // the rule does fire when the data says so
  });
});

describe("gas_tank_low", () => {
  test("at the minimum quiet; below it warning; below a quarter or empty critical", () => {
    const min = rules().gasTankMinWei;
    expect(min).toBe(E("0.05"));
    expect(gasTankLow(snap({ gasTank: tank({ balanceWei: min }) }), rules())).toEqual([]);
    expect(gasTankLow(snap({ gasTank: tank({ balanceWei: min - 1n }) }), rules()).map((c) => c.severity)).toEqual(["warning"]);
    expect(gasTankLow(snap({ gasTank: tank({ balanceWei: min / 4n - 1n }) }), rules()).map((c) => c.severity)).toEqual(["critical"]);
    const empty = gasTankLow(snap({ gasTank: tank({ balanceWei: 0n }) }), rules());
    expect(empty.map((c) => [c.key, c.severity])).toEqual([["gas_tank_low", "critical"]]);
    expect(empty[0]!.summary).toContain("treasury must send ETH");
  });
});

describe("gas_tank_cap_hit", () => {
  test("a wallet below its floor with a used-up cap: warning, naming the role and the cap; critical when nearly dry", () => {
    const s = tank({
      services: [
        { address: A, role: "markSigner", balanceWei: E("0.0015"), floorWei: E("0.002"), dailyCapWei: E("0.02"), sentTodayWei: E("0.02"), reason: 3 },
        { address: B, role: null, balanceWei: E("0.0003"), floorWei: E("0.002"), dailyCapWei: E("0.02"), sentTodayWei: E("0.02"), reason: 3 },
      ],
    });
    const c = gasTankCapHit(snap({ gasTank: s }), rules());
    expect(c.map((x) => [x.key, x.severity])).toEqual([
      [`gas_tank_cap_hit:${A}`, "warning"],
      [`gas_tank_cap_hit:${B}`, "critical"],
    ]);
    expect(c[0]!.summary).toContain("markSigner");
    expect(c[0]!.summary).toContain("daily cap for it");
  });

  test("the global cap names the global figures; wallets at their floor or merely paused are not cap hits", () => {
    const s = tank({
      globalSentTodayWei: E("0.1"),
      services: [
        { address: A, role: "keeper", balanceWei: E("0.001"), floorWei: E("0.002"), dailyCapWei: E("0.02"), sentTodayWei: E("0.01"), reason: 4 },
        { address: B, role: null, balanceWei: E("0.001"), floorWei: E("0.002"), dailyCapWei: E("0.02"), sentTodayWei: 0n, reason: 1 },
      ],
    });
    const c = gasTankCapHit(snap({ gasTank: s }), rules());
    expect(c).toHaveLength(1);
    expect(c[0]!.summary).toContain("global daily cap");
  });
});

describe("gas_tank_paused", () => {
  test("paused: warning; critical when a wallet is below its floor", () => {
    expect(gasTankPaused(snap({ gasTank: tank({ paused: false }) }), rules())).toEqual([]);
    expect(gasTankPaused(snap({ gasTank: tank({ paused: true }) }), rules()).map((c) => c.severity)).toEqual(["warning"]);
    const needy = tank({ paused: true, services: [{ address: A, role: "risk", balanceWei: 1n, floorWei: E("0.002"), dailyCapWei: E("0.02"), sentTodayWei: 0n, reason: 1 }] });
    const c = gasTankPaused(snap({ gasTank: needy }), rules());
    expect(c.map((x) => x.severity)).toEqual(["critical"]);
    expect(c[0]!.summary).toContain("risk");
  });
});

describe("readGasTank", () => {
  test("reads the tank and every allow-listed wallet; labels roles from the configured addresses", async () => {
    const calls: string[] = [];
    const read: PoolRead = async (fn, args) => {
      calls.push(fn);
      switch (fn) {
        case "services":
          return [A, B];
        case "paused":
          return false;
        case "globalDailyCap":
          return E("0.1");
        case "globalSentToday":
          return E("0.03");
        case "serviceInfo":
          return [true, E("0.002"), E("0.01"), E("0.02"), args![0] === A ? E("0.01") : 0n];
        case "topUpQuote":
          return args![0] === A ? [E("0.009"), 0] : [0n, 2];
        default:
          throw new Error(`unexpected ${fn}`);
      }
    };
    const bal = async (a: `0x${string}`) => (a === TANK ? E("0.4") : a === A ? E("0.001") : E("0.02"));
    const g = await readGasTank(read, bal, TANK, (a) => (a === A ? "markSigner" : null));
    expect(g).toMatchObject({ address: TANK, balanceWei: E("0.4"), paused: false, globalDailyCapWei: E("0.1"), globalSentTodayWei: E("0.03") });
    expect(g.services).toEqual([
      { address: A, role: "markSigner", balanceWei: E("0.001"), floorWei: E("0.002"), dailyCapWei: E("0.02"), sentTodayWei: E("0.01"), reason: 0 },
      { address: B, role: null, balanceWei: E("0.02"), floorWei: E("0.002"), dailyCapWei: E("0.02"), sentTodayWei: 0n, reason: 2 },
    ]);
    expect(calls.filter((c) => c === "topUpQuote")).toHaveLength(2);
  });

  test("a failed core read throws (collect turns it into gasTank = undefined)", async () => {
    const read: PoolRead = async () => {
      throw new Error("rpc down");
    };
    await expect(readGasTank(read, async () => 0n, TANK, () => null)).rejects.toThrow("rpc down");
  });
});
