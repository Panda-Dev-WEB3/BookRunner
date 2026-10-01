// Trading-session codec for Charter.sessions (bytes32). Consumed off-chain (oracle hold flags, agent,
// risk); on-chain logic only sees the oracle's `held` flag.
//
// Layout (bit 0 = least significant):
//   [0..7]     kind: 0 = always open (24x7), 1 = weekly schedule
//   [8..15]    timezone id: 0 = UTC, 1 = America/New_York (DST-aware via Intl)
//   [16..169]  7 x (open:11 bits, close:11 bits), Monday..Sunday, minutes of local day (0..1439)
//              open == close -> closed all day; close < open -> session wraps past local midnight
//              open = 0 & close = 1439 means open the whole day (the 1439th minute included)
//   [170..177] holiday calendar id: 0 = none, 1 = NYSE (dates in HOLIDAYS below)
//   rest       reserved (zero)
import { type Hex, numberToHex } from "viem";

export const TIMEZONES = ["UTC", "America/New_York"] as const;
export type TimezoneId = 0 | 1;

export interface DaySession {
  open: number; // minutes of local day
  close: number;
}

export interface Sessions {
  kind: 0 | 1;
  tz: TimezoneId;
  days: DaySession[]; // length 7, Monday..Sunday
  holidays: 0 | 1;
}

const FULL_DAY: DaySession = { open: 0, close: 1439 };
const CLOSED: DaySession = { open: 0, close: 0 };

export const SESSIONS_24X7: Sessions = { kind: 0, tz: 0, days: Array(7).fill(FULL_DAY), holidays: 0 };

/** US equities regular hours 09:30-16:00 ET, Mon-Fri, NYSE holidays. */
export const SESSIONS_NYSE_RTH: Sessions = {
  kind: 1,
  tz: 1,
  days: [
    { open: 570, close: 960 },
    { open: 570, close: 960 },
    { open: 570, close: 960 },
    { open: 570, close: 960 },
    { open: 570, close: 960 },
    CLOSED,
    CLOSED,
  ],
  holidays: 1,
};

/** 24/5 (Stock Token / equity feed style): Sun 20:00 ET -> Fri 20:00 ET, holds over the weekend. */
export const SESSIONS_24X5: Sessions = {
  kind: 1,
  tz: 1,
  days: [FULL_DAY, FULL_DAY, FULL_DAY, FULL_DAY, { open: 0, close: 1200 }, CLOSED, { open: 1200, close: 1439 }],
  holidays: 1,
};

// NYSE full-day closures 2026-2027 (VERIFY yearly).
export const NYSE_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03",
  "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05",
  "2027-09-06", "2027-11-25", "2027-12-24",
]);

export function encodeSessions(s: Sessions): Hex {
  let v = BigInt(s.kind) | (BigInt(s.tz) << 8n);
  if (s.days.length !== 7) throw new Error("sessions: need 7 days");
  s.days.forEach((d, i) => {
    if (d.open < 0 || d.open > 1439 || d.close < 0 || d.close > 1439) throw new Error("sessions: minute out of range");
    const off = 16n + BigInt(i) * 22n;
    v |= BigInt(d.open) << off;
    v |= BigInt(d.close) << (off + 11n);
  });
  v |= BigInt(s.holidays) << 170n;
  return numberToHex(v, { size: 32 });
}

export function decodeSessions(h: Hex): Sessions {
  const v = BigInt(h);
  const kind = Number(v & 0xffn) as 0 | 1;
  const tz = Number((v >> 8n) & 0xffn) as TimezoneId;
  const days: DaySession[] = [];
  for (let i = 0; i < 7; i++) {
    const off = 16n + BigInt(i) * 22n;
    days.push({ open: Number((v >> off) & 0x7ffn), close: Number((v >> (off + 11n)) & 0x7ffn) });
  }
  const holidays = Number((v >> 170n) & 0xffn) as 0 | 1;
  return { kind, tz, days, holidays };
}

function localParts(date: Date, tz: TimezoneId) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONES[tz],
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday ?? "");
  return {
    weekday: wd, // 0 = Monday
    minute: Number(parts.hour) * 60 + Number(parts.minute),
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function inDay(d: DaySession, minute: number): boolean {
  if (d.open === d.close) return false;
  if (d.open === 0 && d.close === 1439) return true;
  if (d.close > d.open) return minute >= d.open && minute < d.close;
  return minute >= d.open || minute < d.close; // wraps
}

/** True if the market is in session at `date`. */
export function isOpen(s: Sessions, date: Date = new Date()): boolean {
  if (s.kind === 0) return true;
  const p = localParts(date, s.tz);
  if (s.holidays === 1 && NYSE_HOLIDAYS.has(p.ymd)) return false;
  const today = s.days[p.weekday];
  if (today && inDay(today, p.minute)) {
    // a wrapping session only counts its pre-midnight part for "today"
    if (!(today.close < today.open && p.minute < today.close)) return true;
  }
  // wrap-over from the previous day's session
  const prev = s.days[(p.weekday + 6) % 7];
  return !!prev && prev.close < prev.open && p.minute < prev.close;
}

/** SESSIONS_MODE=24x7 overrides charter sessions for demos outside market hours. */
export function effectiveSessions(encoded: Hex, mode: string | undefined): Sessions {
  return mode === "24x7" ? SESSIONS_24X7 : decodeSessions(encoded);
}
