import { describe, expect, test } from "bun:test";
import { checkCopy } from "@bookrunner/shared/copy";
import { SIGNED_PRICE_LINE, VENUE_REPORT_LINE, ageOf, cadenceTitle, markCadenceLine, nextMarkAt, nextMarkLabel, redeemSettlesAt, signedFreshness } from "../src/lib/lowgas";

const DAY = 86_400;
const T = Date.UTC(2026, 9, 2, 12, 0, 0);
const sec = T / 1000;

describe("next mark", () => {
  test("counts down against the page clock; due periods read 'due now'", () => {
    const s = { intervalSeconds: DAY, cadence: "daily", nextPeriodEnd: sec + 12 * 3600, status: "scheduled" as const };
    expect(nextMarkLabel(s, T)).toBe("in 12h 00m");
    expect(nextMarkLabel(s, T + 11 * 3600 * 1000 + 30 * 60 * 1000)).toBe("in 30m");
    expect(nextMarkLabel(s, T + 13 * 3600 * 1000)).toBe("due now");
    expect(nextMarkLabel({ ...s, status: "due" }, T)).toBe("due now");
    expect(nextMarkLabel(null, T)).toBe("—");
    expect(nextMarkAt(s, "UTC")).toBe("3 Oct 2026, 00:00 UTC");
    expect(nextMarkAt(s, "Europe/Paris")).toBe("3 Oct 2026, 02:00 CEST");
  });

  test("cadence copy: daily per spec, any interval reads naturally, and passes the copy rules", () => {
    expect(cadenceTitle("daily")).toBe("Daily marks");
    expect(cadenceTitle("hourly")).toBe("Hourly marks");
    expect(cadenceTitle("every 5 min")).toBe("Marks every 5 min");
    const line = markCadenceLine("daily", DAY);
    expect(line).toContain("daily, 1 day");
    for (const s of [line, markCadenceLine("hourly", 3600), SIGNED_PRICE_LINE, VENUE_REPORT_LINE]) expect(checkCopy(s)).toEqual([]);
  });
});

describe("signed input freshness", () => {
  test("against maxPriceAge: fresh, aging, stale", () => {
    expect(signedFreshness(10, 300)).toBe("fresh");
    expect(signedFreshness(120, 300)).toBe("aging");
    expect(signedFreshness(301, 300)).toBe("stale");
    expect(signedFreshness(null, 300)).toBeNull();
    expect(ageOf(new Date(T - 4_000).toISOString(), T)).toBe("4s ago");
    expect(ageOf(null, T)).toBe("—");
  });
});

describe("redemption settle time", () => {
  const H = 3600;
  const P = 1_790_964_000; // a period end (2026-10-02 17:00 UTC)
  test("a request settles at ceil(eligibleAt / interval), never at the closed period whose mark is still pending", () => {
    // the 17:00 period closed and its mark is due (lastPeriodEnd 16:00): markSchedule.nextPeriodEnd is 17:00, in the past
    const due = { intervalSeconds: H, lastPeriodEnd: P - H };
    expect(redeemSettlesAt(P + 60, due)).toBe(P + H); // Senior request at 17:01 -> the 18:00 mark
    expect(redeemSettlesAt(P + 60 + 900, due)).toBe(P + H); // Junior, 15 min notice
    expect(redeemSettlesAt(P + H - 1, due)).toBe(P + H);
  });
  test("a request on a period end that has already settled goes to the next bucket", () => {
    expect(redeemSettlesAt(P, { intervalSeconds: H, lastPeriodEnd: P })).toBe(P + H);
    expect(redeemSettlesAt(P, { intervalSeconds: H, lastPeriodEnd: P - H })).toBe(P);
    expect(redeemSettlesAt(P + 1, { intervalSeconds: H, lastPeriodEnd: null })).toBe(P + H);
  });
  test("daily marks", () => {
    expect(redeemSettlesAt(sec + 60, { intervalSeconds: DAY, lastPeriodEnd: sec - DAY })).toBe(Math.ceil((sec + 60) / DAY) * DAY);
  });
});
