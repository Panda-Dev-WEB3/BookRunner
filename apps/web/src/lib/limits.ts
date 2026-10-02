// Limit-state vocabulary and gauge geometry (inventory, skew, drawdown, hedge band).
import { HEDGE_RATIO_MIN_EXPOSURE_BPS, SOFT_INVENTORY_UTIL } from "@bookrunner/shared/mandate";

export type Tone = "neutral" | "accent" | "good" | "warn" | "serious" | "critical";

export interface StateMeta {
  label: string;
  tone: Tone;
  hint: string;
}

export const LIMIT_STATES: Record<string, StateMeta> = {
  ok: { label: "Within limits", tone: "good", hint: "All mandate limits inside bounds" },
  warn: { label: "Warn", tone: "warn", hint: "Inventory above 90% of the mandate or hedge ratio outside its band (within grace)" },
  reduce_only: { label: "Reduce-only", tone: "serious", hint: "Off-hours: agents may only reduce exposure" },
  breach: { label: "Breach", tone: "critical", hint: "A mandate limit is breached: cancel-all, flatten within mandate, revoke keys" },
  killed: { label: "Killed", tone: "critical", hint: "Mandate killed: quoting stopped, keys revoked; the committee may re-mandate" },
  unknown: { label: "No data", tone: "neutral", hint: "No risk snapshot for this book yet" },
};

export const limitState = (s: string | null | undefined): StateMeta => LIMIT_STATES[s ?? "unknown"] ?? { label: s ?? "No data", tone: "neutral", hint: "" };

export const BOOK_STATES: Record<string, StateMeta> = {
  Subscription: { label: "Subscription", tone: "accent", hint: "Subscription window open: commitments allocate pro-rata at close" },
  Live: { label: "Live", tone: "good", hint: "Window closed, IF and MM inventory deployed; agents quote the book under its mandate" },
  Cancelled: { label: "Cancelled", tone: "neutral", hint: "Window failed its checks; every commitment is refundable 1:1" },
  Retiring: { label: "Retiring", tone: "serious", hint: "Winding down: quoting stopped, capital being recalled" },
  Retired: { label: "Retired", tone: "neutral", hint: "Final mark applied; redemptions settle at the final price" },
};

export const bookState = (s: string | null | undefined): StateMeta => BOOK_STATES[s ?? ""] ?? { label: s ?? "Unknown", tone: "neutral", hint: "" };

export const CHARTER_STATES: Record<string, StateMeta> = {
  Filed: { label: "Filed", tone: "accent", hint: "Awaiting jury verdict and committee votes" },
  Approved: { label: "Approved", tone: "good", hint: "Book created; subscription window opened" },
  Rejected: { label: "Rejected", tone: "critical", hint: "Fee refunded and bond unlocked" },
  Expired: { label: "Expired", tone: "neutral", hint: "Committee window elapsed without a decision" },
  Retired: { label: "Retired", tone: "neutral", hint: "Book retired; sponsor bond unlocked" },
  None: { label: "Unknown", tone: "neutral", hint: "" },
};

export const charterState = (s: string | null | undefined): StateMeta => CHARTER_STATES[s ?? "None"] ?? { label: s ?? "Unknown", tone: "neutral", hint: "" };

export interface Meter {
  /** fill end on a 0..1 track */
  fill: number;
  /** marker positions on the track */
  marks: Array<{ at: number; label: string }>;
  tone: Tone;
  /** shaded allowed band on the track (hedge ratio) */
  band?: [number, number];
}

/** Utilisation meter (value is a fraction of the limit; the track runs to 125% so overage shows). */
export function utilMeter(util: number | null | undefined, soft = SOFT_INVENTORY_UTIL): Meter {
  const max = 1.25;
  const u = util != null && Number.isFinite(util) ? Math.max(0, util) : 0;
  const tone: Tone = u > 1 ? "critical" : u >= soft ? "warn" : "accent";
  return {
    fill: Math.min(u, max) / max,
    marks: [
      { at: soft / max, label: `${Math.round(soft * 100)}%` },
      { at: 1 / max, label: "100%" },
    ],
    tone,
  };
}

/** Drawdown from high-water vs the kill threshold (both bps, <= 0). */
export function drawdownMeter(drawdownBps: number | null | undefined, killAtBps: number | null | undefined): Meter & { util: number | null } {
  const k = killAtBps != null && killAtBps < 0 ? killAtBps : null;
  const d = drawdownBps != null && Number.isFinite(drawdownBps) ? Math.min(0, drawdownBps) : 0;
  const util = k ? d / k : null;
  const m = utilMeter(util ?? 0, 0.75);
  return { ...m, marks: [{ at: 0.75 / 1.25, label: "75%" }, { at: 1 / 1.25, label: "kill" }], util };
}

/**
 * Hedge-ratio meter: ratio (bps of |exposure| offset by the desk hedge) against the mandate band.
 * null ratio = exposure below the enforcement threshold (5% of max inventory): no band applies.
 */
export function hedgeMeter(ratioBps: number | null | undefined, minBps: number, maxBps: number): Meter & { inBand: boolean | null } {
  const span = Math.max(maxBps * 1.25, (ratioBps ?? 0) * 1.05, 10_000);
  const band: [number, number] = [minBps / span, maxBps / span];
  if (ratioBps == null || !Number.isFinite(ratioBps)) {
    return { fill: 0, marks: [], tone: "neutral", band, inBand: null };
  }
  const inBand = ratioBps >= minBps && ratioBps <= maxBps;
  return { fill: Math.min(1, Math.max(0, ratioBps / span)), marks: [{ at: 10_000 / span, label: "1.0x" }], tone: inBand ? "good" : "warn", band, inBand };
}

export const HEDGE_THRESHOLD_PCT = Number(HEDGE_RATIO_MIN_EXPOSURE_BPS) / 100;

/** Readable breach codes. */
export const BREACH_TEXT: Record<string, string> = {
  INVENTORY: "Inventory above the mandate maximum",
  SKEW: "Quote skew beyond the mandate maximum",
  WIDTH: "Quote narrower than the mandate minimum width",
  DRAWDOWN: "Drawdown at or past the kill threshold",
  HEDGE_BAND: "Hedge ratio outside its band past the grace period",
};

export const breachText = (code: string) => BREACH_TEXT[code] ?? code;
