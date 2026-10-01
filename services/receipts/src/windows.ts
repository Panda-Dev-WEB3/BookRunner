// Pure window math for receipts roots. All times are unix seconds (integers).
//   - A receipts window is [start, start + interval) with start aligned to the interval.
//   - A mark period with periodEnd T covers [T - markInterval, T); its receiptsRoot is built over the
//     hourly (window) roots whose start lies in that range.

export function windowStartOf(tsSec: number, intervalSec: number): number {
  assertInterval(intervalSec);
  return Math.floor(tsSec / intervalSec) * intervalSec;
}

/** A window is closed once its end plus the grace period has passed (late inserts settle first). */
export function isWindowClosed(start: number, intervalSec: number, nowSec: number, graceSec = 0): boolean {
  return start + intervalSec + graceSec <= nowSec;
}

/**
 * Aligned window starts s with fromStart <= s and s closed at `nowSec`, oldest first, at most `max`.
 * `fromStart` is aligned up to the interval.
 */
export function closedWindowStarts(fromStart: number, nowSec: number, intervalSec: number, graceSec = 0, max = Number.MAX_SAFE_INTEGER): number[] {
  assertInterval(intervalSec);
  const out: number[] = [];
  let s = Math.ceil(fromStart / intervalSec) * intervalSec;
  while (out.length < max && isWindowClosed(s, intervalSec, nowSec, graceSec)) {
    out.push(s);
    s += intervalSec;
  }
  return out;
}

/** Aligned window starts s with periodStart <= s < periodEnd. */
export function windowsInPeriod(periodStart: number, periodEnd: number, intervalSec: number): number[] {
  assertInterval(intervalSec);
  if (periodEnd <= periodStart) return [];
  const out: number[] = [];
  for (let s = Math.ceil(periodStart / intervalSec) * intervalSec; s < periodEnd; s += intervalSec) out.push(s);
  return out;
}

/** Mark period that contains a window: [periodStart, periodEnd) with periodEnd a multiple of markInterval. */
export function periodOfWindow(windowStart: number, markIntervalSec: number): { periodStart: number; periodEnd: number } {
  assertInterval(markIntervalSec);
  const periodStart = Math.floor(windowStart / markIntervalSec) * markIntervalSec;
  return { periodStart, periodEnd: periodStart + markIntervalSec };
}

/** Receipt leaf timestamp: unix seconds, floored. */
export function leafTs(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function assertInterval(i: number) {
  if (!Number.isInteger(i) || i <= 0) throw new Error(`invalid interval: ${i}`);
}
