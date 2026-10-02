// UI primitives. Operator primitives (Panel, Stat, Chip, Table, ...) keep their props; investor
// primitives (Container, Section, Card, Callout, Stepper, Tabs, Accordion, AmountInput, ...) follow
// the same tokens: 8px grid, 12px cards, 1px hairlines, soft shadows in light mode only, tabular
// numerals for figures. Series colours are fixed (lib/palette.ts).
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { useQueryError } from "../api/hooks";
import { type AmountIssue, USDC_DECIMALS, amountIssueText, formatAmountDisplay, formatAmountInput, sanitizeAmountInput } from "../lib/amount";
import { addressUrl, txUrl } from "../lib/config";
import { describeError } from "../lib/errors";
import { DASH, shortHex } from "../lib/format";
import type { GlossaryId } from "../lib/glossary";
import type { Meter, StateMeta, Tone } from "../lib/limits";
import { SERIES_CLASS } from "../lib/palette";
import { cx } from "./cx";
import { IconCheck, IconChevronDown, IconCopy, IconExternal, IconInfo, IconShield, IconWarn } from "./icons";
import { Term } from "./Term";

export { cx } from "./cx";
export { Drawer, Modal } from "./Modal";
export { Term } from "./Term";

// ------------------------------------------------------------------ layout
/** Page-width wrapper: max 1200px, 16px gutters on phones (24 / 32px up). */
export function Container(props: { children?: ReactNode; className?: string; size?: "page" | "wide" | "prose" }) {
  const w = props.size === "prose" ? "max-w-3xl" : props.size === "wide" ? "max-w-[1440px]" : "max-w-page";
  return <div className={cx("mx-auto w-full px-4 sm:px-6 lg:px-8", w, props.className)}>{props.children}</div>;
}

export function SectionHeader(props: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  actions?: ReactNode;
  align?: "left" | "center";
  /** Heading element (default h2). */
  as?: "h1" | "h2" | "h3";
  /** xl: hero, lg: marketing section, md: app page, sm: card-level. */
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const H = props.as ?? "h2";
  const size = props.size ?? "lg";
  const center = props.align === "center";
  const titleCls = {
    sm: "text-[17px] leading-snug",
    md: "text-[22px] leading-tight sm:text-[26px]",
    lg: "text-[26px] leading-tight sm:text-[34px]",
    xl: "text-[34px] leading-[1.08] sm:text-[48px] lg:text-[56px]",
  }[size];
  const leadCls = { sm: "text-[13.5px]", md: "text-[14.5px]", lg: "text-[15.5px] sm:text-[17px]", xl: "text-[16.5px] sm:text-[19px]" }[size];
  return (
    <div className={cx("flex flex-col gap-4", center ? "items-center text-center" : "md:flex-row md:items-end md:justify-between", props.className)}>
      <div className={cx("min-w-0", center ? "max-w-3xl" : "max-w-3xl")}>
        {props.eyebrow && <div className="eyebrow mb-2 !text-accent-text">{props.eyebrow}</div>}
        <H className={cx("font-semibold tracking-[-0.02em] text-ink", titleCls)}>{props.title}</H>
        {props.lead && <p className={cx("mt-3 text-ink-2", leadCls)}>{props.lead}</p>}
      </div>
      {props.actions && <div className={cx("flex flex-wrap items-center gap-2", center && "justify-center")}>{props.actions}</div>}
    </div>
  );
}

/**
 * Full-bleed page band with a contained body. Investor routes render without the shell's
 * container, so they are built from a stack of Sections.
 */
export function Section(props: {
  id?: string;
  eyebrow?: ReactNode;
  title?: ReactNode;
  lead?: ReactNode;
  actions?: ReactNode;
  align?: "left" | "center";
  /** default: page background · muted: alternate band · surface: card colour · hero: soft accent glow */
  tone?: "default" | "muted" | "surface" | "hero";
  /** Vertical rhythm: sm 32px, md 48-64px (default), lg 64-96px. */
  space?: "sm" | "md" | "lg";
  headingAs?: "h1" | "h2" | "h3";
  headerSize?: "sm" | "md" | "lg" | "xl";
  container?: "page" | "wide" | "prose";
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  "aria-label"?: string;
}) {
  const tone = props.tone ?? "default";
  const space = { sm: "py-8", md: "py-12 sm:py-16", lg: "py-16 sm:py-24" }[props.space ?? "md"];
  const bg = { default: "", muted: "bg-surface-2/60 border-y border-line", surface: "bg-surface border-y border-line", hero: "hero-glow" }[tone];
  return (
    <section id={props.id} className={cx(space, bg, props.className)} aria-label={props["aria-label"]}>
      <Container size={props.container}>
        {props.title && (
          <SectionHeader
            eyebrow={props.eyebrow}
            title={props.title}
            lead={props.lead}
            actions={props.actions}
            align={props.align}
            as={props.headingAs}
            size={props.headerSize}
            className="mb-8 sm:mb-10"
          />
        )}
        <div className={props.bodyClassName}>{props.children}</div>
      </Container>
    </section>
  );
}

const CARD_PAD = { none: "", sm: "p-3 sm:p-4", md: "p-4 sm:p-5", lg: "p-5 sm:p-7" } as const;

export function Card(props: {
  children?: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li" | "aside";
  padding?: keyof typeof CARD_PAD;
  /** Hover lift for clickable cards (wrap in a Link or put a stretched link inside). */
  interactive?: boolean;
  tone?: "default" | "muted" | "accent";
  title?: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  id?: string;
  "aria-label"?: string;
}) {
  const El = props.as ?? "div";
  const tone = { default: "bg-surface", muted: "bg-surface-2", accent: "bg-accent-soft border-accent/25" }[props.tone ?? "default"];
  return (
    <El
      id={props.id}
      aria-label={props["aria-label"]}
      className={cx(
        "min-w-0 rounded-card border border-line shadow-card",
        tone,
        CARD_PAD[props.padding ?? "md"],
        props.interactive && "transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-line-strong hover:shadow-raised",
        props.className,
      )}
    >
      {(props.title || props.description || props.eyebrow || props.actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            {props.eyebrow && <div className="eyebrow mb-1">{props.eyebrow}</div>}
            {props.title && <h3 className="text-[15.5px] font-semibold tracking-[-0.01em] text-ink">{props.title}</h3>}
            {props.description && <p className="mt-1 text-[13px] text-ink-2">{props.description}</p>}
          </div>
          {props.actions && <div className="flex items-center gap-2">{props.actions}</div>}
        </div>
      )}
      {props.children}
    </El>
  );
}

export function Panel(props: {
  title?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <section id={props.id} className={cx("min-w-0 rounded-card border border-line bg-surface shadow-card", props.className)}>
      {(props.title || props.meta || props.actions) && (
        <header className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-2.5 sm:px-5">
          {/* the title never truncates: when space runs out the meta wraps below it and truncates instead */}
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            {props.title && <h2 className="text-[14px] font-semibold text-ink">{props.title}</h2>}
            {props.meta && <div className="num min-w-0 max-w-full truncate text-[11.5px] text-muted">{props.meta}</div>}
          </div>
          {props.actions && <div className="flex items-center gap-2">{props.actions}</div>}
        </header>
      )}
      <div className={props.bodyClassName ?? "p-4 sm:p-5"}>{props.children}</div>
    </section>
  );
}

export function PageHeader(props: { eyebrow?: ReactNode; title: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 pb-1 sm:mb-6 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {props.eyebrow && <div className="eyebrow mb-1.5">{props.eyebrow}</div>}
        <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em] sm:text-[28px]">{props.title}</h1>
        {props.sub && <p className="mt-1.5 max-w-3xl text-[14px] text-ink-2">{props.sub}</p>}
        {props.children}
      </div>
      {props.actions && <div className="flex flex-wrap items-center gap-2">{props.actions}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ values
export function Stat(props: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  kind?: "live" | "marked";
  className?: string;
  title?: string;
  /** Wrap the label in a glossary Term. */
  term?: GlossaryId;
  size?: "md" | "lg";
  /** Small series swatch before the label (fixed colour coding). */
  series?: keyof typeof SERIES_CLASS;
}) {
  return (
    <div className={cx("min-w-0", props.className)} title={props.title}>
      <div className="flex items-center gap-1.5">
        {props.series && <span className={cx("size-2 shrink-0 rounded-[2px]", SERIES_CLASS[props.series].bg)} aria-hidden />}
        <span className="truncate text-[12px] font-medium text-ink-2">{props.term ? <Term id={props.term}>{props.label}</Term> : props.label}</span>
        {props.kind && <ValueKind kind={props.kind} compact />}
      </div>
      <div
        className={cx(
          "num mt-1 truncate font-medium tracking-[-0.02em]",
          props.size === "lg" ? "text-[26px] leading-8 sm:text-[30px] sm:leading-9" : "text-[20px] leading-7",
          props.kind === "live" && "text-ink-2",
        )}
      >
        {props.value}
      </div>
      {props.sub && <div className="num mt-0.5 text-[11.5px] leading-snug text-muted">{props.sub}</div>}
    </div>
  );
}

const STAT_COLS = { 2: "grid-cols-2", 3: "grid-cols-2 md:grid-cols-3", 4: "grid-cols-2 lg:grid-cols-4", 5: "grid-cols-2 md:grid-cols-3 lg:grid-cols-5" } as const;

/** A card holding a responsive grid of Stats. */
export function StatGrid(props: { children: ReactNode; cols?: keyof typeof STAT_COLS; className?: string; bare?: boolean }) {
  return (
    <div className={cx("grid gap-x-6 gap-y-5", STAT_COLS[props.cols ?? 4], !props.bare && "rounded-card border border-line bg-surface p-4 shadow-card sm:p-5", props.className)}>
      {props.children}
    </div>
  );
}

/** Live (estimate) vs marked (signed, committed) badge. */
export function ValueKind({ kind, compact }: { kind: "live" | "marked"; compact?: boolean }) {
  if (kind === "live") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-text" title="Live estimate between marks">
        <span className="live-dot" aria-hidden />
        {compact ? "live" : "live est."}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-2" title="Signed mark committed on-chain">
      <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
        <rect x="0.5" y="0.5" width="9" height="9" rx="2" fill="none" stroke="currentColor" />
        <path d="M2.5 5.2 4.3 7 7.6 3.3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      </svg>
      marked
    </span>
  );
}

const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-muted",
  accent: "bg-accent",
  good: "bg-good",
  warn: "bg-warn",
  serious: "bg-serious",
  critical: "bg-critical",
};

const TONE_WASH: Record<Tone, string> = {
  neutral: "bg-surface-2 border-line",
  accent: "bg-accent-soft border-transparent",
  good: "bg-good/10 border-transparent",
  warn: "bg-warn/15 border-transparent",
  serious: "bg-serious/15 border-transparent",
  critical: "bg-critical/12 border-transparent",
};

export function Chip(props: { tone: Tone; children: ReactNode; title?: string; className?: string; solid?: boolean }) {
  return (
    <span
      title={props.title}
      className={cx(
        "inline-flex h-6 max-w-full items-center gap-1.5 rounded-chip border px-2 text-[11.5px] font-medium leading-none whitespace-nowrap",
        props.solid ? "border-critical bg-critical text-white" : cx(TONE_WASH[props.tone], "text-ink"),
        props.className,
      )}
    >
      <span className={cx("size-[7px] shrink-0 rounded-full", props.solid ? "bg-white" : TONE_DOT[props.tone])} aria-hidden />
      <span className="truncate">{props.children}</span>
    </span>
  );
}

export const StateChip = ({ meta, solid }: { meta: StateMeta; solid?: boolean }) => (
  <Chip tone={meta.tone} title={meta.hint} solid={solid}>
    {meta.label}
  </Chip>
);

export type BadgeTone = "neutral" | "accent" | "good" | "warn" | "critical" | "senior" | "junior" | "backstop" | "bkrn" | "fee" | "loss";

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: "border-line bg-surface-2 text-ink-2",
  accent: "border-transparent bg-accent-soft text-accent-text",
  good: "border-transparent bg-good/12 text-good-ink",
  warn: "border-transparent bg-warn/15 text-warn-ink",
  critical: "border-transparent bg-critical/12 text-critical-ink",
  senior: cx("border-transparent", SERIES_CLASS.senior.soft, SERIES_CLASS.senior.text),
  junior: cx("border-transparent", SERIES_CLASS.junior.soft, SERIES_CLASS.junior.text),
  backstop: cx("border-transparent", SERIES_CLASS.backstop.soft, SERIES_CLASS.backstop.text),
  bkrn: cx("border-transparent", SERIES_CLASS.bkrn.soft, SERIES_CLASS.bkrn.text),
  fee: cx("border-transparent", SERIES_CLASS.fee.soft, SERIES_CLASS.fee.text),
  loss: cx("border-transparent", SERIES_CLASS.loss.soft, SERIES_CLASS.loss.text),
};

const BADGE_DOT: Record<BadgeTone, string> = {
  neutral: "bg-muted",
  accent: "bg-accent",
  good: "bg-good",
  warn: "bg-warn",
  critical: "bg-critical",
  senior: SERIES_CLASS.senior.bg,
  junior: SERIES_CLASS.junior.bg,
  backstop: SERIES_CLASS.backstop.bg,
  bkrn: SERIES_CLASS.bkrn.bg,
  fee: SERIES_CLASS.fee.bg,
  loss: SERIES_CLASS.loss.bg,
};

/** Rounded pill label. Status tones always come with words, never colour alone. */
export function Badge(props: { tone?: BadgeTone; children: ReactNode; icon?: ReactNode; dot?: boolean; size?: "sm" | "md"; className?: string; title?: string }) {
  const tone = props.tone ?? "neutral";
  return (
    <span
      title={props.title}
      className={cx(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border font-medium whitespace-nowrap",
        props.size === "sm" ? "h-5 px-2 text-[11px]" : "h-6 px-2.5 text-[12px]",
        BADGE_TONE[tone],
        props.className,
      )}
    >
      {props.dot && <span className={cx("size-1.5 shrink-0 rounded-full", BADGE_DOT[tone])} aria-hidden />}
      {props.icon}
      <span className="truncate">{props.children}</span>
    </span>
  );
}
export const Pill = Badge;

export type TrancheKind = "senior" | "junior" | "backstop";
const TRANCHE_LABEL: Record<TrancheKind, string> = { senior: "Senior", junior: "Junior", backstop: "Backstop" };
const TRANCHE_TERM: Record<TrancheKind, GlossaryId> = { senior: "senior", junior: "junior", backstop: "backstop" };

/** Senior (blue) / Junior (amber) / Backstop (violet) label in the fixed colour coding. */
export function TrancheBadge(props: { tranche: TrancheKind; size?: "sm" | "md"; /** Make the label a glossary Term. */ term?: boolean; className?: string; children?: ReactNode }) {
  const label = props.children ?? TRANCHE_LABEL[props.tranche];
  return (
    <Badge tone={props.tranche} dot size={props.size} className={props.className}>
      {props.term ? <Term id={TRANCHE_TERM[props.tranche]}>{label}</Term> : label}
    </Badge>
  );
}

export function Hash(props: { value: string | null | undefined; kind?: "tx" | "address" | "hash"; head?: number; tail?: number; className?: string }) {
  if (!props.value) return <span className="num text-muted">{DASH}</span>;
  const v = props.value;
  const url = props.kind === "tx" ? txUrl(v) : props.kind === "address" ? addressUrl(v) : null;
  const text = shortHex(v, props.head ?? 6, props.tail ?? 4);
  return (
    <span className={cx("num inline-flex items-center gap-1 text-[12px]", props.className)} title={v}>
      {url ? (
        <a className="link" href={url} target="_blank" rel="noreferrer">
          {text}
        </a>
      ) : (
        <span>{text}</span>
      )}
      <CopyButton value={v} />
    </span>
  );
}

/** Small icon button that copies `value` (with a confirmation tick and a polite announcement). */
export function CopyButton(props: { value: string; label?: string; className?: string; size?: number }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_400);
    } catch {
      // clipboard blocked; the full value is in the tooltip
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className={cx("inline-flex items-center justify-center rounded-[5px] p-0.5 text-muted transition-colors hover:text-ink", props.className)}
      aria-label={copied ? "Copied" : (props.label ?? "Copy to clipboard")}
      title={copied ? "Copied" : (props.label ?? "Copy to clipboard")}
    >
      {copied ? <IconCheck size={props.size ?? 13} className="text-good-ink" /> : <IconCopy size={props.size ?? 13} />}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

/** Link to another site: opens in a new tab, with an icon and a hint for screen readers. */
export function ExternalLink(props: { href: string; children: ReactNode; className?: string; icon?: boolean }) {
  return (
    <a href={props.href} target="_blank" rel="noreferrer noopener" className={cx("inline-flex items-center gap-1", props.className ?? "link")}>
      {props.children}
      {props.icon !== false && <IconExternal size={13} className="shrink-0 opacity-70" />}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

// ------------------------------------------------------------------ meters
const METER_FILL: Record<Tone, string> = {
  neutral: "bg-muted",
  accent: "bg-accent",
  good: "bg-good",
  warn: "bg-warn",
  serious: "bg-serious",
  critical: "bg-critical",
};

export function MeterBar(props: { meter: Meter; label: ReactNode; value: ReactNode; sub?: ReactNode; status?: ReactNode }) {
  const m = props.meter;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[12px] font-medium text-ink-2">{props.label}</span>
        <span className="num text-[13px] font-medium">{props.value}</span>
      </div>
      <div className="relative mt-1.5 h-2 rounded-full bg-surface-3" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(m.fill * 100)}>
        {m.band && (
          <div
            className="absolute inset-y-0 bg-good/25"
            style={{ left: `${m.band[0] * 100}%`, width: `${Math.max(0.5, (m.band[1] - m.band[0]) * 100)}%` }}
            title="Mandate band"
          />
        )}
        <div className={cx("absolute inset-y-0 left-0 rounded-full", METER_FILL[m.tone])} style={{ width: `${m.fill * 100}%` }} />
        {m.marks.map((k) => (
          <div key={k.label} className="absolute -inset-y-1 w-px bg-ink/60" style={{ left: `${k.at * 100}%` }} title={k.label} />
        ))}
      </div>
      {/* wraps rather than truncating: the limit itself ("max 50K", "band 50% to 120%") must stay readable */}
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-[11px] text-muted">
        <span className="min-w-0 break-words">{props.sub}</span>
        {props.status && <span className="shrink-0">{props.status}</span>}
      </div>
    </div>
  );
}

const PROGRESS_FILL = {
  accent: "bg-accent",
  good: "bg-good",
  warn: "bg-warn",
  critical: "bg-critical",
  senior: SERIES_CLASS.senior.bg,
  junior: SERIES_CLASS.junior.bg,
  backstop: SERIES_CLASS.backstop.bg,
  fee: SERIES_CLASS.fee.bg,
  loss: SERIES_CLASS.loss.bg,
} as const;

/** Simple 0..1 progress bar (capacity used, steps done). `label` names it for screen readers. */
export function ProgressBar(props: { value: number; label: string; tone?: keyof typeof PROGRESS_FILL; className?: string; size?: "sm" | "md" }) {
  const v = Number.isFinite(props.value) ? Math.max(0, Math.min(1, props.value)) : 0;
  return (
    <div
      className={cx("w-full overflow-hidden rounded-full bg-surface-3", props.size === "md" ? "h-2" : "h-1.5", props.className)}
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
    >
      <div className={cx("h-full rounded-full transition-[width] duration-300", PROGRESS_FILL[props.tone ?? "accent"])} style={{ width: `${v * 100}%` }} />
    </div>
  );
}

export function Spinner(props: { className?: string; size?: number; label?: string }) {
  const s = props.size ?? 16;
  return (
    <span className={cx("inline-flex items-center", props.className)} role={props.label ? "status" : undefined}>
      <svg className="spin" width={s} height={s} viewBox="0 0 20 20" fill="none" aria-hidden>
        <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.2" />
        <path d="M17.5 10A7.5 7.5 0 0 0 10 2.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      {props.label && <span className="sr-only">{props.label}</span>}
    </span>
  );
}

// ------------------------------------------------------------------ messages
const CALLOUT = {
  info: { box: "border-accent/25 bg-accent-soft", icon: "text-accent-text", Icon: IconInfo },
  warn: { box: "border-warn/40 bg-warn/10", icon: "text-warn-ink", Icon: IconWarn },
  risk: { box: "border-critical/30 bg-critical/[0.06]", icon: "text-critical-ink", Icon: IconShield },
  success: { box: "border-good/30 bg-good/[0.07]", icon: "text-good-ink", Icon: IconCheck },
  neutral: { box: "border-line bg-surface-2", icon: "text-ink-2", Icon: IconInfo },
} as const;

export type CalloutTone = keyof typeof CALLOUT;

/** Boxed note: info (how it works), warn (check this), risk (money at stake), success. */
export function Callout(props: { tone?: CalloutTone; title?: ReactNode; children?: ReactNode; icon?: ReactNode; action?: ReactNode; className?: string; compact?: boolean }) {
  const t = CALLOUT[props.tone ?? "info"];
  return (
    <div role="note" className={cx("flex gap-3 rounded-card border", props.compact ? "p-3 text-[12.5px]" : "p-4 text-[13.5px]", t.box, props.className)}>
      <span className={cx("mt-px shrink-0", t.icon)}>{props.icon ?? <t.Icon size={props.compact ? 16 : 18} />}</span>
      <div className="min-w-0 flex-1">
        {props.title && <div className="font-semibold text-ink">{props.title}</div>}
        {props.children && <div className={cx("text-ink-2", props.title ? "mt-1" : null)}>{props.children}</div>}
        {props.action && <div className="mt-3 flex flex-wrap gap-2">{props.action}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ steps / disclosure
export type StepStatus = "done" | "active" | "todo";

export interface StepperStep {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  status: StepStatus;
  /** Shown under the description (buttons, links). Rendered for the active step by default. */
  action?: ReactNode;
  /** Short right-aligned note (e.g. "0.05 ETH"). */
  meta?: ReactNode;
}

const STEP_SR: Record<StepStatus, string> = { done: "Completed", active: "Current step", todo: "Not started" };

/** Numbered vertical steps with done / active / todo states. */
export function Stepper(props: { steps: StepperStep[]; className?: string; ariaLabel?: string; /** Show actions on every step, not only the active one. */ showAllActions?: boolean; compact?: boolean }) {
  return (
    <ol className={cx("relative", props.className)} aria-label={props.ariaLabel}>
      {props.steps.map((s, i) => {
        const last = i === props.steps.length - 1;
        return (
          <li key={s.id} className="relative flex gap-3.5 pb-5 last:pb-0" aria-current={s.status === "active" ? "step" : undefined}>
            {!last && <span className={cx("absolute top-8 bottom-1 left-[13px] w-px", s.status === "done" ? "bg-good/50" : "bg-line-strong")} aria-hidden />}
            <span
              className={cx(
                "relative z-[1] mt-0.5 inline-flex size-[27px] shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold tnum",
                s.status === "done" && "border-good bg-good text-surface",
                s.status === "active" && "border-accent bg-surface text-accent-text ring-4 ring-accent-soft",
                s.status === "todo" && "border-line-strong bg-surface text-muted",
              )}
              aria-hidden
            >
              {s.status === "done" ? <IconCheck size={14} strokeWidth={2.4} /> : i + 1}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <div className={cx("font-semibold", props.compact ? "text-[13.5px]" : "text-[14.5px]", s.status === "todo" ? "text-ink-2" : "text-ink")}>
                  <span className="sr-only">{`Step ${i + 1}, ${STEP_SR[s.status]}: `}</span>
                  {s.title}
                </div>
                {s.meta && <div className="num text-[12px] text-ink-2">{s.meta}</div>}
              </div>
              {s.description && (s.status !== "done" || !props.compact) && <div className="mt-1 text-[13px] text-ink-2">{s.description}</div>}
              {s.action && (props.showAllActions || s.status === "active") && <div className="mt-3 flex flex-wrap items-center gap-2">{s.action}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  content: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}

/**
 * Accessible tabs (arrow keys, Home / End). Controlled with value + onChange, or uncontrolled.
 * keepMounted renders every panel and hides the inactive ones, so a panel's state (a form, a
 * transaction list in flight) survives a look at another tab.
 */
export function Tabs<T extends string = string>(props: {
  items: Array<TabItem<T>>;
  ariaLabel: string;
  value?: T;
  defaultValue?: T;
  onChange?: (id: T) => void;
  keepMounted?: boolean;
  className?: string;
  panelClassName?: string;
}) {
  const base = useId();
  const [inner, setInner] = useState<T | undefined>(props.defaultValue ?? props.items[0]?.id);
  const value = props.value ?? inner;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = props.items.filter((t) => !t.disabled);
  const select = (id: T) => {
    if (props.value === undefined) setInner(id);
    props.onChange?.(id);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const idx = enabled.findIndex((t) => t.id === value);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (idx + 1) % enabled.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = enabled.length - 1;
    if (next === null) return;
    e.preventDefault();
    const t = enabled[next];
    if (!t) return;
    select(t.id);
    refs.current[props.items.indexOf(t)]?.focus();
  };
  const active = props.items.find((t) => t.id === value) ?? props.items[0];
  return (
    <div className={props.className}>
      <div role="tablist" aria-label={props.ariaLabel} className="scroll-x no-scrollbar flex gap-1 border-b border-line">
        {props.items.map((t, i) => {
          const on = t.id === active?.id;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-selected={on}
              aria-controls={`${base}-panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              disabled={t.disabled}
              onClick={() => select(t.id)}
              onKeyDown={onKey}
              className={cx(
                "-mb-px inline-flex h-10 items-center gap-2 border-b-2 px-3 text-[13.5px] font-medium whitespace-nowrap transition-colors disabled:opacity-40",
                on ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink",
              )}
            >
              {t.label}
              {t.badge}
            </button>
          );
        })}
      </div>
      {props.keepMounted
        ? props.items.map((t) => (
            <div
              key={t.id}
              role="tabpanel"
              id={`${base}-panel-${t.id}`}
              aria-labelledby={`${base}-tab-${t.id}`}
              hidden={t.id !== active?.id}
              tabIndex={0}
              className={cx("pt-4 focus-visible:outline-offset-4", props.panelClassName)}
            >
              {t.content}
            </div>
          ))
        : active && (
            <div role="tabpanel" id={`${base}-panel-${active.id}`} aria-labelledby={`${base}-tab-${active.id}`} tabIndex={0} className={cx("pt-4 focus-visible:outline-offset-4", props.panelClassName)}>
              {active.content}
            </div>
          )}
    </div>
  );
}

export interface AccordionItem {
  id: string;
  title: ReactNode;
  content: ReactNode;
}

/** FAQ-style disclosure list. Each header is a button with aria-expanded controlling its region. */
export function Accordion(props: { items: AccordionItem[]; multiple?: boolean; defaultOpen?: string[]; headingLevel?: 2 | 3 | 4; className?: string }) {
  const base = useId();
  const [open, setOpen] = useState<string[]>(props.defaultOpen ?? []);
  const H = (`h${props.headingLevel ?? 3}` as "h2" | "h3" | "h4");
  const toggle = (id: string) =>
    setOpen((o) => (o.includes(id) ? o.filter((x) => x !== id) : props.multiple ? [...o, id] : [id]));
  return (
    <div className={cx("divide-y divide-line rounded-card border border-line bg-surface shadow-card", props.className)}>
      {props.items.map((it) => {
        const on = open.includes(it.id);
        return (
          <div key={it.id}>
            <H className="m-0">
              <button
                type="button"
                id={`${base}-h-${it.id}`}
                aria-expanded={on}
                aria-controls={`${base}-p-${it.id}`}
                onClick={() => toggle(it.id)}
                className="flex w-full items-center justify-between gap-4 rounded-card px-4 py-4 text-left text-[14.5px] font-semibold text-ink hover:bg-surface-2/60 sm:px-5"
              >
                <span>{it.title}</span>
                <IconChevronDown size={18} className={cx("shrink-0 text-muted transition-transform duration-200", on && "rotate-180")} />
              </button>
            </H>
            <div id={`${base}-p-${it.id}`} role="region" aria-labelledby={`${base}-h-${it.id}`} hidden={!on} className="px-4 pb-5 text-[14px] text-ink-2 sm:px-5">
              {it.content}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ states
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className ?? "h-4 w-full")} aria-hidden />;
}

export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx("space-y-2", className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cx("h-7", i % 3 === 2 ? "w-3/4" : "w-full")} />
      ))}
    </div>
  );
}

export function EmptyState(props: { title: ReactNode; body?: ReactNode; action?: ReactNode; compact?: boolean; icon?: ReactNode }) {
  return (
    <div className={cx("flex flex-col items-start gap-2 rounded-card border border-dashed border-line-strong bg-surface/50", props.compact ? "p-3.5" : "p-5 sm:p-6")}>
      <div className="flex items-center gap-2">
        {props.icon ?? (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="text-muted">
            <rect x="1.5" y="3.5" width="13" height="9" rx="2" fill="none" stroke="currentColor" />
            <path d="M1.5 6.5h13M5 9.5h3" stroke="currentColor" />
          </svg>
        )}
        <div className="text-[13.5px] font-semibold">{props.title}</div>
      </div>
      {props.body && <div className="max-w-xl text-[12.5px] text-ink-2">{props.body}</div>}
      {props.action}
    </div>
  );
}

export function ErrorState(props: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const f = describeError(props.error);
  const offline = f.kind === "offline";
  return (
    <div className={cx("flex flex-col items-start gap-2 rounded-card border", offline ? "border-line-strong bg-surface-2" : "border-critical/40 bg-critical/5", props.compact ? "p-3" : "p-4")} role="alert">
      <div className="flex items-center gap-2">
        <span className={cx("size-2 rounded-full", offline ? "bg-muted" : "bg-critical")} aria-hidden />
        <span className="text-[13.5px] font-semibold">{f.title}</span>
      </div>
      <div className="max-w-2xl text-[12.5px] text-ink-2">{f.message}</div>
      {props.onRetry && (
        <button type="button" className="btn btn-sm" onClick={props.onRetry}>
          Retry now
        </button>
      )}
    </div>
  );
}

interface QueryLike<T> {
  data: T | undefined;
  error: unknown;
  failureReason?: unknown;
  isLoading: boolean;
  refetch: () => unknown;
}

/** Loading / error / empty / data switch for a query. Keeps showing stale data on refetch errors. */
export function QueryView<T>(props: {
  q: QueryLike<T>;
  children: (data: T) => ReactNode;
  empty?: (data: T) => boolean;
  emptyView?: ReactNode;
  loading?: ReactNode;
  compact?: boolean;
}) {
  const { q } = props;
  const error = useQueryError(q);
  if (q.data === undefined) {
    if (error) return <ErrorState error={error} onRetry={() => q.refetch()} compact={props.compact} />;
    return <>{props.loading ?? <SkeletonRows rows={props.compact ? 2 : 4} />}</>;
  }
  if (props.empty?.(q.data)) return <>{props.emptyView ?? <EmptyState title="Nothing here yet" compact={props.compact} />}</>;
  return (
    <>
      {q.error ? (
        <div className="mb-2 text-[11px] text-muted" role="status">
          Showing the last data received; {describeError(q.error).title.toLowerCase()}.
        </div>
      ) : null}
      {props.children(q.data)}
    </>
  );
}

// ------------------------------------------------------------------ tables
export function Table(props: { children: ReactNode; className?: string; minWidth?: number }) {
  return (
    // relative: absolutely positioned children (sr-only copy announcements) stay clipped by the scroller
    <div className="scroll-x relative -mx-4 sm:-mx-5">
      <table className={cx("w-full text-[12.5px]", props.className)} style={{ minWidth: props.minWidth }}>
        {props.children}
      </table>
    </div>
  );
}

export function Th(props: { children?: ReactNode; right?: boolean; className?: string; title?: string }) {
  return (
    <th
      title={props.title}
      className={cx(
        "h-9 border-b border-line bg-surface-2/70 px-3 text-[11px] font-semibold tracking-[0.04em] whitespace-nowrap text-ink-2 uppercase first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5",
        props.right ? "text-right" : "text-left",
        props.className,
      )}
    >
      {props.children}
    </th>
  );
}

export function Td(props: { children?: ReactNode; right?: boolean; num?: boolean; className?: string; title?: string; colSpan?: number }) {
  return (
    <td
      title={props.title}
      colSpan={props.colSpan}
      className={cx(
        "h-10 border-b border-line px-3 align-middle whitespace-nowrap first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5",
        props.right && "text-right",
        props.num && "num",
        props.className,
      )}
    >
      {props.children}
    </td>
  );
}

// ------------------------------------------------------------------ forms
export function Field(props: { label: ReactNode; help?: ReactNode; error?: string | null; warn?: string | null; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={cx("min-w-0", props.className)}>
      <label className="mb-1.5 block text-[12.5px] font-medium" htmlFor={props.htmlFor}>
        {props.label}
      </label>
      {props.children}
      {props.error ? (
        <div className="mt-1 text-[12px] text-critical-ink">{props.error}</div>
      ) : props.warn ? (
        <div className="mt-1 text-[12px] text-warn-ink">{props.warn}</div>
      ) : props.help ? (
        <div className="mt-1 text-[12px] text-muted">{props.help}</div>
      ) : null}
    </div>
  );
}

/**
 * Radio group of 2-4 options. `layout`: one inline row (default; scrolls when too narrow), an even
 * two-column grid, or a full-width stack, for groups that would otherwise wrap unevenly.
 */
export function Segmented<T extends string>(props: {
  value: T;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  onChange: (v: T) => void;
  size?: "sm" | "md";
  ariaLabel?: string;
  className?: string;
  layout?: "inline" | "grid" | "stack";
}) {
  const layout = props.layout ?? "inline";
  return (
    <div
      role="radiogroup"
      aria-label={props.ariaLabel}
      className={cx(
        "rounded-control border border-line bg-surface-2 p-0.5",
        layout === "grid" ? "grid w-full grid-cols-2 gap-0.5" : layout === "stack" ? "flex w-full flex-col gap-0.5" : "inline-flex max-w-full overflow-x-auto",
        props.className,
      )}
    >
      {props.options.map((o) => {
        const on = o.value === props.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => props.onChange(o.value)}
            className={cx(
              "rounded-[6px] px-3 font-medium whitespace-nowrap transition-[background,color,box-shadow] duration-150",
              layout === "stack" && "text-left",
              layout !== "inline" && "min-w-0 truncate",
              props.size === "sm" ? "h-6 text-[11.5px]" : "h-8 text-[13px]",
              on ? "bg-surface text-ink shadow-card ring-1 ring-line-strong" : "text-ink-2 hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
/** Alias of Segmented (radio-group of 2-4 options). */
export const SegmentedControl = Segmented;

/**
 * Token amount input with the wallet balance and a Max button. `value` is the raw text the person
 * typed (sanitised); parse it with parseAmount(value, decimals) from lib/amount.ts.
 */
export function AmountInput(props: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  symbol?: string;
  decimals?: number;
  /** Wallet balance in base units; shows "Balance" and enables Max. null/undefined: unknown. */
  balance?: bigint | null;
  balanceLabel?: ReactNode;
  /** Max fills this amount instead of the balance (e.g. min(balance, capacity)). */
  max?: bigint | null;
  /** Problem to show (from amountIssue); overrides `error` text with the standard message. */
  issue?: AmountIssue | null;
  error?: string | null;
  help?: ReactNode;
  disabled?: boolean;
  placeholder?: string;
}) {
  const decimals = props.decimals ?? USDC_DECIMALS;
  const symbol = props.symbol ?? "USDC";
  const errText = props.error ?? amountIssueText(props.issue ?? null, symbol);
  const helpId = `${props.id}-help`;
  const maxRaw = props.max ?? props.balance ?? null;
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={props.id} className="text-[12.5px] font-medium">
          {props.label}
        </label>
        {props.balance !== undefined && (
          <span className="num text-[12px] text-ink-2">
            {props.balanceLabel ?? "Balance"} {props.balance === null ? DASH : `${formatAmountDisplay(props.balance, decimals)} ${symbol}`}
          </span>
        )}
      </div>
      <div
        className={cx(
          "flex items-center gap-2 rounded-control border bg-surface pr-1.5 transition-[border-color,box-shadow] duration-150 focus-within:border-focus focus-within:shadow-[0_0_0_3px_var(--accent-soft)]",
          errText ? "border-critical" : "border-line-strong",
          props.disabled && "bg-surface-2 opacity-70",
        )}
      >
        <input
          id={props.id}
          className="num h-12 min-w-0 flex-1 bg-transparent px-3 text-[18px] font-medium outline-none placeholder:text-muted/70"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder={props.placeholder ?? "0.00"}
          value={props.value}
          disabled={props.disabled}
          aria-invalid={errText ? true : undefined}
          aria-describedby={errText || props.help ? helpId : undefined}
          onChange={(e) => props.onChange(sanitizeAmountInput(e.target.value, decimals))}
        />
        <span className="text-[13px] font-medium text-ink-2">{symbol}</span>
        {maxRaw !== null && maxRaw !== undefined && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={props.disabled || maxRaw <= 0n}
            onClick={() => props.onChange(formatAmountInput(maxRaw, decimals, Math.min(decimals, 6)))}
            aria-label={`Use the maximum: ${formatAmountDisplay(maxRaw, decimals)} ${symbol}`}
          >
            Max
          </button>
        )}
      </div>
      {(errText || props.help) && (
        <div id={helpId} className={cx("mt-1.5 text-[12px]", errText ? "text-critical-ink" : "text-muted")}>
          {errText ?? props.help}
        </div>
      )}
    </div>
  );
}

export function KV(props: { rows: Array<[ReactNode, ReactNode] | null | false>; className?: string }) {
  return (
    <dl className={cx("grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 text-[12.5px]", props.className)}>
      {props.rows.filter(Boolean).map((r, i) => {
        const [k, v] = r as [ReactNode, ReactNode];
        return (
          <div key={i} className="contents">
            <dt className="min-w-0 break-words border-b border-line py-2 text-ink-2">{k}</dt>
            <dd className="num border-b border-line py-2 text-right">{v}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function Legend(props: { items: Array<{ label: ReactNode; color: string; dashed?: boolean; hatch?: boolean }> }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-2">
      {props.items.map((i, k) => (
        <li key={k} className="inline-flex items-center gap-1.5">
          {i.hatch ? (
            <span className="hatch inline-block h-2.5 w-3.5 rounded-[2px] border border-line-strong" aria-hidden />
          ) : i.dashed ? (
            <svg width="16" height="6" aria-hidden>
              <line x1="0" y1="3" x2="16" y2="3" stroke={i.color} strokeWidth="2" strokeDasharray="3 2" />
            </svg>
          ) : (
            <span className="inline-block h-2.5 w-3.5 rounded-[2px]" style={{ background: i.color }} aria-hidden />
          )}
          {i.label}
        </li>
      ))}
    </ul>
  );
}
