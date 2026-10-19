// Alert rules for books that are stuck in a protective hold (audit 2026-10, Task 7b). Pure functions Snapshot ->
// Conditions, like rules.ts; registered in rules.ts RULES. Hysteresis, as for the other rules: a threshold that must
// hold for a span (forSec, a count within a window, or a number of marks) before the condition fires, and the dedupe
// clearSec (ALERT_CLEAR_SECONDS) before "resolved".
//
// - held_marks_in_session:<bookId> — the newest mark is held and the current held run covers the book's open session:
//   a mark of the run was valued while the charter session had been open for ALERT_HELD_MARK_SESSION_SECONDS, OR the
//   run (from its first held mark to the
//   newest) spans at least ALERT_HELD_MARK_SESSION_SECONDS of open session (the calendar sampled every 5 min). The
//   second test catches books whose marks are always valued off-session (daily 00:00 UTC marks on NYSE-RTH charters):
//   a held run that lasts through a trading day means no mark there ever settles. A held mark settles no redemption
//   bucket and no top-up round (audit M-1), for up to BookLogic.MAX_HELD_DEFERRAL (30 d); a held run through open
//   session means a price the NAV uses is held or stale (a desk Stock Token whose price stopped, a split window) or the
//   mark cadence never meets the session. A normal closed-session hold (weekend, overnight) spans no open session.
//   WARNING; CRITICAL once the run is ALERT_HELD_MARK_CRITICAL_SECONDS old. Resolves with the first non-held mark.
//   Books whose sessions are unknown are skipped.
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
    // a mark counts as valued in session only when the session had been open for heldMarkSessionSec before it: a mark
    // at the very open (24x5: Sunday 20:00 ET) may still carry the held print of the close (no weekly false warning)
    const inSession = run.filter((m) => openSecondsWithin(sessions, m.periodEnd - c.heldMarkSessionSec, m.periodEnd, c.heldMarkSessionSec) >= c.heldMarkSessionSec);
    const openSec = inSession.length > 0 ? 0 : openSecondsWithin(sessions, run[run.length - 1]!.periodEnd, marks[0]!.periodEnd, c.heldMarkSessionSec);
    if (inSession.length === 0 && openSec < c.heldMarkSessionSec) continue;
    // the run started after the last non-held mark (unknown beyond the window: at least the oldest held one seen)
    const since = firstUnheld < 0 ? run[run.length - 1]!.periodEnd : marks[firstUnheld]!.periodEnd;
    const heldFor = nowSec - since;
    out.push({
      key: `held_marks_in_session:${b.bookId}`,
      rule: "held_marks_in_session",
      severity: heldFor >= c.heldMarkCriticalSec ? "critical" : "warning",
      summary: `${label(b)}: ${inSession.length > 0 ? `${inSession.length} of its last ${run.length} marks HELD while the session was open` : `its last ${run.length} marks HELD through open session (marks valued off-session)`} (newest period end ${iso(marks[0]!.periodEnd)}; no settled mark for ${firstUnheld < 0 ? "at least " : ""}${dur(heldFor)}): held marks settle no redemption or top-up (up to 30 d). A price the NAV uses is held or stale in session (desk token price stopped? split window?), or the mark time never falls in the charter session: see the mark service log "held" reasons`,
    });
  }
  return out;
}

/** Seconds of open session in (fromSec, toSec], sampled every 5 min (at most the last 40 days), stopping at `enough`. */
export function openSecondsWithin(sessions: NonNullable<BookSnap["sessions"]>, fromSec: number, toSec: number, enough: number): number {
  const STEP = 300;
  let acc = 0;
  for (let t = Math.max(fromSec, toSec - 40 * 86_400) + STEP; t <= toSec; t += STEP) {
    if (isOpen(sessions, new Date(t * 1000))) acc += STEP;
    if (acc >= enough) break;
  }
  return acc;
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

/**
 * bus_forged_message:<source> — a service refused ALERT_FORGED_MESSAGES_MAX or more forged bus messages (unsigned or
 * wrongly signed kill orders, agent quotes not signed by an active desk key) within ALERT_FORGED_MESSAGES_WINDOW_SECONDS
 * (KEYS.busForged, written by the agents, ops-venue and risk): someone with Redis write access is injecting messages.
 * Nothing acted on them; WARNING, CRITICAL at 3x. Check who can reach Redis (password, bind address).
 */
export function busForgedMessages(s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  const from = s.now - c.forgedMessagesWindowSec * 1000;
  for (const f of s.busForged ?? []) {
    const recent = f.events.filter((e) => e.at > from && e.at <= s.now + 60_000);
    if (recent.length < c.forgedMessagesMax) continue;
    const kinds = [...new Set(recent.map((e) => e.kind))].join(" / ");
    out.push({
      key: `bus_forged_message:${f.source}`,
      rule: "bus_forged_message",
      severity: recent.length >= 3 * c.forgedMessagesMax ? "critical" : "warning",
      summary: `${f.source} refused ${recent.length} forged bus message${recent.length > 1 ? "s" : ""} (${kinds}) in the last ${dur(c.forgedMessagesWindowSec)}, latest: ${recent.at(-1)?.reason ?? "?"}. Nothing acted on them, but something with Redis write access is injecting messages: check Redis access (requirepass, bind 127.0.0.1)`,
    });
  }
  return out;
}

/**
 * agent_no_desk_key:<bookId> — the book's agent has no active desk session key on the mandate (none configured,
 * expired, revoked; KEYS.agentStatus): it runs reduce-only (an agent quotes new risk only with a key, so risk can verify
 * every quote). WARNING; CRITICAL once a Live book has been without one for ALERT_NO_DESK_KEY_CRITICAL_SECONDS. Not a
 * Redis intrusion (that is bus_forged_message): register / re-register the key (RUNBOOK "Desk session keys").
 */
export function agentNoDeskKey(s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  for (const b of s.books ?? []) {
    const st = b.agentStatus;
    if (!MARKABLE.has(b.state) || !st || st.deskKey === "active") continue;
    const since = st.deskKeySince ?? st.ts;
    const age = (s.now - since) / 1000;
    out.push({
      key: `agent_no_desk_key:${b.bookId}`,
      rule: "agent_no_desk_key",
      severity: b.state === "Live" && age >= c.noDeskKeyCriticalSec ? "critical" : "warning",
      summary: `${label(b)} (state ${b.state}): the agent has ${st.deskKey === "missing" ? "no desk session key" : "a desk session key that is no longer active on the mandate (expired, revoked or mandate killed)"} for ${dur(age)}: it quotes reduce-only (no new risk). The sponsor registers a key (MMMandate.registerKey after the operator's consentKey); RUNBOOK "Desk session keys"`,
    });
  }
  return out;
}

/**
 * risk_state_unverified:<bookId> — the agent has seen no RISK-signed risk state for ALERT_RISK_STATE_UNVERIFIED_SECONDS
 * (KEYS.agentStatus): it runs reduce-only (never halts). Risk is down / not signing, or its state in Redis is deleted or
 * forged. WARNING. risk_stale covers a risk service that stopped writing at all.
 */
export function riskStateUnverified(s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  for (const b of s.books ?? []) {
    const since = b.agentStatus?.riskStateUnverifiedSince;
    if (!MARKABLE.has(b.state) || since == null) continue;
    const age = (s.now - since) / 1000;
    if (age < c.riskStateUnverifiedSec) continue;
    out.push({
      key: `risk_state_unverified:${b.bookId}`,
      rule: "risk_state_unverified",
      severity: "warning",
      summary: `${label(b)}: no RISK-signed risk state verified by the agent for ${dur(age)}: the agent quotes reduce-only. Check the risk service (running, signing with its RISK key) and Redis (state deleted or forged? see bus_forged_message)`,
    });
  }
  return out;
}

export const HOLD_RULES = {
  held_marks_in_session: heldMarksInSession,
  risk_quote_unverified: riskQuoteUnverified,
  desk_stale_trade_price: deskStaleTradePrice,
  bus_forged_message: busForgedMessages,
  agent_no_desk_key: agentNoDeskKey,
  risk_state_unverified: riskStateUnverified,
} as const;
