// Pyth Pro published market-session schedules (`/v1/symbols` -> `market_session_schedule`) vs the charter
// calendar (packages/shared/src/sessions.ts). Used by source-check: a minute the calendar treats as open while Pyth
// is closed runs mainnet without its spare source (and signals out-of-date holiday tables), so the calendar must be
// closed wherever Pyth is (holiday eves, early closes: sessions.ts nyseCalendarClosed) and hold there.
//
// Schedule string (https://docs.pyth.network/price-feeds/pro/symbology-reference): `TZ;<weekly>;<overrides>`,
// weekly = 7 entries Monday..Sunday, each `O` (open), `C` (closed) or `HHMM-HHMM` ranges joined by `&` (`2400` =
// end of day); overrides = comma-separated `MMDD/<entry>` replacing the weekly entry on that local date. The dates
// carry no year: within a horizon shorter than a year each MMDD matches at most one date.
import { type Sessions, isOpen } from "@bookrunner/shared";

export const PYTH_SYMBOLS_URL = "https://pyth.dourolabs.app/v1/symbols";

interface Range {
  from: number; // minute of local day, inclusive
  to: number; // exclusive (1440 = end of day)
}

export interface PythSchedule {
  tz: string;
  weekly: Range[][]; // Monday..Sunday
  overrides: Map<string, Range[]>; // "MMDD"
}

function parseEntry(e: string): Range[] {
  const t = e.trim();
  if (t === "O") return [{ from: 0, to: 1440 }];
  if (t === "C" || t === "") return [];
  return t.split("&").map((r) => {
    const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(r.trim());
    if (!m) throw new Error(`pyth schedule: bad range "${r}"`);
    const from = Number(m[1]) * 60 + Number(m[2]);
    const to = Number(m[3]) * 60 + Number(m[4]);
    if (from > 1440 || to > 1440 || to <= from) throw new Error(`pyth schedule: bad range "${r}"`);
    return { from, to };
  });
}

export function parsePythSchedule(s: string): PythSchedule {
  const [tz, weekly, overrides = ""] = s.split(";");
  const days = (weekly ?? "").split(",");
  if (!tz || days.length !== 7) throw new Error(`pyth schedule: expected "TZ;<7 weekly entries>;<overrides>"`);
  const map = new Map<string, Range[]>();
  for (const o of overrides.split(",").filter((x) => x.trim() !== "")) {
    const [date, entry] = o.trim().split("/");
    if (!date || !/^\d{4}$/.test(date) || entry === undefined) throw new Error(`pyth schedule: bad override "${o}"`);
    map.set(date, parseEntry(entry));
  }
  return { tz, weekly: days.map(parseEntry), overrides: map };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function local(tz: string, at: Date): { weekday: number; mmdd: string; minute: number } {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday ?? ""),
    mmdd: `${p.month}${p.day}`,
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}

/** Open in any of the given sessions (regular, pre, post, overnight) at `at`. */
export function pythOpen(schedules: readonly PythSchedule[], at: Date): boolean {
  const byTz = new Map<string, ReturnType<typeof local>>();
  return schedules.some((s) => {
    let l = byTz.get(s.tz);
    if (!l) byTz.set(s.tz, (l = local(s.tz, at)));
    const ranges = s.overrides.get(l.mmdd) ?? s.weekly[l.weekday] ?? [];
    return ranges.some((r) => l.minute >= r.from && l.minute < r.to);
  });
}

export interface CalendarWindow {
  from: number; // unix ms, first sampled minute
  to: number; // unix ms, end (exclusive) of the last sampled step
}

export interface CalendarDiff {
  /** calendar open, Pyth closed: no price at all on mainnet (must be empty) */
  oursOpenPythClosed: CalendarWindow[];
  /** calendar closed, Pyth open: held prices while Pyth quotes (acceptable, conservative) */
  pythOpenOursClosed: CalendarWindow[];
}

/** Samples both calendars every `stepMin` minutes over `days` days from `fromMs` and returns the windows that differ. */
export function compareCalendars(p: { ours: Sessions; pyth: readonly PythSchedule[]; fromMs: number; days: number; stepMin?: number }): CalendarDiff {
  const step = (p.stepMin ?? 5) * 60_000;
  const start = Math.floor(p.fromMs / step) * step;
  const end = start + p.days * 86_400_000;
  const out: CalendarDiff = { oursOpenPythClosed: [], pythOpenOursClosed: [] };
  const push = (list: CalendarWindow[], t: number) => {
    const last = list[list.length - 1];
    if (last && last.to === t) last.to = t + step;
    else list.push({ from: t, to: t + step });
  };
  for (let t = start; t < end; t += step) {
    const at = new Date(t);
    const ours = isOpen(p.ours, at);
    const pyth = pythOpen(p.pyth, at);
    if (ours && !pyth) push(out.oursOpenPythClosed, t);
    else if (!ours && pyth) push(out.pythOpenOursClosed, t);
  }
  return out;
}

/** Market-session schedules per Pyth feed id from a `/v1/symbols` response (all sessions of `market_session_schedule`). */
export function schedulesById(symbols: unknown, ids: readonly number[]): Map<number, PythSchedule[]> {
  const out = new Map<number, PythSchedule[]>();
  if (!Array.isArray(symbols)) throw new Error("pyth symbols: expected a JSON array");
  for (const s of symbols as Array<{ pyth_lazer_id?: unknown; market_session_schedule?: unknown; schedule?: unknown }>) {
    if (typeof s?.pyth_lazer_id !== "number" || !ids.includes(s.pyth_lazer_id)) continue;
    const mss = s.market_session_schedule;
    const raw = mss && typeof mss === "object" ? Object.values(mss as Record<string, unknown>) : [s.schedule];
    out.set(s.pyth_lazer_id, raw.filter((x): x is string => typeof x === "string").map(parsePythSchedule));
  }
  return out;
}
