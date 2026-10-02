import { describe, expect, test } from "bun:test";
import { checkCopy } from "@bookrunner/shared/copy";
import { SIGNED_PRICE_LINE, VENUE_REPORT_LINE, ageOf, cadenceTitle, markCadenceLine, nextMarkAt, nextMarkLabel, signedFreshness } from "../src/lib/lowgas";

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
    expect(nextMarkAt(s)).toBe("2026-10-03 00:00 UTC");
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
