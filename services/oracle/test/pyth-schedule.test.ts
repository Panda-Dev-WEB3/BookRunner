// Pyth's published US-equity session schedule (fixture = /v1/symbols market_session_schedule, 2026-10-17) vs the
// charter 24/5 calendar: after the holiday-eve / early-close rules (sessions.ts) the calendar is never open while
// Pyth is closed; source-check reports any such window.
import { describe, expect, test } from "bun:test";
import { MULTIPLIER_VECTOR as V, SESSIONS_24X5, SESSIONS_24X7, loadChainPriceConfig } from "@bookrunner/shared";
import { fetchPythCalendar } from "../src/cli/source-check";
import { resolveFeeds } from "../src/config";
import { compareCalendars, parsePythSchedule, pythOpen, schedulesById } from "../src/pyth-schedule";
import { runSourceCheck } from "../src/source-check";
import fixture from "./fixtures/pyth-equity-schedule.json";

const SCHEDULES = schedulesById([fixture], [922]).get(922)!;
const et = (local: string, offset: "-05:00" | "-04:00") => new Date(`${local}:00${offset}`);

describe("Pyth schedule format", () => {
  test("weekly entries, ranges joined by &, O / C, MMDD overrides", () => {
    const s = parsePythSchedule("America/New_York;0000-0400&2000-2400,O,C,C,C,C,2000-2400;1125/0000-0400,1126/C");
    expect(s.weekly[0]).toEqual([
      { from: 0, to: 240 },
      { from: 1200, to: 1440 },
    ]);
    expect(s.weekly[1]).toEqual([{ from: 0, to: 1440 }]);
    expect(s.weekly[2]).toEqual([]);
    expect(s.overrides.get("1125")).toEqual([{ from: 0, to: 240 }]);
    expect(s.overrides.get("1126")).toEqual([]);
    expect(() => parsePythSchedule("America/New_York;O,O")).toThrow("7 weekly entries");
    expect(() => parsePythSchedule("America/New_York;9900-1000,O,O,O,O,O,O;")).toThrow("bad range");
    expect(() => parsePythSchedule("America/New_York;O,O,O,O,O,O,O;11/C")).toThrow("bad override");
  });

  test("open in any session; holiday overrides replace the weekly entry", () => {
    expect(SCHEDULES).toHaveLength(4); // regular, pre, post, overnight
    expect(pythOpen(SCHEDULES, et("2026-10-07T22:00", "-04:00"))).toBe(true); // Wed overnight
    expect(pythOpen(SCHEDULES, et("2026-10-10T12:00", "-04:00"))).toBe(false); // Saturday
    expect(pythOpen(SCHEDULES, et("2026-11-25T21:00", "-05:00"))).toBe(false); // Thanksgiving eve
    expect(pythOpen(SCHEDULES, et("2026-11-26T21:00", "-05:00"))).toBe(true); // Thanksgiving night overnight
    expect(pythOpen(SCHEDULES, et("2026-11-27T16:30", "-05:00"))).toBe(true); // early-close post-market
    expect(pythOpen(SCHEDULES, et("2026-11-27T17:30", "-05:00"))).toBe(false);
  });
});

describe("charter 24/5 calendar vs Pyth", () => {
  test("Thanksgiving to MLK 2026-27: never open while Pyth is closed (only held windows on holiday nights)", () => {
    const d = compareCalendars({ ours: SESSIONS_24X5, pyth: SCHEDULES, fromMs: Date.parse("2026-11-20T00:00:00Z"), days: 62, stepMin: 15 });
    expect(d.oursOpenPythClosed).toEqual([]);
    // Pyth opens its overnight session at 20:00 on Thanksgiving and on MLK day: the calendar holds until midnight
    expect(d.pythOpenOursClosed.map((w) => new Date(w.from).toISOString())).toEqual(["2026-11-27T01:00:00.000Z", "2027-01-19T01:00:00.000Z"]);
  });

  test("a 24x7 calendar (demo override) would be open in every Pyth gap", () => {
    const d = compareCalendars({ ours: SESSIONS_24X7, pyth: SCHEDULES, fromMs: Date.parse("2026-11-21T00:00:00Z"), days: 7, stepMin: 30 });
    expect(d.oursOpenPythClosed.length).toBeGreaterThan(0);
  });
});

describe("source-check: Pyth calendar rows", () => {
  const CONFIG = loadChainPriceConfig(4663)!;
  const FEEDS = resolveFeeds(CONFIG, {}, { defaultMaxAgeMs: 3_600_000, heartbeatGraceMs: 600_000 }).feeds;
  const T0 = Date.parse("2026-11-20T15:00:00Z"); // Fri, session open
  const reader = {
    chainId: async () => 4663,
    hasCode: async () => true,
    description: async () => "",
    tokenDecimals: async () => 18,
    decimals: async () => 8,
    latestRoundData: async () => ({ answer: V.feedAnswer, startedAt: BigInt(T0 / 1000 - 60), updatedAt: BigInt(T0 / 1000 - 60) }),
    tokenState: async () => ({ uiMultiplier: V.uiMultiplierWad, newUIMultiplier: V.uiMultiplierWad, effectiveAt: 0n, oraclePaused: false }),
  };
  const run = (p: Partial<Parameters<typeof runSourceCheck>[0]>) =>
    runSourceCheck({ chainId: 4663, config: CONFIG, feeds: { NVDA: FEEDS.NVDA! }, reader, now: () => T0, ...p });

  test("PASS when the calendar is closed wherever Pyth is; FAIL on 4663 otherwise; unreadable schedules fail", async () => {
    let rows = await run({ pythCalendar: { schedules: new Map([["NVDA", SCHEDULES]]) } });
    const row = rows.find((r) => r.check === "pyth calendar")!;
    expect(row).toMatchObject({ subject: "NVDA", status: "PASS" });
    expect(row.detail).toBe("next 30 d: calendar closed wherever Pyth is (1 window(s) held while Pyth quotes)");

    rows = await run({ sessions: SESSIONS_24X7, pythCalendar: { schedules: new Map([["NVDA", SCHEDULES]]) } });
    const bad = rows.find((r) => r.check === "pyth calendar")!;
    expect(bad.status).toBe("FAIL");
    expect(bad.detail).toContain("calendar open while Pyth is closed:");

    rows = await run({ chainId: 46630, sessions: SESSIONS_24X7, pythCalendar: { schedules: new Map([["NVDA", SCHEDULES]]) }, reader: { ...reader, chainId: async () => 46630 } });
    expect(rows.find((r) => r.check === "pyth calendar")!.status).toBe("WARN");

    rows = await run({ pythCalendar: { error: "HTTP 503 from https://pyth.dourolabs.app/v1/symbols" } });
    expect(rows.find((r) => r.subject === "pyth" && r.check === "calendar")).toMatchObject({ status: "FAIL" });
    rows = await run({ pythCalendar: { schedules: new Map([["NVDA", []]]) } });
    expect(rows.find((r) => r.check === "pyth calendar")!.status).toBe("FAIL");
  });

  test("the CLI reads the public symbols endpoint (no token) and maps feed ids to tickers", async () => {
    const urls: string[] = [];
    const cal = await fetchPythCalendar({ NVDA: 922, TSLA: 1435 }, ["NVDA", "TSLA", "GME"], async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => [fixture] };
    });
    expect(urls).toEqual(["https://pyth.dourolabs.app/v1/symbols"]);
    expect("schedules" in cal && [...cal.schedules.entries()].map(([t, s]) => [t, s.length])).toEqual([
      ["NVDA", 4],
      ["TSLA", 0], // not in the response
    ]);
    expect(await fetchPythCalendar({ NVDA: 922 }, ["NVDA"], async () => ({ ok: false, status: 503, json: async () => null }))).toEqual({
      error: "HTTP 503 from https://pyth.dourolabs.app/v1/symbols",
    });
  });
});
