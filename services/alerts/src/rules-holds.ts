// Alert rules for books that are stuck in a protective hold (audit 2026-10, Task 7b). Pure functions Snapshot ->
// Conditions, like rules.ts; registered in rules.ts RULES. Hysteresis, as for the other rules: a threshold that must
// hold for a span (forSec, a count within a window, or a number of marks) before the condition fires, and the dedupe
// clearSec (ALERT_CLEAR_SECONDS) before "resolved".
//
// - held_marks_in_session:<bookId> — the newest mark is held and at least ALERT_HELD_MARKS_IN_SESSION marks of the
//   current held run were valued while the book's charter session was open. A held mark settles no redemption bucket
//   and no top-up round (audit M-1), for up to BookLogic.MAX_HELD_DEFERRAL (30 d): in session a held mark is never
//   the closed-session hold, it means a price the NAV uses is held or stale (e.g. a desk Stock Token whose price
//   stopped, or a split window). WARNING; CRITICAL once the run is ALERT_HELD_MARK_CRITICAL_SECONDS old. Resolves with
//   the first non-held mark. Books whose sessions are unknown are skipped.
// - risk_quote_unverified:<bookId> — risk holds a Live / Retiring book reduce-only because its live quote has no fresh
//   attested price to be checked against (meta.quoteUnverified, audit M-3) for ALERT_QUOTE_UNVERIFIED_SECONDS (forSec)
//   while the session is open: the book is not market-made. WARNING. A stale risk state is risk_stale's.
// - desk_stale_trade_price:<bookId> — the desk refused ALERT_STALE_TRADE_PRICE_MAX or more of the book's key swaps with
//   StaleTradePrice within ALERT_STALE_TRADE_PRICE_WINDOW_SECONDS (agent KEYS.agentDeskRejects): the agent's signed
//   prices are not reaching the desk (oracle / Redis / HTTP source) and hedging is stuck. WARNING, CRITICAL at 3x.
import { isOpen } from "@bookrunner/shared/sessions";
import type { RuleConfig } from "./config";
import type { BookSnap, Condition, Snapshot } from "./types";

const MARKABLE = new Set(["Live", "Retiring"]);
const ENDED = new Set(["Cancelled", "Retired"]);

const label = (b: BookSnap) => `book ${b.bookId} ${b.name ?? b.symbol}`;
const iso = (unixSec: number) => new Date(unixSec * 1000).toISOString().replace(/\.000Z$/, "Z");
const dur = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${(s / 86_400).toFixed(1)}d`;
};

export function heldMarksInSession(s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  const nowSec = s.now / 1000;
  for (const b of s.books ?? []) {
    const marks = b.recentMarks ?? [];
    if (!MARKABLE.has(b.state) || !b.sessions || !marks[0]?.held) continue;
    const sessions = b.sessions;
    const firstUnheld = marks.findIndex((m) => !m.held);
    const run = firstUnheld < 0 ? marks : marks.slice(0, firstUnheld);
    const inSession = run.filter((m) => isOpen(sessions, new Date(m.periodEnd * 1000)));
    if (inSession.length < c.heldMarksInSession) continue;
    // the run started after the last non-held mark (unknown beyond the window: at least the oldest held one seen)
    const since = firstUnheld < 0 ? run[run.length - 1]!.periodEnd : marks[firstUnheld]!.periodEnd;
    const heldFor = nowSec - since;
    out.push({
      key: `held_marks_in_session:${b.bookId}`,
      rule: "held_marks_in_session",
      severity: heldFor >= c.heldMarkCriticalSec ? "critical" : "warning",
      summary: `${label(b)}: ${inSession.length} of its last ${run.length} marks HELD while the session was open (newest period end ${iso(marks[0]!.periodEnd)}; no settled mark for ${firstUnheld < 0 ? "at least " : ""}${dur(heldFor)}): held marks settle no redemption or top-up (up to 30 d). A price the NAV uses is held or stale in session (desk token price stopped? split window?): see the mark service log "held" reasons`,
    });
  }
  return out;
}

export function riskQuoteUnverified(s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  const now = new Date(s.now);
  for (const b of s.books ?? []) {
    const r = b.risk;
    if (!MARKABLE.has(b.state) || !r?.quoteUnverified || !b.sessions || !isOpen(b.sessions, now)) continue;
    if (r.ts == null || (s.now - r.ts) / 1000 > c.riskStaleSec) continue; // risk_stale's
    out.push({
      key: `risk_quote_unverified:${b.bookId}`,
      rule: "risk_quote_unverified",
      severity: "warning",
      forSec: c.quoteUnverifiedSec,
      summary: `${label(b)}: held REDUCE-ONLY by risk for over ${dur(c.quoteUnverifiedSec)} in session: its live quote has no fresh attested price to be checked against (quoteUnverified, audit M-3), so the book is not market-made. Check the oracle (signed prices in Redis, on-chain price age) and risk's signed-feed reads`,
    });
  }
  return out;
}

export function deskStaleTradePrice(s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  const from = s.now - c.staleTradePriceWindowSec * 1000;
  for (const b of s.books ?? []) {
    if (ENDED.has(b.state)) continue;
    const n = (b.deskStaleTradePrice ?? []).filter((t) => t > from && t <= s.now + 60_000).length;
    if (n < c.staleTradePriceMax) continue;
    out.push({
      key: `desk_stale_trade_price:${b.bookId}`,
      rule: "desk_stale_trade_price",
      severity: n >= 3 * c.staleTradePriceMax ? "critical" : "warning",
      summary: `${label(b)}: the desk refused ${n} key swaps (Hedge / Flatten) with StaleTradePrice in the last ${dur(c.staleTradePriceWindowSec)} (limit ${c.staleTradePriceMax}): the traded token's price was older than min(maxPriceAge, maxTradePriceAge), so hedging is stuck. Check that the agent gets fresh signed prices (oracle bundle in Redis / ORACLE_URL) and the oracle is publishing`,
    });
  }
  return out;
}

export const HOLD_RULES = {
  held_marks_in_session: heldMarksInSession,
  risk_quote_unverified: riskQuoteUnverified,
  desk_stale_trade_price: deskStaleTradePrice,
} as const;
