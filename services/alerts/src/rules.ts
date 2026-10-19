// Alert rules: pure functions Snapshot -> active Conditions. Each returns the conditions that hold NOW;
// the dedupe state machine (dedupe.ts) turns "holds now" into one notification when it starts and one
// "resolved" when it stops. Keys are stable per (rule, subject) so the same problem never alerts twice.
import { formatEther } from "viem";
import type { RuleConfig } from "./config";
import { HOLD_RULES } from "./rules-holds";
import type { BookSnap, Condition, OracleConfirmSnap, OracleProbe, OracleSourceSnap, Sample, Snapshot } from "./types";

/** States in which a book is marked every period (Book.sol: Live and Retiring). */
const MARKABLE = new Set(["Live", "Retiring"]);
/** Terminal book states: nothing of the book is left on a venue. */
const ENDED = new Set(["Cancelled", "Retired"]);

export function dur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${(s / 86_400).toFixed(1)}d`;
}

const bookLabel = (b: BookSnap) => `book ${b.bookId} ${b.name ?? b.symbol}`;
const iso = (unixSec: number) => new Date(unixSec * 1000).toISOString().replace(/\.000Z$/, "Z");

// ------------------------------------------------------------------ books: marks
/** The newest mark of a markable book is older than markInterval + grace (the next one is overdue). */
export function markOverdue(s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  const nowSec = s.now / 1000;
  for (const b of s.books ?? []) {
    if (!MARKABLE.has(b.state)) continue;
    const ref = b.lastMarkPeriodEnd ?? b.liveSince;
    if (ref == null) continue;
    const age = nowSec - ref;
    const limit = s.markIntervalSec + c.markGraceSec;
    if (age <= limit) continue;
    const what = b.lastMarkPeriodEnd == null ? `no mark since it went live at ${iso(ref)}` : `latest mark (period end ${iso(ref)}) is ${dur(age)} old`;
    out.push({
      key: `mark_overdue:${b.bookId}`,
      rule: "mark_overdue",
      // a whole extra period missed: the book's NAV, redemptions and distributions are stuck
      severity: age > 2 * s.markIntervalSec + c.markGraceSec ? "critical" : "warning",
      summary: `${bookLabel(b)}: ${what}; limit ${dur(limit)} (interval ${dur(s.markIntervalSec)} + grace ${dur(c.markGraceSec)})`,
    });
  }
  return out;
}

// ------------------------------------------------------------------ books: risk
/** Mandate killed (risk state), a limit breach, or (opt-in) warn / reduce_only. */
export function riskState(s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  for (const b of s.books ?? []) {
    const r = b.risk;
    if (!r) continue;
    if (r.killed || r.state === "killed") {
      out.push({
        key: `mandate_killed:${b.bookId}`,
        rule: "mandate_killed",
        severity: "critical",
        summary: `${bookLabel(b)}: mandate KILLED${r.killReason ? ` (${r.killReason})` : ""}${r.breaches.length ? `; breaches: ${r.breaches.join(", ")}` : ""}`,
      });
    } else if (r.state === "breach") {
      out.push({
        key: `risk_breach:${b.bookId}`,
        rule: "risk_breach",
        severity: "critical",
        summary: `${bookLabel(b)}: risk limit breach: ${r.breaches.join(", ") || "(no detail)"}`,
      });
    } else if (c.riskWarn && (r.state === "warn" || r.state === "reduce_only")) {
      out.push({ key: `risk_warn:${b.bookId}`, rule: "risk_warn", severity: "warning", summary: `${bookLabel(b)}: risk state ${r.state}`, forSec: 300 });
    }
  }
  return out;
}

const usdFmt = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Engine books (Task 7, audit M-3 budget breach): the pool has lost more than its per-period loss budget against the
 * oracle (PoolEngine.lossBudget via the risk service's meta.lossBudget). The engine already refuses new risk until
 * the next period and emits LossBudgetBreached; this pages the operator, because a pool losing the mandate's
 * drawdown-kill share of its equity inside one mark interval is either a large move or a loss channel the quote rule
 * does not cover. Critical; resolves when the next period re-anchors.
 */
export function engineLossBudget(s: Snapshot, _c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  for (const b of s.books ?? []) {
    const lb = b.risk?.lossBudget;
    if (!lb?.blocked || ENDED.has(b.state)) continue;
    out.push({
      key: `engine_loss_budget:${b.bookId}`,
      rule: "engine_loss_budget",
      severity: "critical",
      summary: `${bookLabel(b)}: the engine pool lost ${usdFmt(lb.lossUsd)} this period against its loss budget of ${usdFmt(lb.budgetUsd)} (${lb.budgetBps} bps) in period ${lb.period}: new risk is refused until the next period; check the market move, quotes and liquidations`,
    });
  }
  return out;
}

/**
 * Engine books (Task 7c, 7a review M-6): the risk service publishes meta.lossBudget = null because its
 * PoolEngine.lossBudget read failed (RPC errors, a pre-M-3 engine, an adapter without marketId / engine), so
 * engine_loss_budget cannot fire for the book. Only a fresh risk state of a markable, unkilled engine book counts
 * (risk_stale and mandate_killed cover the others); Orderly books always publish null and are skipped. Warning after
 * ALERT_LOSS_BUDGET_UNREADABLE_SECONDS (forSec: a failed read or two never fires); resolves after the dedupe clear
 * window once a read succeeds again. The engine enforces the budget on-chain whatever this alert says.
 */
export function engineLossBudgetUnreadable(s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  for (const b of s.books ?? []) {
    const r = b.risk;
    if (b.venue !== "pool_engine" || !MARKABLE.has(b.state) || !r?.lossBudgetUnreadable || r.killed || r.state === "killed") continue;
    if (r.ts == null || (s.now - r.ts) / 1000 > c.riskStaleSec) continue;
    out.push({
      key: `engine_loss_budget_unreadable:${b.bookId}`,
      rule: "engine_loss_budget_unreadable",
      severity: "warning",
      forSec: c.lossBudgetUnreadableSec,
      summary: `${bookLabel(b)}: the risk service cannot read PoolEngine.lossBudget for this engine book (meta.lossBudget is null) for ${dur(c.lossBudgetUnreadableSec)}+: engine_loss_budget cannot fire; check the risk service's RPC and the book's adapter (marketId, engine)`,
    });
  }
  return out;
}

/** An open kill journal = a kill sequence that has started; failed steps or a long run = stuck. */
export function killJournal(s: Snapshot, _c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  const nowSec = s.now / 1000;
  for (const b of s.books ?? []) {
    const j = b.risk?.journal;
    if (!j) continue;
    const failed = Object.entries(j.failed).filter(([, n]) => n > 0);
    const age = nowSec - j.startedAt;
    if (failed.length === 0 && age < 600) {
      out.push({
        key: `kill_in_progress:${b.bookId}:${j.episodeId}`,
        rule: "kill_in_progress",
        severity: "critical",
        notifyResolve: false,
        summary: `${bookLabel(b)}: kill sequence running (${j.mode}: ${j.reason}); done: ${j.done.join(", ") || "none yet"}`,
      });
    } else {
      out.push({
        key: `kill_stuck:${b.bookId}:${j.episodeId}`,
        rule: "kill_stuck",
        severity: "critical",
        summary: `${bookLabel(b)}: kill sequence INCOMPLETE after ${dur(age)} (${j.reason}); failed: ${failed.map(([k, n]) => `${k}×${n}`).join(", ") || "none"}; done: ${j.done.join(", ") || "none"}`,
      });
    }
  }
  return out;
}

/** Every kill recorded by the indexer (kill_events) within the lookback: one notification each. */
export function killEvents(s: Snapshot, _c: RuleConfig): Condition[] {
  const books = new Map((s.books ?? []).map((b) => [b.bookId, b]));
  return s.kills.map((k) => {
    const b = books.get(k.bookId);
    return {
      key: `kill_event:${k.id}`,
      rule: "kill_event",
      severity: "critical" as const,
      notifyResolve: false,
      summary: `${b ? bookLabel(b) : `book ${k.bookId}`}: kill recorded at ${new Date(k.ts).toISOString()}: ${k.reason}${k.breaches.length ? ` (${k.breaches.join(", ")})` : ""}`,
    };
  });
}

/** The risk service has not refreshed a live book's state (it is down or stuck on that book). */
export function riskStale(s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  for (const b of s.books ?? []) {
    if (!MARKABLE.has(b.state)) continue;
    const ts = b.risk?.ts ?? null;
    const age = ts == null ? null : (s.now - ts) / 1000;
    if (age !== null && age <= c.riskStaleSec) continue;
    out.push({
      key: `risk_stale:${b.bookId}`,
      rule: "risk_stale",
      severity: "critical",
      forSec: 60,
      summary: `${bookLabel(b)}: ${age === null ? "no risk state in Redis" : `risk state not updated for ${dur(age)}`} (limit ${dur(c.riskStaleSec)}): limits are not being enforced`,
    });
  }
  return out;
}

/**
 * Orderly books ops-venue tracks WITHOUT listing or trading (live mode, the charter symbol names no Orderly market):
 * capital can sit on the venue with no market-making; it needs an operator decision (retire / re-charter).
 */
export function venueSymbol(s: Snapshot, _c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  for (const b of s.books ?? []) {
    // a Cancelled / Retired book holds nothing on the venue any more: nothing to decide
    if (b.venue !== "orderly" || !b.venueSymbolError || ENDED.has(b.state)) continue;
    out.push({
      key: `venue_symbol_unmapped:${b.bookId}`,
      rule: "venue_symbol_unmapped",
      severity: "critical",
      summary: `${bookLabel(b)} (state ${b.state}): not listed or traded on Orderly: ${b.venueSymbolError}. Reports and withdrawals still run; retire or re-charter the book`,
    });
  }
  return out;
}

/** Books whose Orderly market must exist: listing alerts never look at Cancelled / Retired books. */
const LISTED_STATES = new Set(["Subscription", "Live", "Retiring"]);

/**
 * Orderly market state of each book's venue symbol (ops-venue listing check, KEYS.venueSymbolIssues markets; docs/VERIFY.md
 * O20). One alert per book and condition; Cancelled / Retired books are ignored.
 * - venue_listing_pending:<bookId> (never listed: absent / NEW / PENDING). Manual mode (the admin lists it in Orderly
 *   One): WARNING while the book is in Subscription or Retiring and during its first ALERT_LISTING_LIVE_GRACE_SECONDS
 *   (1800) Live; CRITICAL after that (capital is on the venue with no market). Api mode: only with ORDERLY_MODE=live and
 *   a Live book (warning, then critical after the same grace); api + mock (devnet) never alerts (PENDING until the IF is
 *   funded is normal there).
 * - venue_market_restricted:<bookId> (listed, not open for new risk; the agent is reduce-only, except POST_ONLY with
 *   ORDERLY_MODE=live where it quotes maker-only by default): a Live book on DELISTING / DELISTED = CRITICAL; REDUCE_ONLY,
 *   POST_ONLY or an undocumented status = WARNING; a Subscription book on a REDUCE_ONLY / DELISTING / DELISTED market =
 *   WARNING; Retiring books are expected to wind down (no alert).
 * - venue_market_missing:<bookId> (was listed, now absent from /v1/public/info): Live = CRITICAL; Retiring = WARNING
 *   once (one-off: the admin may have delisted it for the retirement; ops-venue logs the IF withdrawal completing).
 * - venue_listing_check:<bookId>: the market's listing check failed ALERT_LISTING_CHECK_FAILURES (5) times in a row
 *   (WARNING; the last known state stays in force).
 * - venue_delist_pending:<bookId>: manual mode, a retiring book's IF withdrawal waits for the admin's delisting in
 *   Orderly One: WARNING, CRITICAL after ALERT_DELIST_WAIT_CRITICAL_SECONDS (6 h).
 */
export function venueListing(s: Snapshot, c: RuleConfig): Condition[] {
  const ops = s.venueOps;
  if (!ops) return [];
  const out: Condition[] = [];
  for (const b of s.books ?? []) {
    if (b.venue !== "orderly" || !LISTED_STATES.has(b.state)) continue;
    const m = b.venueMarket;
    if (b.delistWaitSince != null) {
      const wait = (s.now - b.delistWaitSince) / 1000;
      out.push({
        key: `venue_delist_pending:${b.bookId}`,
        rule: "venue_delist_pending",
        severity: wait >= c.delistWaitCriticalSec ? "critical" : "warning",
        summary: `${bookLabel(b)} (state ${b.state}): its insurance-fund withdrawal has waited ${dur(wait)} for the market${m ? ` ${m.symbol}` : ""} to be delisted in Orderly One (manual listing mode): delist it there; ops-venue re-tries every minute`,
      });
    }
    if (!m) continue;
    if (m.failures >= c.listingCheckFailures) {
      out.push({
        key: `venue_listing_check:${b.bookId}`,
        rule: "venue_listing_check",
        severity: "warning",
        summary: `${bookLabel(b)}: the Orderly listing check of ${m.symbol} failed ${m.failures} times in a row (${m.error ?? "?"}); last known state ${m.phase}${m.venueStatus ? ` ${m.venueStatus}` : ""}`,
      });
    }
    const status = m.venueStatus ? `Orderly status ${m.venueStatus}` : "not on /v1/public/info";
    if (m.phase === "awaiting") {
      const manual = ops.listingMode === "manual";
      if (!manual && !(ops.mode === "live" && b.state === "Live")) continue;
      // never listed: the market has been missing for as long as the book is Live (ops-venue's `since` resets on restart)
      const liveFor = b.state === "Live" ? (s.now - (b.liveSince != null ? b.liveSince * 1000 : m.since)) / 1000 : 0;
      const critical = b.state === "Live" && liveFor >= c.listingLiveGraceSec;
      const where = manual ? "awaiting listing in Orderly One" : "not launched on Orderly (listing API)";
      out.push({
        key: `venue_listing_pending:${b.bookId}`,
        rule: "venue_listing_pending",
        severity: critical ? "critical" : "warning",
        summary: `${bookLabel(b)} (state ${b.state}): ${m.symbol} ${where} for ${dur((s.now - m.since) / 1000)} (${status})${manual ? ". The admin lists it in Orderly One (dex.orderly.network, price source ORACLE_<broker>, the book's IF account)" : ""}${b.state === "Live" ? `; the book is Live${critical ? ` for ${dur(liveFor)} with no market: its capital cannot be market-made` : " (the agent is reduce-only)"}` : ""}`,
      });
    } else if (m.phase === "missing") {
      if (b.state === "Subscription") continue;
      const live = b.state === "Live";
      out.push({
        key: `venue_market_missing:${b.bookId}`,
        rule: "venue_market_missing",
        severity: live ? "critical" : "warning",
        ...(live ? {} : { notifyResolve: false }),
        summary: `${bookLabel(b)} (state ${b.state}): ${m.symbol} was listed on Orderly and is now missing from /v1/public/info${live ? ": the book is Live with no market (the agent is reduce-only); check the market in Orderly One" : " (delisted for the retirement? expected once the admin delisted it)"}`,
      });
    } else if (m.phase === "listed" && !m.openForRisk) {
      const st = (m.venueStatus ?? "").toUpperCase();
      const ending = st === "DELISTING" || st === "DELISTED";
      if (b.state === "Retiring") continue;
      if (b.state === "Subscription" && !(ending || st === "REDUCE_ONLY")) continue;
      // POST_ONLY: the agents' AGENT_VENUE_POST_ONLY_QUOTE (read from the same stack env; unset = the agent default,
      // true with ORDERLY_MODE=live) decides between maker-only two-sided quoting and reduce-only
      const postOnlyQuoted = st === "POST_ONLY" && (c.venuePostOnlyQuote ?? ops.mode === "live");
      out.push({
        key: `venue_market_restricted:${b.bookId}`,
        rule: "venue_market_restricted",
        severity: b.state === "Live" && ending ? "critical" : "warning",
        summary: `${bookLabel(b)} (state ${b.state}): Orderly market ${m.symbol} is ${m.venueStatus ?? "restricted"} since ${new Date(m.since).toISOString()}: ${postOnlyQuoted ? "limit orders only until the depth warning holds; the agent quotes both sides maker-only (POST_ONLY orders, AGENT_VENUE_POST_ONLY_QUOTE) to build the launch depth" : `no new risk (the agent is reduce-only)${ending ? "; the market is being delisted" : st === "POST_ONLY" ? "; limit orders only until the depth warning holds" : ""}`}`,
      });
    }
  }
  return out;
}

/**
 * Insurance-fund account of each Orderly book (ops-venue ORDERLY_IF_MODE, KEYS.venueSymbolIssues ifAccounts /
 * ifOperatorWaits; docs/VERIFY.md O10). Cancelled / Retired books are ignored, except venue_if_operator_pending and
 * venue_withdraw_failed (an unreturned IF payout or a failed saga matters in any state, e.g. a Retired book's last IF recall).
 * - venue_if_account:<bookId> mismatch (the adapter's on-chain IF binding does not match ORDERLY_IF_MODE /
 *   ORDERLY_IF_BUILDER_ACCOUNTS: no IF provisioning, no api-mode listing): WARNING in Subscription, CRITICAL once Live /
 *   Retiring (the IF capital sits on an account ops-venue does not manage). key_pending (builder mode: ops-venue's IF key
 *   is not registered for the builder IF account yet, so the book's venue reports fail): WARNING.
 *   prior_equity (builder mode: the EOA's account held equity before the book's IF deposit; reports refused): CRITICAL.
 *   reassign (the IF account switched: the admin re-assigns the market's IF account in Orderly One): WARNING.
 * - venue_if_operator_pending:<bookId>:<nonce> (builder mode): an IF withdrawal waits for the operator (withdraw on Orderly
 *   to the IF account's wallet / transfer it back to the adapter): WARNING, CRITICAL after ALERT_IF_OPERATOR_WAIT_CRITICAL_SECONDS
 *   (6 h), and CRITICAL once ops-venue wrote the unreturned payout off from NAV.
 * - venue_if_unadopted_withdrawal:<bookId>:<id> (builder mode): a withdrawal from the builder IF account that no on-chain
 *   request asked for (the operator's key moved IF capital): CRITICAL.
 * - venue_if_equity_drop:<bookId> (builder mode): the venue's IF equity is below the adapter's insurance with no on-chain
 *   flow: CRITICAL.
 * - venue_withdraw_failed:<bookId>:<nonce> (any mode): an ops-venue withdraw saga FAILED (terminal, manual action):
 *   CRITICAL for the IF account, WARNING for MM. Not limited to listed states: a failed saga matters until pruned.
 */
export function venueIfAccount(s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  for (const b of s.books ?? []) {
    if (b.venue !== "orderly") continue;
    for (const f of b.failedWithdrawals ?? []) {
      const isIf = f.account === 0;
      out.push({
        key: `venue_withdraw_failed:${b.bookId}:${f.nonce}`,
        rule: "venue_withdraw_failed",
        severity: isIf ? "critical" : "warning",
        summary: `${bookLabel(b)} (state ${b.state}): the ${isIf ? "insurance-fund" : "MM"} withdrawal #${f.nonce} (${(Number(f.amount) / 1e6).toLocaleString("en-US")} USD) FAILED in ops-venue (${f.error || "?"}): manual action — reconcile the venue and the adapter's request`,
      });
    }
    // an unreturned / not-yet-withdrawn IF payout matters whatever the book's state (a Retired book's last IF recall too)
    for (const w of b.ifOperatorWaits ?? []) {
      const wait = (s.now - w.since) / 1000;
      const usd = Number(w.amount) / 1e6;
      out.push({
        key: `venue_if_operator_pending:${b.bookId}:${w.nonce}`,
        rule: "venue_if_operator_pending",
        severity: wait >= c.ifOperatorWaitCriticalSec || w.writtenOffAt != null ? "critical" : "warning",
        summary:
          w.step === "payout"
            ? `${bookLabel(b)} (state ${b.state}): insurance-fund withdrawal #${w.nonce} (${usd.toLocaleString("en-US")} USD) was confirmed on-chain ${dur(wait)} ago and is not back on the adapter (Orderly has not visibly paid it to the operator's wallet ${w.owner}: check it on Orderly)${w.writtenOffAt != null ? `; WRITTEN OFF from NAV ${dur((s.now - w.writtenOffAt) / 1000)} ago (a late return is swept as a gain)` : "; it is written off from NAV after OPS_IF_RETURN_WRITE_OFF_MS"}`
            : w.step === "withdraw"
            ? `${bookLabel(b)} (state ${b.state}): insurance-fund withdrawal #${w.nonce} (${usd.toLocaleString("en-US")} USD) has waited ${dur(wait)} for the operator: withdraw it promptly on Orderly from the builder IF account (wallet ${w.owner}; until then the book's venue reports are frozen), then transfer it to the adapter ${w.adapter}`
            : `${bookLabel(b)} (state ${b.state}): Orderly paid insurance-fund withdrawal #${w.nonce} (${usd.toLocaleString("en-US")} USD) to the operator's wallet ${w.owner} ${dur(wait)} ago: transfer it (one transfer, the full amount) to the adapter ${w.adapter}${w.writtenOffAt != null ? `; WRITTEN OFF from NAV ${dur((s.now - w.writtenOffAt) / 1000)} ago (a late return is swept as a gain)` : ""}`,
      });
    }
    if (!LISTED_STATES.has(b.state)) continue;
    const i = b.ifAccountIssue;
    if (i) {
      const live = b.state === "Live" || b.state === "Retiring";
      out.push({
        key: `venue_if_account:${b.bookId}`,
        rule: "venue_if_account",
        severity: (i.issue === "mismatch" && live) || i.issue === "prior_equity" ? "critical" : "warning",
        summary:
          i.issue === "mismatch"
            ? `${bookLabel(b)} (state ${b.state}): its insurance-fund account ${i.accountId} does not match ops-venue's ORDERLY_IF_MODE: ${i.detail}`
            : i.issue === "prior_equity"
              ? `${bookLabel(b)} (state ${b.state}): builder IF account ${i.accountId}: ${i.detail}`
              : i.issue === "reassign"
                ? `${bookLabel(b)} (state ${b.state}): ${i.detail}`
                : `${bookLabel(b)} (state ${b.state}): builder IF account ${i.accountId} waits${i.since != null ? ` ${dur((s.now - i.since) / 1000)}` : ""} for ops-venue's Orderly key (${i.detail}); until then its venue reports fail`,
      });
    }
    for (const u of b.ifUnadopted ?? []) {
      out.push({
        key: `venue_if_unadopted_withdrawal:${b.bookId}:${u.id}`,
        rule: "venue_if_unadopted_withdrawal",
        severity: "critical",
        summary: `${bookLabel(b)} (state ${b.state}): Orderly withdrawal ${u.id} (${(Number(u.amount) / 1e6).toLocaleString("en-US")} USD, ${u.status}) left the builder IF account without any on-chain request — the operator's key moved insurance-fund capital: investigate (ops-venue OPS_IF_WITHDRAW_ACK once reviewed)`,
      });
    }
    const d = b.ifEquityDrop;
    if (d) {
      out.push({
        key: `venue_if_equity_drop:${b.bookId}`,
        rule: "venue_if_equity_drop",
        severity: "critical",
        summary: `${bookLabel(b)} (state ${b.state}): builder IF account equity ${(Number(d.venueUsd) / 1e6).toLocaleString("en-US")} USD is below the adapter's insurance ${(Number(d.expectedUsd) / 1e6).toLocaleString("en-US")} USD with no on-chain flow (operator key? insurance use?): investigate`,
      });
    }
  }
  return out;
}

/**
 * Live builder price push (ops-venue -> Orderly Builder Oracle, docs/VERIFY.md O18). Orderly needs >= 1 price/s per
 * builder market while the session is open, else it can restrict the market (reduce-only). held (session closed) is
 * not a failure. The span is measured up to ops-venue's own status time (never grows on a stale status); the status key
 * lives 600 s, far beyond these thresholds, so a stalled or stopped push is seen as an old status, then as a missing one.
 * - builder_price_push:<symbol> CRITICAL: failing (stale / no-price / disconnected / rejected / ...) >= builderPushFailSec.
 *   Not paged while the market is not listed on Orderly yet (preListing: ops-venue's listing check, before it every book
 *   on the symbol in Subscription; listed by hand in Orderly One, VERIFY O20 / venue_listing_pending; ops-venue logs it).
 * - builder_price_push_status CRITICAL: the status is older than builderPushFailSec + 30 s (push loop stalled), or it is
 *   missing while ops-venue reports live mode with the push enabled and an Orderly book is Live / Retiring.
 */
export function builderPricePush(s: Snapshot, c: RuleConfig): Condition[] {
  const f = s.builderFeed;
  const out: Condition[] = [];
  if (!f) {
    const ops = s.venueOps;
    const fed = (s.books ?? []).filter((b) => b.venue === "orderly" && MARKABLE.has(b.state));
    if (ops?.mode === "live" && ops.builderPush && fed.length > 0) {
      out.push({
        key: "builder_price_push_status",
        rule: "builder_price_push",
        severity: "critical",
        forSec: 60,
        summary: `no live builder price push status from ops-venue (ORDERLY_MODE=live, push enabled, ${fed.length} Orderly book${fed.length > 1 ? "s" : ""} live): Orderly builder markets may not be receiving prices`,
      });
    }
    return out;
  }
  const statusAge = (s.now - f.ts) / 1000;
  if (statusAge > c.builderPushFailSec + 30) {
    out.push({
      key: "builder_price_push_status",
      rule: "builder_price_push",
      severity: "critical",
      summary: `ops-venue's live builder price push status is ${dur(statusAge)} old (push loop stalled or ops-venue stopped): Orderly builder markets may not be receiving prices`,
    });
  }
  for (const x of f.symbols) {
    if (x.failingSince == null || x.preListing) continue;
    const span = (f.ts - x.failingSince) / 1000;
    if (span < c.builderPushFailSec) continue;
    const books = x.bookIds.length ? ` (book${x.bookIds.length > 1 ? "s" : ""} ${x.bookIds.join(", ")})` : "";
    out.push({
      key: `builder_price_push:${x.symbol}`,
      rule: "builder_price_push",
      severity: "critical",
      summary: `Orderly builder price for ${x.symbol}${books} not pushed for ${dur(span)} in session (${x.state}${x.error ? `: ${x.error}` : ""}): Orderly may restrict the market to reduce-only`,
    });
  }
  return out;
}

/** Orderly books: the signed venue report (ops-venue -> Redis, relayed in the mark tx) is too old or missing. */
export function venueReportAge(s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  for (const b of s.books ?? []) {
    if (b.venue !== "orderly" || !MARKABLE.has(b.state)) continue;
    const age = b.venueReportAsOf == null ? null : s.now / 1000 - b.venueReportAsOf;
    if (age !== null && age <= c.venueReportMaxAgeSec) continue;
    out.push({
      key: `venue_report_stale:${b.bookId}`,
      rule: "venue_report_stale",
      severity: "warning",
      forSec: 120,
      summary: `${bookLabel(b)}: ${age === null ? "no signed venue report in Redis" : `signed venue report is ${dur(age)} old`} (limit ${dur(c.venueReportMaxAgeSec)}): the next mark cannot carry a fresh report`,
    });
  }
  return out;
}

// ------------------------------------------------------------------ processes (supervisor heartbeat)
export function processes(s: Snapshot, c: RuleConfig): Condition[] {
  if (s.supervisor === undefined) return []; // Redis unreachable: reported by infra()
  if (s.supervisor === null) {
    if (!c.supervisorExpected) return [];
    return [
      {
        key: "supervisor_missing",
        rule: "supervisor_missing",
        severity: "critical",
        forSec: 60,
        summary: "no supervisor heartbeat in Redis: the stack (scripts/dev.ts) is down, restarting, or cannot reach Redis",
      },
    ];
  }
  const out: Condition[] = [];
  const sup = s.supervisor;
  const hbAge = (s.now - sup.ts) / 1000;
  if (hbAge > 90) {
    out.push({ key: "supervisor_missing", rule: "supervisor_missing", severity: "critical", forSec: 60, summary: `supervisor heartbeat is ${dur(hbAge)} old: the stack may be hung` });
  }
  for (const p of sup.procs) {
    const inWindow = (w: number) => p.recentExits.filter((t) => s.now - t <= w * 1000).length;
    const loops = inWindow(c.restartWindowSec);
    if (p.state === "exited" && !p.oneShot && p.lastExitCode !== 0) {
      out.push({
        key: `process_down:${p.name}`,
        rule: "process_down",
        severity: "critical",
        summary: `${p.name} exited with code ${p.lastExitCode ?? "?"} and is not restarted`,
      });
    } else if (loops >= c.restartMax && !p.oneShot) {
      out.push({
        key: `process_crashloop:${p.name}`,
        rule: "process_crashloop",
        severity: "critical",
        summary: `${p.name} restarted ${loops}× in the last ${dur(c.restartWindowSec)} (last exit code ${p.lastExitCode ?? "?"}, now ${p.state})`,
      });
    } else if (!p.oneShot && inWindow(c.exitWindowSec) > 0 && p.lastExitCode !== 0) {
      out.push({
        key: `process_exit:${p.name}`,
        rule: "process_exit",
        severity: "warning",
        summary: `${p.name} exited (code ${p.lastExitCode ?? "?"}) at ${new Date(p.lastExitAt ?? s.now).toISOString()}; supervisor restarted it (now ${p.state})`,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ gas
export function balances(s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  for (const b of s.balances) {
    if (b.wei === null) continue;
    const isFunder = b.role === "funder";
    const min = isFunder ? c.funderMinWei : (c.roleMinWei[b.role] ?? c.roleMinWei["*"] ?? 0n);
    if (min <= 0n || b.wei >= min) continue;
    out.push({
      key: `${isFunder ? "funder_low" : "role_balance_low"}:${b.role}`,
      rule: isFunder ? "funder_low" : "role_balance_low",
      // a dry key cannot sign: marks, hedges, kills stop; the funder only stops refills
      severity: b.wei < min / 4n ? "critical" : "warning",
      summary: `${isFunder ? "gas funder" : `role key ${b.role}`} ${b.address} has ${formatEther(b.wei)} ETH (min ${formatEther(min)})${isFunder ? ": refills stop when it runs dry" : ""}`,
    });
  }
  return out;
}

// ------------------------------------------------------------------ chain
export function rpc(s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  const samples = s.rpcSamples;
  if (samples.length >= c.rpcMinSamples) {
    const errors = samples.filter((x) => x.value === 0).length;
    const rate = errors / samples.length;
    if (rate >= c.rpcErrorRate) {
      out.push({
        key: "rpc_errors",
        rule: "rpc_errors",
        severity: rate >= 0.99 ? "critical" : "warning",
        summary: `RPC error rate ${(rate * 100).toFixed(0)}% (${errors}/${samples.length} probes)${s.rpc.error ? `; last: ${s.rpc.error}` : ""}`,
      });
    }
  }
  if (s.rpc.ok && s.rpc.headTs != null) {
    const lag = s.now / 1000 - s.rpc.headTs;
    if (lag > c.headLagSec) {
      out.push({
        key: "rpc_head_lag",
        rule: "rpc_head_lag",
        severity: "warning",
        forSec: 120,
        summary: `chain head #${s.rpc.head} is ${dur(lag)} old (limit ${dur(c.headLagSec)}): the RPC node is lagging or the sequencer is stalled`,
      });
    }
  }
  return out;
}

export function indexerLag(s: Snapshot, c: RuleConfig): Condition[] {
  if (!s.indexer?.length || s.rpc.head == null) return [];
  const slowest = s.indexer.reduce((a, b) => (b.block < a.block ? b : a));
  const behind = s.rpc.head - slowest.block;
  const stale = (s.now - slowest.updatedAt) / 1000;
  if (behind > c.indexerLagBlocks || (stale > c.indexerStaleSec && behind > 10)) {
    return [
      {
        key: "indexer_lag",
        rule: "indexer_lag",
        severity: "warning",
        forSec: 300,
        summary: `indexer ${slowest.name} at block ${slowest.block}, ${behind} behind head ${s.rpc.head}, cursor last moved ${dur(stale)} ago: API reads (marks, kills, distributions) are stale`,
      },
    ];
  }
  return [];
}

// ------------------------------------------------------------------ protocol keeper
/** Pure: is buybackPending above the floor and has it not gone down for `windowSec`? */
export function buybackStuck(samples: Sample[], now: number, minUsd: number, windowSec: number): { stuck: boolean; since: number | null } {
  const last = samples[samples.length - 1];
  if (!last || last.value < minUsd) return { stuck: false, since: null };
  // walk back while pending never decreased: the run start is the last buyback (or the first sample)
  let start = samples.length - 1;
  while (start > 0 && samples[start - 1]!.value <= samples[start]!.value) start--;
  const since = samples[start]!.ts;
  const grew = last.value > samples[start]!.value;
  return { stuck: grew && now - since >= windowSec * 1000, since };
}

export function buyback(s: Snapshot, c: RuleConfig): Condition[] {
  const last = s.buybackSamples[s.buybackSamples.length - 1];
  if (!last) return [];
  const out: Condition[] = [];
  const st = buybackStuck(s.buybackSamples, s.now, c.buybackMinUsd, c.buybackGrowSec);
  if (st.stuck) {
    out.push({
      key: "buyback_growing",
      rule: "buyback_growing",
      severity: "warning",
      summary: `buybackPending $${last.value.toFixed(2)} has only grown for ${dur((s.now - (st.since ?? s.now)) / 1000)}: the keeper's executeBuyback is not landing (waterfall logs: "buyback due but not sent")`,
    });
  }
  if (c.buybackMaxUsd > 0 && last.value >= c.buybackMaxUsd) {
    out.push({ key: "buyback_high", rule: "buyback_high", severity: "warning", summary: `buybackPending is $${last.value.toFixed(2)} (limit $${c.buybackMaxUsd})` });
  }
  return out;
}

// ------------------------------------------------------------------ backups (deploy/server/backup.sh)
export function backup(s: Snapshot, c: RuleConfig): Condition[] {
  if (!c.backupExpected || s.backup === undefined) return [];
  const b = s.backup;
  if (b === null) {
    return [{ key: "backup_missing", rule: "backup_missing", severity: "warning", summary: "no backup recorded: is bookrunner-backup.timer enabled? (sudo systemctl list-timers bookrunner-backup.timer)" }];
  }
  const out: Condition[] = [];
  const age = (s.now - b.ts) / 1000;
  if (!b.ok) {
    out.push({ key: "backup_failed", rule: "backup_failed", severity: "critical", summary: `last backup FAILED ${dur(age)} ago: ${b.error || "see journalctl -u bookrunner-backup"}` });
  } else if (age > c.backupMaxAgeSec) {
    out.push({ key: "backup_stale", rule: "backup_stale", severity: "warning", summary: `last successful backup is ${dur(age)} old (limit ${dur(c.backupMaxAgeSec)})` });
  }
  if (b.ok && b.offsite === "failed") {
    out.push({ key: "backup_offsite_failed", rule: "backup_offsite_failed", severity: "warning", summary: `last backup ran but its off-site copy failed (${b.dir})` });
  }
  return out;
}

// ------------------------------------------------------------------ API + infra
export function apiHealth(s: Snapshot, c: RuleConfig): Condition[] {
  const a = s.api;
  const bad = !a.ok || (a.db !== null && a.db !== "up") || (a.redis !== null && a.redis !== "ready");
  if (!bad) return [];
  const detail = !a.ok ? (a.error ?? `HTTP ${a.httpStatus ?? "?"}`) : `db ${a.db}, redis ${a.redis}`;
  return [{ key: "api_health", rule: "api_health", severity: "critical", forSec: c.apiForSec, summary: `API /health failing: ${detail}` }];
}

// ------------------------------------------------------------------ oracle sources
const lastOkText = (src: OracleSourceSnap) => (src.lastOkAt == null ? "never ok since start" : `last ok ${new Date(src.lastOkAt).toISOString()}`);
/** a price for a message: 6 significant digits, no trailing zeros */
const px = (p: number | null) => (p === null ? "?" : String(Number(p.toPrecision(6))));
const bps = (b: number | null) => (b === null ? "?" : `${Math.round(b)} bps`);

/**
 * Oracle health (GET /health), by the oracle's `policy` (absent = median):
 *
 * median (devnet / testnet; N live sources, M required, median within the band): oracle_source_failing when a live
 * source has failed in-session tickers for longer than oracleSourceFailSec: a warning while the remaining sources
 * carry the price, critical when two or more fail on the same ticker (no
 * price for it; after maxPriceAge valuations and liquidations revert). oracle_price_missing: an in-session ticker
 * without a publishable price for oraclePriceMissingSec that two failing sources do not explain.
 *
 * primary-confirm (mainnet): Chainlink (role "primary") alone sets and signs each price; confirm sources (DEX TWAP,
 * Pyth) are only compared against it and never substitute.
 * - oracle_source_failing:<primary> CRITICAL after oracleSourceFailSec: no price for its tickers; the last signed
 *   price ages until StalePrice after maxPriceAge.
 * - oracle_source_failing:<confirm> WARNING after max(oracleSourceFailSec, oracleConfirmUnavailableSec), only for
 *   its failing tickers whose confirm status is neither "unavailable" (oracle_confirm_unavailable's) nor "no-primary"
 *   (the primary alert's); prices
 *   continue from Chainlink. No "two sources failing on one ticker" escalation.
 * - oracle_price_missing as above, but explained (suppressed) only by an alerting primary failure on that ticker.
 * - oracle_confirm_divergence:<priceId>: "diverged" for oracleConfirmDivergenceSec; critical above 2x confirmBps or
 *   when oracleConfirmCriticalTickers tickers are diverged that long at once. The price stays Chainlink.
 * - oracle_confirm_unavailable:<priceId>: "unavailable" (no fresh confirm source) for oracleConfirmUnavailableSec:
 *   Chainlink is published unconfirmed. "closed" (off-hours) and "no-primary" (Chainlink itself has no fresh
 *   observation: the primary alert / oracle_price_missing cover it) entries never raise a confirm alert.
 *
 * Both: oracle_health (/health unreachable) and oracle_min_sources (on-chain minSources the sources cannot reach).
 */
export function oracle(s: Snapshot, c: RuleConfig): Condition[] {
  const o = s.oracle;
  if (!c.oracleExpected || !o) return [];
  if (!o.ok) {
    return [{ key: "oracle_health", rule: "oracle_health", severity: "warning", forSec: 120, summary: `oracle /health unreachable: ${o.error ?? "?"}` }];
  }
  const out = o.policy === "primary-confirm" ? oraclePrimaryConfirm(o, s, c) : oracleMedian(o, s, c);
  if (o.minSourcesProblem) {
    out.push({ key: "oracle_min_sources", rule: "oracle_min_sources", severity: "critical", summary: `oracle: ${o.minSourcesProblem}` });
  }
  return out;
}

/**
 * Observed span (s) of a run that the oracle keeps for its hysteresis after recovery: from its start to its latest
 * failing tick (`last`; absent = now). A one-tick blip stays ~0 however long it lingers; a flapping or sustained failure
 * keeps growing.
 */
export const observedSpanSec = (since: number, last: number | null | undefined, now: number): number => ((last ?? now) - since) / 1000;
const failSpan = (src: OracleSourceSnap, now: number): number => (src.failingSince == null ? 0 : observedSpanSec(src.failingSince, src.lastErrorAt, now));

/** in-session tickers without a publishable price for oraclePriceMissingSec, minus those `explained` by source alerts */
function priceMissing(o: OracleProbe, s: Snapshot, c: RuleConfig, explained: Set<string>): Condition[] {
  const out: Condition[] = [];
  for (const u of o.unpublished) {
    const age = observedSpanSec(u.since, u.lastSeenAt, s.now);
    if (age < c.oraclePriceMissingSec || explained.has(u.priceId)) continue;
    out.push({
      key: `oracle_price_missing:${u.priceId}`,
      rule: "oracle_price_missing",
      severity: "critical",
      summary: `oracle: no publishable price for ${u.priceId} for ${dur(age)} in session (${u.reason}); after maxPriceAge valuations and liquidations revert`,
    });
  }
  return out;
}

function oracleMedian(o: OracleProbe, s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  const failing = o.sources.filter((src) => src.failingSince != null && failSpan(src, s.now) >= c.oracleSourceFailSec);
  // tickers failed by 2+ sources at once: below 2 sources nothing is published for them
  const failedBy = new Map<string, number>();
  for (const src of failing) for (const t of src.failingTickers) failedBy.set(t, (failedBy.get(t) ?? 0) + 1);
  const dark = new Set([...failedBy].filter(([, n]) => n >= 2).map(([t]) => t));
  for (const src of failing) {
    const age = failSpan(src, s.now);
    const shared = src.failingTickers.filter((t) => dark.has(t));
    out.push({
      key: `oracle_source_failing:${src.name}`,
      rule: "oracle_source_failing",
      severity: shared.length > 0 ? "critical" : "warning",
      summary: `oracle source ${src.name} (${src.kind}) failing for ${dur(age)} on ${src.failingTickers.join(", ") || "?"} (${src.lastError ?? "?"}; ${lastOkText(src)}): ${
        shared.length > 0
          ? `another source fails on ${shared.join(", ")} too: below 2 sources no price is published; after maxPriceAge valuations and liquidations revert`
          : "prices continue from the remaining sources while they agree, with no spare left"
      }`,
    });
  }
  // a ticker with no publishable price in session that the source alerts do not already explain (e.g. three fresh
  // sources spread beyond the band, or one down and the other two disagreeing)
  out.push(...priceMissing(o, s, c, dark));
  return out;
}

function oraclePrimaryConfirm(o: OracleProbe, s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  const statusOf = new Map(o.confirm.map((x) => [x.priceId, x.status]));
  const primaryDark = new Set<string>();
  const confirmFailSec = Math.max(c.oracleSourceFailSec, c.oracleConfirmUnavailableSec);
  for (const src of o.sources) {
    if (src.failingSince == null) continue;
    const age = failSpan(src, s.now);
    if (src.role === "primary") {
      if (age < c.oracleSourceFailSec) continue;
      for (const t of src.failingTickers) primaryDark.add(t);
      const tickers = src.failingTickers.join(", ") || "?";
      out.push({
        key: `oracle_source_failing:${src.name}`,
        rule: "oracle_source_failing",
        severity: "critical",
        summary: `oracle primary source ${src.name} (${src.kind}) failing for ${dur(age)} on ${tickers} (${src.lastError ?? "?"}; ${lastOkText(src)}): no price is published for ${tickers} (Chainlink is the only signing source; the DEX never substitutes); the last signed price ages until StalePrice after maxPriceAge, then valuations and liquidations revert`,
      });
    } else {
      // a confirm source: its tickers left without any confirmer are oracle_confirm_unavailable's, and tickers without
      // a Chainlink price (no-primary) are the primary alert's
      if (age < confirmFailSec) continue;
      const tickers = src.failingTickers.filter((t) => statusOf.get(t) !== "unavailable" && statusOf.get(t) !== "no-primary");
      if (tickers.length === 0) continue;
      out.push({
        key: `oracle_source_failing:${src.name}`,
        rule: "oracle_source_failing",
        severity: "warning",
        summary: `oracle confirm source ${src.name} (${src.kind}) failing for ${dur(age)} on ${tickers.join(", ")} (${src.lastError ?? "?"}; ${lastOkText(src)}): confirm source only: prices continue from Chainlink`,
      });
    }
  }
  out.push(...priceMissing(o, s, c, primaryDark));

  // divergence: the confirm sources disagree with the published (Chainlink) price; no `since` = run length unknown
  const runAge = (x: OracleConfirmSnap) => (x.since == null ? null : (s.now - x.since) / 1000);
  const diverged = o.confirm.filter((x) => x.status === "diverged" && (runAge(x) ?? -1) >= c.oracleConfirmDivergenceSec);
  const band = o.confirmBps ?? 200;
  const many = diverged.length >= c.oracleConfirmCriticalTickers;
  for (const x of diverged) {
    const wide = x.diffBps !== null && x.diffBps > 2 * band;
    const vs = x.confirmers.length ? x.confirmers.map((k) => `${k.name} ${px(k.price)} (${bps(k.diffBps)})`).join(", ") : "?";
    const why = [wide ? `above 2x the ${band} bps limit` : null, many ? `${diverged.length} tickers diverged at once` : null].filter(Boolean).join("; ");
    out.push({
      key: `oracle_confirm_divergence:${x.priceId}`,
      rule: "oracle_confirm_divergence",
      severity: wide || many ? "critical" : "warning",
      summary: `oracle: ${x.priceId} Chainlink ${px(x.primaryPrice)} vs ${vs}: ${bps(x.diffBps)} apart (limit ${band} bps) for ${dur(runAge(x) ?? 0)} in session${why ? ` (${why})` : ""}; the published price is still Chainlink (the DEX never moves it). Check Chainlink lag (0.5% deviation / 24 h heartbeat update rule), the USDG peg, DEX pool manipulation; docs/RUNBOOK.md "Real prices"`,
    });
  }

  // a sustained gap above the lag threshold with no new Chainlink round for oraclePrimaryLagSec: Chainlink rounds on a 50 bps
  // deviation, so a feed that silently stopped posting looks like this long before heartbeat + grace (~24 h) marks it
  // stale; until then the oracle keeps signing the frozen round as fresh
  const lagBps = o.primaryLagBps ?? 100;
  // the stall clock restarts at every new Chainlink round: a round that lands mid-gap proves the feed alive then,
  // but if the gap persists after it and no further round comes, the alert fires again oraclePrimaryLagSec later
  for (const x of o.confirm) {
    if (x.status === "closed" || x.lagSince == null || x.primaryTs == null) continue;
    const lagAge = (s.now - Math.max(x.lagSince, x.primaryTs)) / 1000;
    if (lagAge < c.oraclePrimaryLagSec) continue;
    const vs = x.confirmers.length ? x.confirmers.map((k) => `${k.name} ${px(k.price)} (${bps(k.diffBps)})`).join(", ") : "?";
    out.push({
      key: `oracle_primary_suspect_stale:${x.priceId}`,
      rule: "oracle_primary_suspect_stale",
      severity: "warning",
      summary: `oracle: ${x.priceId} Chainlink ${px(x.primaryPrice)} (round ${dur((s.now - x.primaryTs) / 1000)} old) vs ${vs}: gap above ${lagBps} bps for ${dur(lagAge)} in session with no new Chainlink round (its deviation rule is 50 bps): the feed may have stopped updating and is still signed as fresh until heartbeat + grace (~24 h). Check the round on-chain and Chainlink status; consider reduce-only on RHX5 (docs/RUNBOOK.md "Real prices")`,
    });
  }

  // no fresh confirm source on an in-session ticker: Chainlink is published unconfirmed
  const confirmFailing = o.sources.filter((src) => src.role !== "primary" && src.failingSince != null);
  for (const x of o.confirm) {
    const age = runAge(x);
    if (x.status !== "unavailable" || age === null || age < c.oracleConfirmUnavailableSec) continue;
    const onIt = confirmFailing.filter((src) => src.failingTickers.includes(x.priceId));
    const why = (onIt.length ? onIt : confirmFailing).map((src) => `${src.name}: ${src.lastError ?? "?"}`);
    out.push({
      key: `oracle_confirm_unavailable:${x.priceId}`,
      rule: "oracle_confirm_unavailable",
      severity: "warning",
      summary: `oracle: no confirm source for ${x.priceId} for ${dur(age)} in session: Chainlink is published unconfirmed${why.length ? ` (failing confirm sources: ${why.join("; ")})` : ""}`,
    });
  }
  return out;
}

export function infra(s: Snapshot, _c: RuleConfig): Condition[] {
  return s.infraErrors.map((e) => ({
    key: `infra_${e.source}`,
    rule: `infra_${e.source}`,
    severity: "critical" as const,
    forSec: 60,
    summary: `alerts service cannot read ${e.source === "db" ? "Postgres" : "Redis"}: ${e.error}`,
  }));
}

export const RULES = {
  mark_overdue: markOverdue,
  risk_state: riskState,
  engine_loss_budget: engineLossBudget,
  engine_loss_budget_unreadable: engineLossBudgetUnreadable,
  kill_journal: killJournal,
  kill_event: killEvents,
  risk_stale: riskStale,
  venue_report_stale: venueReportAge,
  venue_symbol_unmapped: venueSymbol,
  venue_listing: venueListing,
  venue_if_account: venueIfAccount,
  builder_price_push: builderPricePush,
  ...HOLD_RULES,
  processes,
  balances,
  rpc,
  indexer_lag: indexerLag,
  buyback,
  api_health: apiHealth,
  oracle,
  backup,
  infra,
} as const;

/** Every active condition of the snapshot; a rule (or a condition's rule name) in `disabled` is skipped. */
export function evaluate(s: Snapshot, c: RuleConfig): Condition[] {
  const out: Condition[] = [];
  for (const [name, rule] of Object.entries(RULES)) {
    if (c.disabled.has(name)) continue;
    for (const cond of rule(s, c)) if (!c.disabled.has(cond.rule)) out.push(cond);
  }
  return out;
}
