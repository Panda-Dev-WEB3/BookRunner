// Alert rules: pure functions Snapshot -> active Conditions. Each returns the conditions that hold NOW;
// the dedupe state machine (dedupe.ts) turns "holds now" into one notification when it starts and one
// "resolved" when it stops. Keys are stable per (rule, subject) so the same problem never alerts twice.
import { formatEther } from "viem";
import type { RuleConfig } from "./config";
import type { BookSnap, Condition, Sample, Snapshot } from "./types";

/** States in which a book is marked every period (Book.sol: Live and Retiring). */
const MARKABLE = new Set(["Live", "Retiring"]);

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
  kill_journal: killJournal,
  kill_event: killEvents,
  risk_stale: riskStale,
  venue_report_stale: venueReportAge,
  processes,
  balances,
  rpc,
  indexer_lag: indexerLag,
  buyback,
  api_health: apiHealth,
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
