// Dedupe + rate-limit state machine (pure). Per condition key:
//
//   (absent) --active--> pending --active for forSec--> FIRING (notify "firing")
//   pending  --inactive--> (absent)                     (never notified: a blip)
//   FIRING   --active, severity up--> FIRING (notify "escalated")
//   FIRING   --inactive--> clearing --inactive for clearSec--> (absent) (notify "resolved", unless a one-off event)
//   clearing --active--> FIRING                          (no new notification: flapping is absorbed)
//
// Notifications go to an outbox; flush() releases the whole outbox as ONE message when the rate limit
// allows (min interval between messages, max messages per hour), so a burst of conditions is one email.
import type { Condition, Severity } from "./types";

export interface Tracked {
  key: string;
  rule: string;
  severity: Severity;
  summary: string;
  notifyResolve: boolean;
  /** unix ms the condition was first seen active (this episode) */
  since: number;
  /** unix ms it was notified as firing; null while pending */
  firedAt: number | null;
  /** unix ms it was first seen inactive while firing; null while active */
  clearingSince: number | null;
}

export type NoticeKind = "firing" | "escalated" | "resolved";

export interface Notice {
  kind: NoticeKind;
  key: string;
  rule: string;
  severity: Severity;
  summary: string;
  /** unix ms of the transition */
  at: number;
  /** firing duration for "resolved" (ms) */
  firedForMs?: number;
}

export interface AlertState {
  v: 1;
  tracked: Record<string, Tracked>;
  outbox: Notice[];
  /** unix ms of the messages sent within the last hour */
  sent: number[];
  /** UTC day (YYYY-MM-DD) of the last digest */
  lastDigestDay: string | null;
  /** notices of the last 24 h (for the digest) */
  history: Notice[];
}

export const emptyState = (): AlertState => ({ v: 1, tracked: {}, outbox: [], sent: [], lastDigestDay: null, history: [] });

const RANK: Record<Severity, number> = { warning: 1, critical: 2 };
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Outbox cap: beyond it the oldest notices are dropped (a summary line says how many). */
export const OUTBOX_MAX = 200;

export interface StepOptions {
  clearSec: number;
}

/** Advances the state with this pass's active conditions; new notices are appended to the outbox. */
export function step(prev: AlertState, active: Condition[], now: number, opts: StepOptions): { state: AlertState; notices: Notice[] } {
  const tracked: Record<string, Tracked> = {};
  const notices: Notice[] = [];
  const seen = new Set<string>();

  for (const c of active) {
    if (seen.has(c.key)) continue; // first wins on a duplicate key
    seen.add(c.key);
    const old = prev.tracked[c.key];
    const forMs = (c.forSec ?? 0) * 1000;
    const notifyResolve = c.notifyResolve !== false;
    if (!old) {
      const t: Tracked = { key: c.key, rule: c.rule, severity: c.severity, summary: c.summary, notifyResolve, since: now, firedAt: null, clearingSince: null };
      if (forMs <= 0) {
        t.firedAt = now;
        notices.push({ kind: "firing", key: c.key, rule: c.rule, severity: c.severity, summary: c.summary, at: now });
      }
      tracked[c.key] = t;
      continue;
    }
    const t: Tracked = { ...old, rule: c.rule, summary: c.summary, notifyResolve, clearingSince: null };
    if (old.firedAt === null) {
      t.severity = c.severity;
      if (now - old.since >= forMs) {
        t.firedAt = now;
        notices.push({ kind: "firing", key: c.key, rule: c.rule, severity: c.severity, summary: c.summary, at: now });
      }
    } else if (RANK[c.severity] > RANK[old.severity]) {
      t.severity = c.severity;
      notices.push({ kind: "escalated", key: c.key, rule: c.rule, severity: c.severity, summary: c.summary, at: now });
    } else {
      // de-escalation is silent; the resolved message reports the end of the episode
      t.severity = c.severity;
    }
    tracked[c.key] = t;
  }

  for (const [key, old] of Object.entries(prev.tracked)) {
    if (seen.has(key)) continue;
    if (old.firedAt === null) continue; // pending blip: dropped silently
    const clearingSince = old.clearingSince ?? now;
    if (now - clearingSince >= opts.clearSec * 1000) {
      if (old.notifyResolve) notices.push({ kind: "resolved", key, rule: old.rule, severity: old.severity, summary: old.summary, at: now, firedForMs: now - old.firedAt });
      continue; // forgotten
    }
    tracked[key] = { ...old, clearingSince };
  }

  const outbox = [...prev.outbox, ...notices];
  return {
    state: {
      ...prev,
      tracked,
      outbox: outbox.length > OUTBOX_MAX ? outbox.slice(outbox.length - OUTBOX_MAX) : outbox,
      history: [...prev.history.filter((n) => now - n.at < DAY_MS), ...notices],
    },
    notices,
  };
}

export interface RateLimit {
  minIntervalSec: number;
  maxPerHour: number;
}

/** True when a message may be sent now (outbox not empty, min interval elapsed, hourly budget left). */
export function canSend(state: AlertState, now: number, rl: RateLimit): boolean {
  if (state.outbox.length === 0) return false;
  const recent = state.sent.filter((t) => now - t < HOUR_MS);
  if (rl.maxPerHour > 0 && recent.length >= rl.maxPerHour) return false;
  const last = recent.length ? Math.max(...recent) : null;
  return last === null || now - last >= rl.minIntervalSec * 1000;
}

/**
 * Takes the outbox for one message. A firing + resolved pair of the same key inside one batch is kept
 * (both lines): the reader sees it flapped. Call markSent() after a successful delivery.
 */
export function takeOutbox(state: AlertState): { batch: Notice[]; state: AlertState } {
  return { batch: state.outbox, state: { ...state, outbox: [] } };
}

export function markSent(state: AlertState, now: number): AlertState {
  return { ...state, sent: [...state.sent.filter((t) => now - t < HOUR_MS), now] };
}

/** Puts an undelivered batch back at the head of the outbox (delivery failed on every channel). */
export function requeue(state: AlertState, batch: Notice[]): AlertState {
  const outbox = [...batch, ...state.outbox];
  return { ...state, outbox: outbox.length > OUTBOX_MAX ? outbox.slice(outbox.length - OUTBOX_MAX) : outbox };
}

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Daily digest due: the configured UTC hour has been reached today and no digest went out today. */
export function digestDue(state: AlertState, now: number, hourUtc: number | null): boolean {
  if (hourUtc === null) return false;
  return new Date(now).getUTCHours() >= hourUtc && state.lastDigestDay !== utcDay(now);
}

export function markDigest(state: AlertState, now: number): AlertState {
  return { ...state, lastDigestDay: utcDay(now) };
}

/** Firing conditions (notified, not yet resolved), most severe first. */
export function firing(state: AlertState): Tracked[] {
  return Object.values(state.tracked)
    .filter((t) => t.firedAt !== null)
    .sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.since - b.since);
}

/** Tolerant restore of a persisted state (unknown / corrupt -> empty). */
export function parseState(raw: string | null | undefined): AlertState {
  if (!raw) return emptyState();
  try {
    const o = JSON.parse(raw) as Partial<AlertState>;
    if (o?.v !== 1 || typeof o.tracked !== "object" || o.tracked === null) return emptyState();
    return {
      v: 1,
      tracked: o.tracked as Record<string, Tracked>,
      outbox: Array.isArray(o.outbox) ? o.outbox : [],
      sent: Array.isArray(o.sent) ? o.sent.filter((t): t is number => typeof t === "number") : [],
      lastDigestDay: typeof o.lastDigestDay === "string" ? o.lastDigestDay : null,
      history: Array.isArray(o.history) ? o.history : [],
    };
  } catch {
    return emptyState();
  }
}
