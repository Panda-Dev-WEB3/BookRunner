// Task 7b alert rules: held marks in session, risk quote hold (quoteUnverified) too long, desk StaleTradePrice rate.
import { describe, expect, test } from "bun:test";
import { KEYS } from "@bookrunner/shared/queues";
import { SESSIONS_24X5, SESSIONS_24X7, SESSIONS_NYSE_RTH, encodeSessions } from "@bookrunner/shared/sessions";
import { type DbPort, collect, emptyMemory, parseDeskRejects, parseRisk, sessionsOf } from "../src/collect";
import { emptyState, step } from "../src/dedupe";
import { evaluate } from "../src/rules";
import { busForgedMessages, deskStaleTradePrice, heldMarksInSession, riskQuoteUnverified } from "../src/rules-holds";
import { NOW, NOW_S, book, rules, snap } from "./fixtures";

const keys = (cs: Array<{ key: string }>) => cs.map((c) => c.key);
// NOW = Saturday 2026-10-10 12:00Z (NYSE closed); Friday 2026-10-09 15:00Z = 11:00 EDT (NYSE open)
const FRI_OPEN = Date.UTC(2026, 9, 9, 15, 0, 0) / 1000;
const FRI_CLOSED = Date.UTC(2026, 9, 9, 22, 0, 0) / 1000; // 18:00 EDT
const H = 3600;

describe("held_marks_in_session", () => {
  test("the newest mark held while the session was open: warning, measured from the last settled mark", () => {
    const b = book({ sessions: SESSIONS_NYSE_RTH, recentMarks: [{ periodEnd: FRI_OPEN, held: true }, { periodEnd: FRI_OPEN - H, held: false }] });
    const c = heldMarksInSession(snap({ books: [b] }), rules());
    expect(keys(c)).toEqual(["held_marks_in_session:3"]);
    expect(c[0]!.severity).toBe("warning");
    expect(c[0]!.summary).toContain("1 of its last 1 marks HELD");
    expect(c[0]!.summary).toContain("2026-10-09T15:00:00Z");
  });

  test("a held weekend / overnight run (session closed at every held mark) is the normal hold: quiet", () => {
    const b = book({ sessions: SESSIONS_NYSE_RTH, recentMarks: [{ periodEnd: NOW_S - H, held: true }, { periodEnd: FRI_CLOSED, held: true }, { periodEnd: FRI_OPEN, held: false }] });
    expect(heldMarksInSession(snap({ books: [b] }), rules())).toEqual([]);
    // the same run under 24x5 sessions: Friday 18:00 EDT is still in session -> alert
    expect(keys(heldMarksInSession(snap({ books: [{ ...b, sessions: SESSIONS_24X5 }] }), rules()))).toEqual(["held_marks_in_session:3"]);
  });

  test("resolved by the first settled mark", () => {
    const settled = book({ sessions: SESSIONS_24X7, recentMarks: [{ periodEnd: NOW_S - 60, held: false }, { periodEnd: NOW_S - 60 - H, held: true }] });
    expect(heldMarksInSession(snap({ books: [settled] }), rules())).toEqual([]);
  });

  test("daily 00:00 UTC marks on an NYSE-RTH charter (always valued off-session): a held run through a trading day alerts", () => {
    const D = 86_400;
    const SAT = Date.UTC(2026, 9, 10, 0, 0, 0) / 1000; // Fri 20:00 EDT
    // Thu 00:00 settled; Fri 00:00 and Sat 00:00 held: the run spans Fri 9:30-16:00 EDT -> alert
    const fri = book({ sessions: SESSIONS_NYSE_RTH, recentMarks: [{ periodEnd: SAT, held: true }, { periodEnd: SAT - D, held: true }, { periodEnd: SAT - 2 * D, held: false }] });
    const c = heldMarksInSession(snap({ books: [fri] }), rules());
    expect(keys(c)).toEqual(["held_marks_in_session:3"]);
    expect(c[0]!.summary).toContain("HELD through open session (marks valued off-session)");
    // a weekend-only run (Sat 00:00 -> Sun 00:00 UTC, no session in between) stays quiet
    const weekend = book({ sessions: SESSIONS_NYSE_RTH, recentMarks: [{ periodEnd: SAT + D, held: true }, { periodEnd: SAT, held: true }, { periodEnd: SAT - D, held: false }] });
    expect(heldMarksInSession(snap({ now: (SAT + D + 60) * 1000, books: [weekend] }), rules())).toEqual([]);
    // one held mark alone spans nothing: quiet until the run reaches through open session
    const single = book({ sessions: SESSIONS_NYSE_RTH, recentMarks: [{ periodEnd: SAT, held: true }, { periodEnd: SAT - D, held: false }] });
    expect(heldMarksInSession(snap({ books: [single] }), rules())).toEqual([]);
    // the open-session threshold: Friday's session is 6.5 h; asking for more than that keeps the same run quiet
    expect(heldMarksInSession(snap({ books: [fri] }), rules({ heldMarkSessionSec: 7 * H }))).toEqual([]);
  });

  test("critical once the held run is ALERT_HELD_MARK_CRITICAL_SECONDS old (at least the window when no settled mark is in it)", () => {
    const marks = Array.from({ length: 30 }, (_, i) => ({ periodEnd: NOW_S - 60 - i * H, held: true }));
    const c = heldMarksInSession(snap({ books: [book({ sessions: SESSIONS_24X7, recentMarks: marks })] }), rules());
    expect(c[0]!.severity).toBe("critical");
    expect(c[0]!.summary).toContain("no settled mark for at least 29h01m");
    const short = heldMarksInSession(snap({ books: [book({ sessions: SESSIONS_24X7, recentMarks: marks.slice(0, 3) })] }), rules());
    expect(short[0]!.severity).toBe("warning");
  });

  test("unknown sessions, unmarked states and books without marks are skipped", () => {
    const marks = [{ periodEnd: NOW_S - 60, held: true }];
    expect(heldMarksInSession(snap({ books: [book({ sessions: null, recentMarks: marks })] }), rules())).toEqual([]);
    expect(heldMarksInSession(snap({ books: [book({ state: "Subscription", sessions: SESSIONS_24X7, recentMarks: marks })] }), rules())).toEqual([]);
    expect(heldMarksInSession(snap({ books: [book({ sessions: SESSIONS_24X7 })] }), rules())).toEqual([]);
  });
});

describe("risk_quote_unverified", () => {
  const held = (over: Parameters<typeof book>[0] = {}) =>
    book({ sessions: SESSIONS_24X7, risk: { state: "reduce_only", breaches: [], ts: NOW - 5_000, killed: false, killReason: null, journal: null, quoteUnverified: true }, ...over });

  test("held reduce-only for quoteUnverified in session: a warning that must hold for ALERT_QUOTE_UNVERIFIED_SECONDS", () => {
    const c = riskQuoteUnverified(snap({ books: [held()] }), rules());
    expect(c).toEqual([expect.objectContaining({ key: "risk_quote_unverified:3", severity: "warning", forSec: 300 })]);
    // dedupe: pending for 300 s, then one firing; a blip shorter than that never notifies
    let st = emptyState();
    let n = step(st, c, NOW, { clearSec: 120 });
    expect(n.notices).toEqual([]);
    st = step(n.state, [], NOW + 60_000, { clearSec: 120 }).state;
    expect(st.tracked).toEqual({});
    n = step(st, c, NOW, { clearSec: 120 });
    n = step(n.state, c, NOW + 299_000, { clearSec: 120 });
    expect(n.notices).toEqual([]);
    n = step(n.state, c, NOW + 300_000, { clearSec: 120 });
    expect(n.notices.map((x) => x.kind)).toEqual(["firing"]);
    n = step(n.state, [], NOW + 360_000, { clearSec: 120 });
    expect(n.notices).toEqual([]); // clearing
    n = step(n.state, [], NOW + 480_000, { clearSec: 120 });
    expect(n.notices.map((x) => x.kind)).toEqual(["resolved"]);
  });

  test("quiet off-session, without the flag, for a stale risk state (risk_stale's), unknown sessions or an unmarked book", () => {
    expect(riskQuoteUnverified(snap({ books: [held({ sessions: SESSIONS_NYSE_RTH })] }), rules())).toEqual([]); // Saturday
    expect(riskQuoteUnverified(snap({ now: FRI_OPEN * 1000, books: [held({ sessions: SESSIONS_NYSE_RTH, risk: { ...held().risk!, ts: FRI_OPEN * 1000 - 5_000 } })] }), rules())).toHaveLength(1);
    expect(riskQuoteUnverified(snap({ books: [held({ risk: { ...held().risk!, quoteUnverified: false } })] }), rules())).toEqual([]);
    expect(riskQuoteUnverified(snap({ books: [held({ risk: { ...held().risk!, ts: NOW - 600_000 } })] }), rules())).toEqual([]);
    expect(riskQuoteUnverified(snap({ books: [held({ sessions: null })] }), rules())).toEqual([]);
    expect(riskQuoteUnverified(snap({ books: [held({ state: "Subscription" })] }), rules())).toEqual([]);
  });
});

describe("desk_stale_trade_price", () => {
  const at = (n: number, spacingMs = 60_000) => Array.from({ length: n }, (_, i) => NOW - i * spacingMs);

  test("count within the window: quiet below the limit, warning at it, critical at 3x", () => {
    expect(deskStaleTradePrice(snap({ books: [book({ deskStaleTradePrice: at(2) })] }), rules())).toEqual([]);
    const w = deskStaleTradePrice(snap({ books: [book({ deskStaleTradePrice: at(3) })] }), rules());
    expect(w).toEqual([expect.objectContaining({ key: "desk_stale_trade_price:3", severity: "warning" })]);
    expect(w[0]!.summary).toContain("refused 3 key swaps");
    expect(deskStaleTradePrice(snap({ books: [book({ deskStaleTradePrice: at(9) })] }), rules())[0]!.severity).toBe("critical");
  });

  test("refusals older than the window age out (the rate decays); ended books are skipped", () => {
    expect(deskStaleTradePrice(snap({ books: [book({ deskStaleTradePrice: at(5, 300_000) })] }), rules())).toHaveLength(1); // 0, 5, 10 min within 15 min
    expect(deskStaleTradePrice(snap({ books: [book({ deskStaleTradePrice: at(5, 500_000) })] }), rules())).toEqual([]); // 0, 8.3 min within; 16.7 min out
    expect(deskStaleTradePrice(snap({ books: [book({ deskStaleTradePrice: at(5, 500_000) })] }), rules({ staleTradePriceWindowSec: 1_800 }))).toHaveLength(1);
    expect(deskStaleTradePrice(snap({ books: [book({ state: "Retired", deskStaleTradePrice: at(9) })] }), rules())).toEqual([]);
  });

  test("the three rules are registered and silent on a healthy snapshot", () => {
    expect(evaluate(snap({ books: [book({ sessions: SESSIONS_24X7, recentMarks: [{ periodEnd: NOW_S - 60, held: false }], deskStaleTradePrice: [] })] }), rules())).toEqual([]);
    const all = evaluate(
      snap({
        books: [
          book({
            sessions: SESSIONS_24X7,
            recentMarks: [{ periodEnd: NOW_S - 60, held: true }],
            deskStaleTradePrice: at(3),
            risk: { state: "reduce_only", breaches: [], ts: NOW - 5_000, killed: false, killReason: null, journal: null, quoteUnverified: true },
          }),
        ],
      }),
      rules(),
    );
    expect(keys(all).sort()).toEqual(["desk_stale_trade_price:3", "held_marks_in_session:3", "risk_quote_unverified:3"]);
    expect(evaluate(snap({ books: [book({ deskStaleTradePrice: at(3) })] }), rules({ disabled: new Set(["desk_stale_trade_price"]) }))).toEqual([]);
  });
});

describe("collection", () => {
  test("parsers: risk quoteUnverified, desk rejects, charter sessions (SESSIONS_MODE=24x7 wins)", () => {
    expect(parseRisk(JSON.stringify({ state: "reduce_only", meta: { ts: NOW, quoteUnverified: true } }))?.quoteUnverified).toBe(true);
    expect(parseRisk(JSON.stringify({ state: "ok", meta: { ts: NOW } }))).not.toHaveProperty("quoteUnverified");
    expect(parseDeskRejects(JSON.stringify({ v: 1, bookId: 3, ts: NOW, staleTradePrice: [NOW - 1, "x", NOW] }))).toEqual([NOW - 1, NOW]);
    expect(parseDeskRejects("nope")).toEqual([]);
    expect(parseDeskRejects(null)).toEqual([]);
    const hex = encodeSessions(SESSIONS_NYSE_RTH);
    expect(sessionsOf(hex, "charter")).toEqual(SESSIONS_NYSE_RTH);
    expect(sessionsOf(hex, "24x7")).toEqual(SESSIONS_24X7);
    expect(sessionsOf(null, "charter")).toBeNull();
    expect(sessionsOf("garbage", undefined)).toBeNull();
  });

  test("collect: sessions from the charter, recent marks newest first, desk rejects per book", async () => {
    const db: DbPort = {
      books: async () => [{ id: 3, name: "NVDA", symbol: "PERP_NVDA_USDC", state: "Live", venue: 0, subscriptionEnds: null, sessions: encodeSessions(SESSIONS_24X5) }],
      latestMarkPeriodEnds: async () => [],
      killsSince: async () => [],
      cursors: async () => [],
      recentMarks: async (n) => {
        expect(n).toBe(48);
        return [
          { bookId: 3, periodEnd: new Date((NOW_S - 2 * H) * 1000), held: null },
          { bookId: 3, periodEnd: new Date((NOW_S - H) * 1000), held: true },
        ];
      },
    };
    const kv = new Map([[KEYS.agentDeskRejects(3), JSON.stringify({ v: 1, bookId: 3, ts: NOW, staleTradePrice: [NOW - 5] })]]);
    const { snapshot } = await collect(
      {
        db,
        kv: { get: async (k) => kv.get(k) ?? null, mget: async (ks) => ks.map((k) => kv.get(k) ?? null) },
        chain: { head: async () => ({ number: 1, timestamp: NOW_S }), balance: async () => 0n, buybackPending: async () => null, markInterval: async () => null },
        fetch: (async () => new Response("{}")) as unknown as typeof fetch,
        now: () => NOW,
      },
      { network: "testnet", chainId: 46630, apiUrl: "http://api", markIntervalSec: 3600, roles: [], rpcWindowSec: 900 },
      emptyMemory(),
      86_400,
    );
    const b = snapshot.books![0]!;
    expect(b.sessions).toEqual(SESSIONS_24X5);
    expect(b.recentMarks).toEqual([
      { periodEnd: NOW_S - H, held: true },
      { periodEnd: NOW_S - 2 * H, held: false },
    ]);
    expect(b.deskStaleTradePrice).toEqual([NOW - 5]);
  });
});

describe("bus_forged_message", () => {
  const ev = (n: number, spacingMs = 60_000) => Array.from({ length: n }, (_, i) => ({ at: NOW - i * spacingMs, kind: "kill", reason: "unsigned kill message (no RISK signature)" }));

  test("forged messages refused by a service within the window: warning at the limit, critical at 3x, decays with the window", () => {
    expect(busForgedMessages(snap({ busForged: [{ source: "agent-3", events: ev(2) }] }), rules())).toEqual([]);
    const w = busForgedMessages(snap({ busForged: [{ source: "agent-3", events: ev(3) }] }), rules());
    expect(w).toEqual([expect.objectContaining({ key: "bus_forged_message:agent-3", severity: "warning" })]);
    expect(w[0]!.summary).toContain("Nothing acted on them");
    expect(busForgedMessages(snap({ busForged: [{ source: "ops-venue", events: ev(9) }] }), rules())[0]!.severity).toBe("critical");
    expect(busForgedMessages(snap({ busForged: [{ source: "risk", events: ev(3, 600_000) }] }), rules())).toEqual([]); // 0, 10, 20 min: 2 within 15
    expect(keys(evaluate(snap({ busForged: [{ source: "risk", events: ev(3) }] }), rules()))).toEqual(["bus_forged_message:risk"]);
  });

  test("collect reads every source's key (ops-venue, risk, one per book's agent)", async () => {
    const kv = new Map([
      [KEYS.busForged("agent-3"), JSON.stringify({ v: 1, source: "agent-3", ts: NOW, events: [{ at: NOW - 5, kind: "kill", reason: "x" }, { at: "bad" }] })],
      [KEYS.busForged("risk"), "garbage"],
    ]);
    const asked: string[] = [];
    const { snapshot } = await collect(
      {
        db: { books: async () => [{ id: 3, name: "NVDA", symbol: "PERP_NVDA_USDC", state: "Live", venue: 0, subscriptionEnds: null }], latestMarkPeriodEnds: async () => [], killsSince: async () => [], cursors: async () => [] },
        kv: { get: async (k) => kv.get(k) ?? null, mget: async (ks) => (asked.push(...ks), ks.map((k) => kv.get(k) ?? null)) },
        chain: { head: async () => ({ number: 1, timestamp: NOW_S }), balance: async () => 0n, buybackPending: async () => null, markInterval: async () => null },
        fetch: (async () => new Response("{}")) as unknown as typeof fetch,
        now: () => NOW,
      },
      { network: "testnet", chainId: 46630, apiUrl: "http://api", markIntervalSec: 3600, roles: [], rpcWindowSec: 900 },
      emptyMemory(),
      86_400,
    );
    expect(asked).toEqual(expect.arrayContaining([KEYS.busForged("ops-venue"), KEYS.busForged("risk"), KEYS.busForged("agent-3")]));
    expect(snapshot.busForged).toEqual([{ source: "agent-3", events: [{ at: NOW - 5, kind: "kill", reason: "x" }] }]);
  });

  test("a recentMarks failure blinds only the held-marks rule", async () => {
    const { snapshot } = await collect(
      {
        db: { books: async () => [{ id: 3, name: "NVDA", symbol: "S", state: "Live", venue: 0, subscriptionEnds: null }], latestMarkPeriodEnds: async () => [], killsSince: async () => [], cursors: async () => [], recentMarks: async () => Promise.reject(new Error("bad cast")) },
        kv: { get: async () => null, mget: async (ks) => ks.map(() => null) },
        chain: { head: async () => ({ number: 1, timestamp: NOW_S }), balance: async () => 0n, buybackPending: async () => null, markInterval: async () => null },
        fetch: (async () => new Response("{}")) as unknown as typeof fetch,
        now: () => NOW,
      },
      { network: "testnet", chainId: 46630, apiUrl: "http://api", markIntervalSec: 3600, roles: [], rpcWindowSec: 900 },
      emptyMemory(),
      86_400,
    );
    expect(snapshot.books).toHaveLength(1);
    expect(snapshot.books![0]!.recentMarks).toEqual([]);
    expect(snapshot.infraErrors).toEqual([]);
  });
});
