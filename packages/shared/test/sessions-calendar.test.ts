// NYSE calendar closures beyond the weekly schedule (sessions.ts nyseCalendarClosed): full-day holidays, early closes
// from 17:00 ET, holiday eves from 20:00 ET (incl. the Sunday before a Monday holiday). Pyth's US-equity schedule has
// no session in those windows (https://docs.pyth.network/price-feeds/market-hours , /v1/symbols
// market_session_schedule), so the 24/5 calendar must be closed there too: prices are HELD instead of missing.
import { describe, expect, test } from "bun:test";
import { NYSE_EARLY_CLOSES, NYSE_HOLIDAYS, SESSIONS_24X5, SESSIONS_NYSE_RTH, isOpen, nyseCalendarClosed } from "../src/sessions";

/** America/New_York wall clock -> Date (EST -05:00 from Nov 1 2026 to Mar 14 2027, else EDT -04:00). */
const et = (local: string, offset: "-05:00" | "-04:00") => new Date(`${local}:00${offset}`);
const open24x5 = (local: string, offset: "-05:00" | "-04:00") => isOpen(SESSIONS_24X5, et(local, offset));

describe("NYSE calendar: holiday eves, Sundays before Monday holidays, early closes", () => {
  test("Thanksgiving week 2026: Wed eve closes at 20:00, Thu closed, Fri early close ends at 17:00", () => {
    expect(open24x5("2026-11-25T19:59", "-05:00")).toBe(true);
    expect(open24x5("2026-11-25T20:00", "-05:00")).toBe(false); // Pyth over_night 1125/0000-0400
    expect(open24x5("2026-11-25T23:30", "-05:00")).toBe(false);
    expect(open24x5("2026-11-26T12:00", "-05:00")).toBe(false); // holiday
    expect(open24x5("2026-11-27T00:30", "-05:00")).toBe(true); // overnight session of Thanksgiving night
    expect(open24x5("2026-11-27T16:59", "-05:00")).toBe(true); // post-market 13:00-17:00
    expect(open24x5("2026-11-27T17:00", "-05:00")).toBe(false); // Pyth post_market 1127/1300-1700
    expect(open24x5("2026-11-27T19:30", "-05:00")).toBe(false);
  });

  test("Christmas Eve 2026 (Thu): early close at 17:00, nothing until Monday", () => {
    expect(open24x5("2026-12-24T16:30", "-05:00")).toBe(true);
    expect(open24x5("2026-12-24T17:00", "-05:00")).toBe(false);
    expect(open24x5("2026-12-24T21:00", "-05:00")).toBe(false); // Pyth over_night 1224/0000-0400
    expect(open24x5("2026-12-25T10:00", "-05:00")).toBe(false);
  });

  test("New Year's Eve closes at 20:00 (eve of 2027-01-01)", () => {
    expect(open24x5("2026-12-31T19:59", "-05:00")).toBe(true);
    expect(open24x5("2026-12-31T20:00", "-05:00")).toBe(false); // Pyth over_night 1231/0000-0400
  });

  test("Sunday before a Monday holiday stays closed (MLK 2027-01-18, Memorial Day 2027-05-31)", () => {
    expect(open24x5("2027-01-10T20:30", "-05:00")).toBe(true); // an ordinary Sunday evening opens
    expect(open24x5("2027-01-17T20:30", "-05:00")).toBe(false); // Pyth over_night 0117/C
    expect(open24x5("2027-01-18T12:00", "-05:00")).toBe(false);
    expect(open24x5("2027-01-19T00:30", "-05:00")).toBe(true);
    expect(open24x5("2027-05-30T21:00", "-04:00")).toBe(false); // Pyth over_night 0530/C
  });

  test("Thursday before a Friday holiday closes at 20:00 (Good Friday 2027-03-26, Juneteenth 2027-06-18)", () => {
    expect(open24x5("2027-03-25T19:00", "-04:00")).toBe(true);
    expect(open24x5("2027-03-25T20:00", "-04:00")).toBe(false); // Pyth over_night 0325/0000-0400
    expect(open24x5("2027-06-17T22:00", "-04:00")).toBe(false); // Pyth over_night 0617/0000-0400
  });

  test("regular-hours calendars are unaffected (closures start after 16:00); ordinary days unchanged", () => {
    expect(isOpen(SESSIONS_NYSE_RTH, et("2026-11-27T12:00", "-05:00"))).toBe(true);
    expect(isOpen(SESSIONS_NYSE_RTH, et("2026-11-25T15:00", "-05:00"))).toBe(true);
    expect(open24x5("2026-10-07T22:00", "-04:00")).toBe(true); // ordinary Wednesday overnight
    expect(nyseCalendarClosed("2026-10-07", 23 * 60)).toBe(false);
    expect(nyseCalendarClosed("2026-11-26", 0)).toBe(true);
    expect(nyseCalendarClosed("2026-11-25", 20 * 60)).toBe(true);
    expect(nyseCalendarClosed("2026-11-27", 17 * 60 - 1)).toBe(false);
  });

  test("every early close is a trading day (not a holiday)", () => {
    for (const d of NYSE_EARLY_CLOSES) expect(NYSE_HOLIDAYS.has(d)).toBe(false);
  });
});
