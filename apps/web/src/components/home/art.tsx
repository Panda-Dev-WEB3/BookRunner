// Inline SVG illustrations for the Home page's five steps, drawn in code with the theme tokens and
// the fixed series colours (Senior blue, Junior amber, Backstop / BKRN violet, fee flow green).
// Decorative: the step text next to each one carries the meaning, so every SVG is aria-hidden.
import type { ReactNode } from "react";
import { SERIES } from "../../lib/palette";

const SURFACE = "var(--surface)";
const LINE = "var(--line-strong)";
const SOFT = "var(--surface-3)";
const ACCENT = "var(--accent)";
const ACCENT_SOFT = "var(--accent-soft)";
const INK2 = "var(--ink-2)";
const GOOD = "var(--good)";

function Art({ children, label }: { children: ReactNode; label: string }) {
  return (
    <svg viewBox="0 0 160 100" className="h-auto w-full" aria-hidden focusable="false" data-art={label}>
      {children}
    </svg>
  );
}

/** 1. A sponsor files a charter and locks a BKRN bond. */
export function CharterArt() {
  return (
    <Art label="charter">
      <rect x="52" y="10" width="62" height="80" rx="7" fill={SURFACE} stroke={LINE} />
      <rect x="62" y="22" width="30" height="5" rx="2.5" fill={INK2} opacity="0.55" />
      <rect x="62" y="34" width="42" height="4" rx="2" fill={SOFT} />
      <rect x="62" y="43" width="38" height="4" rx="2" fill={SOFT} />
      <rect x="62" y="52" width="42" height="4" rx="2" fill={SOFT} />
      <rect x="62" y="61" width="24" height="4" rx="2" fill={SOFT} />
      <circle cx="101" cy="76" r="9" fill={ACCENT_SOFT} stroke={ACCENT} strokeWidth="1.5" />
      <path d="m97 76 3 3 5.5-6" fill="none" stroke={ACCENT} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      {/* BKRN bond, locked */}
      <rect x="22" y="56" width="26" height="22" rx="5" fill={SERIES.backstop} opacity="0.16" stroke={SERIES.backstop} strokeWidth="1.5" />
      <path d="M28 56v-5a7 7 0 0 1 14 0v5" fill="none" stroke={SERIES.backstop} strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="35" cy="66" r="2.6" fill={SERIES.backstop} />
      <path d="M35 68v4" stroke={SERIES.backstop} strokeWidth="1.5" strokeLinecap="round" />
    </Art>
  );
}

/** 2. The Risk Committee approves, two of three. */
export function CommitteeArt() {
  const member = (x: number, ok: boolean) => (
    <g key={x}>
      <circle cx={x} cy="36" r="9" fill={SURFACE} stroke={LINE} />
      <path d={`M${x - 15} 66a15 15 0 0 1 30 0`} fill={SURFACE} stroke={LINE} />
      <circle cx={x + 10} cy="27" r="6.5" fill={ok ? GOOD : SOFT} stroke={SURFACE} strokeWidth="1.5" />
      {ok ? (
        <path d={`m${x + 7} 27 2.2 2.2 4-4.4`} fill="none" stroke={SURFACE} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d={`M${x + 7.5} 27h5`} stroke={INK2} strokeWidth="1.6" strokeLinecap="round" />
      )}
    </g>
  );
  return (
    <Art label="committee">
      {member(42, true)}
      {member(80, true)}
      {member(118, false)}
      <rect x="27" y="78" width="106" height="8" rx="4" fill={SOFT} />
      <rect x="27" y="78" width="70.6" height="8" rx="4" fill={ACCENT} />
      <path d="M62.3 78v8M97.3 78v8" stroke={SURFACE} strokeWidth="1.5" />
    </Art>
  );
}

/** 3. Allocators fund the Senior and Junior tranches. */
export function FundArt() {
  const coin = (x: number, y: number) => (
    <g key={`${x}-${y}`}>
      <circle cx={x} cy={y} r="7" fill={SURFACE} stroke={ACCENT} strokeWidth="1.5" />
      <path d={`M${x} ${y - 3.5}v7M${x - 2.4} ${y - 1.4}h3.6a1.4 1.4 0 0 1 0 2.8h-2.4a1.4 1.4 0 0 0 0 2.8h3.6`} fill="none" stroke={ACCENT} strokeWidth="1.1" strokeLinecap="round" />
    </g>
  );
  return (
    <Art label="fund">
      {coin(58, 14)}
      {coin(80, 10)}
      {coin(102, 14)}
      <path d="M80 23v9m-4-4 4 4 4-4" fill="none" stroke={INK2} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="40" y="38" width="80" height="26" rx="6" fill={SERIES.senior} opacity="0.85" />
      <rect x="40" y="66" width="80" height="24" rx="6" fill={SERIES.junior} opacity="0.85" />
      <rect x="48" y="48" width="26" height="5" rx="2.5" fill={SURFACE} opacity="0.85" />
      <rect x="48" y="75" width="20" height="5" rx="2.5" fill={SURFACE} opacity="0.85" />
    </Art>
  );
}

/** 4. The agent quotes and hedges inside the mandate's band. */
export function AgentArt() {
  return (
    <Art label="agent">
      <rect x="14" y="22" width="132" height="54" rx="6" fill={ACCENT_SOFT} />
      <path d="M14 22h132M14 76h132" stroke={ACCENT} strokeWidth="1.4" strokeDasharray="4 3" />
      <path d="M18 56c10-4 16 6 26 2s12-16 24-14 14 14 26 10 12-14 24-12 12 8 24 6" fill="none" stroke={INK2} strokeWidth="1.8" strokeLinecap="round" />
      {/* bid / ask quotes around the last price */}
      <rect x="128" y="34" width="14" height="5" rx="2" fill={ACCENT} />
      <rect x="128" y="52" width="14" height="5" rx="2" fill={ACCENT} opacity="0.55" />
      <circle cx="138" cy="45.5" r="3" fill={INK2} />
      {/* hedge leg */}
      <rect x="22" y="84" width="40" height="8" rx="4" fill={SOFT} />
      <rect x="22" y="84" width="26" height="8" rx="4" fill={INK2} opacity="0.5" />
      <path d="m70 88h12m-3-3 3 3-3 3" fill="none" stroke={INK2} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="88" y="84" width="40" height="8" rx="4" fill={SOFT} />
    </Art>
  );
}

/** 5. Fee flow runs down the waterfall; the mark is signed. */
export function WaterfallArt() {
  return (
    <Art label="waterfall">
      <path d="M30 10v14" stroke={SERIES.fee} strokeWidth="5" strokeLinecap="round" />
      <rect x="18" y="26" width="34" height="9" rx="3" fill={SOFT} />
      <path d="M52 30.5h10v8" fill="none" stroke={SERIES.fee} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="50" y="40" width="26" height="9" rx="3" fill={SERIES.backstop} opacity="0.75" />
      <path d="M76 44.5h10v8" fill="none" stroke={SERIES.fee} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="70" y="54" width="40" height="11" rx="3" fill={SERIES.senior} opacity="0.85" />
      <path d="M110 59.5h8v8" fill="none" stroke={SERIES.fee} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="100" y="70" width="40" height="11" rx="3" fill={SERIES.junior} opacity="0.85" />
      {/* the signed mark */}
      <circle cx="34" cy="74" r="13" fill={SURFACE} stroke={ACCENT} strokeWidth="1.5" />
      <circle cx="34" cy="74" r="9" fill="none" stroke={ACCENT} strokeWidth="1" strokeDasharray="2 2" />
      <path d="m29.5 74 3 3 5.5-6" fill="none" stroke={ACCENT} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </Art>
  );
}

/** Small moon glyph (off-hours rule). */
export function IconMoon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" className={className}>
      <path d="M16 12.2A6.5 6.5 0 0 1 7.8 4 6.5 6.5 0 1 0 16 12.2Z" />
    </svg>
  );
}

/** Small receipt glyph (signed marks). */
export function IconReceipt({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" className={className}>
      <path d="M5 2.5h10v15l-2.5-1.5-2.5 1.5-2.5-1.5L5 17.5z" />
      <path d="M8 7h4M8 10h4M8 13h2" />
    </svg>
  );
}

/** Small gauge glyph (mandate limits). */
export function IconGauge({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" className={className}>
      <path d="M3 14a7 7 0 1 1 14 0" />
      <path d="m10 14 3.5-4.5" />
      <circle cx="10" cy="14" r="1.2" />
    </svg>
  );
}

/** Small people glyph (committee). */
export function IconPeople({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" className={className}>
      <circle cx="7.5" cy="7" r="2.8" />
      <path d="M2.5 16.5a5 5 0 0 1 10 0" />
      <circle cx="14" cy="7.5" r="2.2" />
      <path d="M13.5 12.2a4 4 0 0 1 4 4.3" />
    </svg>
  );
}

/** Small agent glyph (bookrunner agent). */
export function IconAgent({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" className={className}>
      <rect x="4" y="6" width="12" height="10" rx="2.5" />
      <path d="M10 6V3.5M8 11h.01M12 11h.01M2 10.5v2M18 10.5v2" />
    </svg>
  );
}
