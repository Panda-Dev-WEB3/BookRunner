import { describe, expect, test } from "bun:test";
import type { HedgePlan } from "../src/domain/hedge-planner";
import { capitalFlowOpen, gateCapitalLegs } from "../src/domain/mark-window";

const I = 3600;
const P = 1_760_000_400 - (1_760_000_400 % I); // a period start

describe("capitalFlowOpen (mirrors BookrunnerDesk.capitalFlowOpen)", () => {
  const live = { state: "Live" as const, lastMarkPeriodEnd: P, subscriptionEnds: P - 10 * I, markInterval: I };

  test("open while the latest ended period is marked; closed once the next period end passes unmarked", () => {
    expect(capitalFlowOpen(live, P + 100, 0)).toBe(true);
    expect(capitalFlowOpen(live, P + I - 1, 0)).toBe(true);
    expect(capitalFlowOpen(live, P + I, 0)).toBe(false); // P + I ended, no mark yet
    expect(capitalFlowOpen({ ...live, lastMarkPeriodEnd: P + I }, P + I + 5, 0)).toBe(true);
  });

  test("guard: closed when the period ends before the tx would land", () => {
    expect(capitalFlowOpen(live, P + I - 10, 30)).toBe(false);
    expect(capitalFlowOpen(live, P + I - 31, 30)).toBe(true);
  });

  test("first period after go-live: subscriptionEnds is the reference until the first mark", () => {
    const fresh = { ...live, lastMarkPeriodEnd: 0, subscriptionEnds: P + 200 };
    expect(capitalFlowOpen(fresh, P + 300, 0)).toBe(true);
    expect(capitalFlowOpen(fresh, P + I + 1, 0)).toBe(false);
  });

  test("no mark cycle outside Live / Retiring", () => {
    for (const state of ["Subscription", "Cancelled", "Retired"] as const) expect(capitalFlowOpen({ ...live, state }, P + 5 * I, 0)).toBe(true);
    expect(capitalFlowOpen({ ...live, state: "Retiring" }, P + 5 * I, 0)).toBe(false);
  });
});

describe("gateCapitalLegs", () => {
  const base: HedgePlan = { action: "buy", reason: "UNDER_HEDGED", ratioBefore: null, ratioAfter: null, targetHedgeUsd: 0n, legs: [] };

  test("open or no capital legs: unchanged", () => {
    const p = { ...base, legs: [{ kind: "fund_desk" as const, amountUsd: 1n }] };
    expect(gateCapitalLegs(p, true).plan).toBe(p);
    const sell = { ...base, legs: [{ kind: "perp" as const, notionalUsd: 1n }] };
    expect(gateCapitalLegs(sell, false).plan).toBe(sell);
  });

  test("closed: capital legs and the buys they fund are dropped", () => {
    const p: HedgePlan = {
      ...base,
      legs: [
        { kind: "recall_mm", amountUsd: 1n },
        { kind: "fund_desk", amountUsd: 1n },
        { kind: "buy", token: "0x01", assetId: "0x01", amountInUsd: 1n, expectedOutRaw: 1n, minAmountOutRaw: 1n, notionalUsd: 1n, proof: [] } as never,
      ],
    };
    const g = gateCapitalLegs(p, false);
    expect(g.plan.action).toBe("none");
    expect(g.plan.reason).toBe("MARK_PENDING");
    expect(g.skipped).toEqual(["recall_mm", "fund_desk", "buy"]);
  });

  test("closed: reducing legs stay, ReturnToVault waits", () => {
    const flatten = { kind: "flatten", token: "0x01", assetId: "0x01", amountInRaw: 1n, minAmountOutUsd: 1n, notionalUsd: 1n } as never;
    const p: HedgePlan = { ...base, action: "flatten", legs: [flatten, { kind: "return_to_vault", amountUsd: "all" }] };
    const g = gateCapitalLegs(p, false);
    expect(g.plan.action).toBe("flatten");
    expect(g.plan.legs).toEqual([flatten]);
    expect(g.skipped).toEqual(["return_to_vault"]);
  });
});
