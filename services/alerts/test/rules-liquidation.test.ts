// Liquidation keeper alerts (2026-10 in-house engine markets): liquidation_backlog and keeper_liquidation_failing, and
// the status parsing the collector uses.
import { describe, expect, test } from "bun:test";
import { type LiquidationKeeperStatus, parseLiquidationStatus } from "@bookrunner/shared/liquidationKeeper";
import { evaluate } from "../src/rules";
import { LIQUIDATION_RULES, keeperLiquidationFailing, liquidationBacklog, liquidationCoverage } from "../src/rules-liquidation";
import type { Condition } from "../src/types";
import { NOW, book, rules, snap } from "./fixtures";

const ks = (cs: Condition[]) => cs.map((c) => [c.key, c.severity]);
const TRADER = "0x0000000000000000000000000000000000000a11";

function status(o: Partial<LiquidationKeeperStatus> = {}): LiquidationKeeperStatus {
  return {
    ts: NOW - 5_000,
    enabled: true,
    keeper: "0x000000000000000000000000000000000000beef",
    nextPassSec: 10,
    markets: [{ marketId: 1, bookId: 7, regime: "open", openPositions: 3, priceAgeSec: 2 }],
    backlog: [],
    lastPass: { at: NOW - 5_000, durationMs: 120, checked: 3, liquidated: 0, forceClosed: 0, raced: 0 },
    failures: { consecutive: 0, since: null, lastError: null, lastErrorAt: null },
    totals: { liquidations: 0, forceCloses: 0, raced: 0, rewardsUsd: "0.000000", gasWei: "0" },
    gasGuard: "reward",
    coverage: { total: 3, checked: 3, truncated: false, rotationSec: 0 },
    reconcile: { at: NOW - 60_000, checked: 3, repaired: 0, error: null },
    ...o,
  };
}
const engineBook = book({ bookId: 7, venue: "pool_engine", state: "Live" });

describe("liquidation_backlog", () => {
  test("quiet within the limit; warning past it; critical at 5x; the reason is named", () => {
    const item = (ageSec: number, reason: LiquidationKeeperStatus["backlog"][number]["reason"] = "gas_guard") => ({
      marketId: 1,
      trader: TRADER,
      action: "liquidate" as const,
      since: NOW - ageSec * 1000,
      reason,
      detail: "cost 9e14 wei > allowance 8e14 wei",
    });
    expect(liquidationBacklog(snap({ liquidationKeeper: status({ backlog: [item(60)] }) }), rules())).toEqual([]);
    const w = liquidationBacklog(snap({ liquidationKeeper: status({ backlog: [item(61)] }) }), rules());
    expect(ks(w)).toEqual([[`liquidation_backlog:1:${TRADER}`, "warning"]]);
    expect(w[0]!.summary).toContain("gas policy");
    expect(ks(liquidationBacklog(snap({ liquidationKeeper: status({ backlog: [item(301, "failed")] }) }), rules()))).toEqual([[`liquidation_backlog:1:${TRADER}`, "critical"]]);
    expect(liquidationBacklog(snap({ liquidationKeeper: status({ backlog: [item(30)] }) }), rules({ liqBacklogSec: 10 }))).toHaveLength(1);
  });

  test("no status or an unreadable one: quiet", () => {
    expect(liquidationBacklog(snap({ liquidationKeeper: null }), rules())).toEqual([]);
    expect(liquidationBacklog(snap({ liquidationKeeper: undefined }), rules())).toEqual([]);
  });
});

describe("keeper_liquidation_failing", () => {
  test("consecutive failures at the limit: critical with the last error", () => {
    expect(keeperLiquidationFailing(snap({ books: [engineBook], liquidationKeeper: status({ failures: { consecutive: 2, since: NOW - 30_000, lastError: "x", lastErrorAt: NOW } }) }), rules())).toEqual([]);
    const c = keeperLiquidationFailing(snap({ books: [engineBook], liquidationKeeper: status({ failures: { consecutive: 3, since: NOW - 30_000, lastError: "nonce too low", lastErrorAt: NOW } }) }), rules());
    expect(ks(c)).toEqual([["keeper_liquidation_failing", "critical"]]);
    expect(c[0]!.summary).toContain("nonce too low");
  });

  test("a live engine book and no status, or a stale one: critical; no live engine book: quiet; Redis unreadable: quiet", () => {
    expect(ks(keeperLiquidationFailing(snap({ books: [engineBook], liquidationKeeper: null }), rules()))).toEqual([["keeper_liquidation_failing", "critical"]]);
    expect(keeperLiquidationFailing(snap({ books: [engineBook], liquidationKeeper: status({ ts: NOW - 301_000 }) }), rules())[0]!.summary).toContain("stalled");
    expect(keeperLiquidationFailing(snap({ books: [engineBook], liquidationKeeper: status() }), rules())).toEqual([]);
    expect(keeperLiquidationFailing(snap({ books: [book()], liquidationKeeper: null }), rules())).toEqual([]);
    expect(keeperLiquidationFailing(snap({ books: [book({ ...engineBook, state: "Subscription" })], liquidationKeeper: null }), rules())).toEqual([]);
    expect(keeperLiquidationFailing(snap({ books: [engineBook], liquidationKeeper: undefined }), rules())).toEqual([]);
  });

  test("registered in the rule set; disabled by name", () => {
    for (const name of Object.keys(LIQUIDATION_RULES)) {
      const s = snap({ books: [engineBook], liquidationKeeper: null });
      expect(evaluate(s, rules()).some((c) => c.rule === "keeper_liquidation_failing")).toBe(true);
      expect(evaluate(s, rules({ disabled: new Set([name, "keeper_liquidation_failing"]) })).some((c) => c.rule === name)).toBe(false);
    }
  });
});

describe("liquidation_coverage (review I-6)", () => {
  test("all positions read each pass: quiet; paged: warning; a rotation beyond the limit: critical", () => {
    expect(liquidationCoverage(snap({ liquidationKeeper: status() }), rules())).toEqual([]);
    const paged = (rotationSec: number) => status({ coverage: { total: 12_000, checked: 5_000, truncated: true, rotationSec } });
    const w = liquidationCoverage(snap({ liquidationKeeper: paged(30) }), rules());
    expect(ks(w)).toEqual([["liquidation_coverage", "warning"]]);
    expect(w[0]!.summary).toContain("5000 of 12000");
    expect(ks(liquidationCoverage(snap({ liquidationKeeper: paged(121) }), rules()))).toEqual([["liquidation_coverage", "critical"]]);
  });
  test("a dust backlog item names its reason", () => {
    const d = liquidationBacklog(snap({ liquidationKeeper: status({ backlog: [{ marketId: 1, trader: TRADER, action: "liquidate", since: NOW - 120_000, reason: "dust", detail: null }] }) }), rules());
    expect(d[0]!.summary).toContain("dust");
  });
});

describe("status parsing", () => {
  test("round trip; malformed entries dropped; garbage is null", () => {
    const s = status({ backlog: [{ marketId: 1, trader: TRADER, action: "forceClose", since: NOW, reason: "price", detail: null }] });
    expect(parseLiquidationStatus(JSON.stringify(s))).toEqual(s);
    const bad = { ...s, backlog: [...s.backlog, { trader: 3 }], markets: [{ regime: "x" }] };
    const p = parseLiquidationStatus(JSON.stringify(bad))!;
    expect(p.backlog).toHaveLength(1);
    expect(p.markets).toEqual([]);
    expect(parseLiquidationStatus("{")).toBeNull();
    expect(parseLiquidationStatus(JSON.stringify({ backlog: [] }))).toBeNull();
    expect(parseLiquidationStatus(null)).toBeNull();
  });
});
