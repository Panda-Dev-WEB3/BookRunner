// UI primitives: panels, stats, chips, tables, states. Hairlines, no shadows, tabular numerals.
import { type ReactNode, useState } from "react";
import { useQueryError } from "../api/hooks";
import { addressUrl, txUrl } from "../lib/config";
import { describeError } from "../lib/errors";
import { DASH, shortHex } from "../lib/format";
import type { Meter, StateMeta, Tone } from "../lib/limits";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ------------------------------------------------------------------ layout
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
    <section id={props.id} className={cx("min-w-0 rounded-[3px] border border-line bg-surface", props.className)}>
      {(props.title || props.meta || props.actions) && (
        <header className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-3 py-2 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            {props.title && <h2 className="eyebrow truncate !text-ink">{props.title}</h2>}
            {props.meta && <div className="num truncate text-[11px] text-muted">{props.meta}</div>}
          </div>
          {props.actions && <div className="flex items-center gap-2">{props.actions}</div>}
        </header>
      )}
      <div className={cx("p-3 sm:p-4", props.bodyClassName)}>{props.children}</div>
    </section>
  );
}

export function PageHeader(props: { eyebrow?: ReactNode; title: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-col gap-3 border-b border-line pb-4 sm:mb-5 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {props.eyebrow && <div className="eyebrow mb-1">{props.eyebrow}</div>}
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] sm:text-[26px]">{props.title}</h1>
        {props.sub && <p className="mt-1 max-w-3xl text-[13px] text-ink-2">{props.sub}</p>}
        {props.children}
      </div>
      {props.actions && <div className="flex flex-wrap items-center gap-2">{props.actions}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ values
export function Stat(props: { label: ReactNode; value: ReactNode; sub?: ReactNode; kind?: "live" | "marked"; className?: string; title?: string }) {
  return (
    <div className={cx("min-w-0", props.className)} title={props.title}>
      <div className="flex items-center gap-1.5">
        <span className="eyebrow truncate">{props.label}</span>
        {props.kind && <ValueKind kind={props.kind} compact />}
      </div>
      <div className={cx("num mt-0.5 truncate text-[19px] font-medium leading-7", props.kind === "live" && "text-ink-2")}>{props.value}</div>
      {props.sub && <div className="num text-[11px] leading-snug text-muted">{props.sub}</div>}
    </div>
  );
}

/** Live (estimate) vs marked (signed, committed) badge. */
export function ValueKind({ kind, compact }: { kind: "live" | "marked"; compact?: boolean }) {
  if (kind === "live") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-accent" title="Live estimate between marks">
        <span className="live-dot" aria-hidden />
        {compact ? "live" : "live est."}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-2" title="Signed mark committed on-chain">
      <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
        <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
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
        "inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-[2px] border px-1.5 text-[11px] font-medium leading-none whitespace-nowrap",
        props.solid ? "border-critical bg-critical text-white" : cx(TONE_WASH[props.tone], "text-ink"),
        props.className,
      )}
    >
      <span className={cx("size-[7px] shrink-0 rounded-[1px]", props.solid ? "bg-white" : TONE_DOT[props.tone])} aria-hidden />
      <span className="truncate">{props.children}</span>
    </span>
  );
}

export const StateChip = ({ meta, solid }: { meta: StateMeta; solid?: boolean }) => (
  <Chip tone={meta.tone} title={meta.hint} solid={solid}>
    {meta.label}
  </Chip>
);

export function Hash(props: { value: string | null | undefined; kind?: "tx" | "address" | "hash"; head?: number; tail?: number; className?: string }) {
  const [copied, setCopied] = useState(false);
  if (!props.value) return <span className="num text-muted">{DASH}</span>;
  const v = props.value;
  const url = props.kind === "tx" ? txUrl(v) : props.kind === "address" ? addressUrl(v) : null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(v);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_200);
    } catch {
      // clipboard blocked; the full value is in the tooltip
    }
  };
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
      <button type="button" onClick={copy} className="rounded-[2px] px-0.5 text-muted hover:text-ink" aria-label="Copy to clipboard">
        {copied ? (
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
            <path d="M2 6.4 4.6 9 10 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
            <rect x="3.5" y="3.5" width="7" height="7" fill="none" stroke="currentColor" />
            <path d="M1.5 8.5v-7h7" fill="none" stroke="currentColor" />
          </svg>
        )}
      </button>
    </span>
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
        <span className="eyebrow truncate">{props.label}</span>
        <span className="num text-[13px] font-medium">{props.value}</span>
      </div>
      <div className="relative mt-1.5 h-2 rounded-[1px] bg-surface-3" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(m.fill * 100)}>
        {m.band && (
          <div
            className="absolute inset-y-0 bg-good/25"
            style={{ left: `${m.band[0] * 100}%`, width: `${Math.max(0.5, (m.band[1] - m.band[0]) * 100)}%` }}
            title="Mandate band"
          />
        )}
        <div className={cx("absolute inset-y-0 left-0 rounded-r-[2px]", METER_FILL[m.tone])} style={{ width: `${m.fill * 100}%` }} />
        {m.marks.map((k) => (
          <div key={k.label} className="absolute -inset-y-1 w-px bg-ink/60" style={{ left: `${k.at * 100}%` }} title={k.label} />
        ))}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted">
        <span className="truncate">{props.sub}</span>
        {props.status}
      </div>
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
    <div className={cx("flex flex-col items-start gap-2 rounded-[3px] border border-dashed border-line-strong", props.compact ? "p-3" : "p-5 sm:p-6")}>
      <div className="flex items-center gap-2">
        {props.icon ?? (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="text-muted">
            <rect x="1.5" y="3.5" width="13" height="9" fill="none" stroke="currentColor" />
            <path d="M1.5 6.5h13M5 9.5h3" stroke="currentColor" />
          </svg>
        )}
        <div className="text-[13px] font-semibold">{props.title}</div>
      </div>
      {props.body && <div className="max-w-xl text-[12px] text-ink-2">{props.body}</div>}
      {props.action}
    </div>
  );
}

export function ErrorState(props: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const f = describeError(props.error);
  const offline = f.kind === "offline";
  return (
    <div className={cx("flex flex-col items-start gap-2 rounded-[3px] border", offline ? "border-line-strong bg-surface-2" : "border-critical/40 bg-critical/5", props.compact ? "p-3" : "p-4")} role="alert">
      <div className="flex items-center gap-2">
        <span className={cx("size-2 rounded-[1px]", offline ? "bg-muted" : "bg-critical")} aria-hidden />
        <span className="text-[13px] font-semibold">{f.title}</span>
      </div>
      <div className="max-w-2xl text-[12px] text-ink-2">{f.message}</div>
      {props.onRetry && (
        <button type="button" className="btn h-7 min-h-7 text-[12px]" onClick={props.onRetry}>
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
    <div className="scroll-x -mx-3 sm:-mx-4">
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
        "h-8 border-b border-line bg-surface-2 px-3 text-[10.5px] font-semibold uppercase tracking-[0.07em] whitespace-nowrap text-ink-2 first:pl-3 last:pr-3 sm:first:pl-4 sm:last:pr-4",
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
        "h-9 border-b border-line px-3 align-middle whitespace-nowrap first:pl-3 last:pr-3 sm:first:pl-4 sm:last:pr-4",
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
      <label className="mb-1 block text-[12px] font-medium" htmlFor={props.htmlFor}>
        {props.label}
      </label>
      {props.children}
      {props.error ? (
        <div className="mt-1 text-[11.5px] text-critical-ink">{props.error}</div>
      ) : props.warn ? (
        <div className="mt-1 text-[11.5px] text-warn-ink">{props.warn}</div>
      ) : props.help ? (
        <div className="mt-1 text-[11.5px] text-muted">{props.help}</div>
      ) : null}
    </div>
  );
}

export function Segmented<T extends string>(props: { value: T; options: Array<{ value: T; label: ReactNode; title?: string }>; onChange: (v: T) => void; size?: "sm" | "md"; ariaLabel?: string }) {
  return (
    <div role="radiogroup" aria-label={props.ariaLabel} className="inline-flex max-w-full overflow-x-auto rounded-[3px] border border-line-strong bg-surface p-0.5">
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
              "rounded-[2px] px-2.5 font-medium whitespace-nowrap transition-colors",
              props.size === "sm" ? "h-6 text-[11.5px]" : "h-7 text-[12.5px]",
              on ? "bg-ink text-surface" : "text-ink-2 hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
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
            <dt className="truncate border-b border-line py-1.5 text-ink-2">{k}</dt>
            <dd className="num border-b border-line py-1.5 text-right">{v}</dd>
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
            <span className="hatch inline-block h-2.5 w-3.5 rounded-[1px] border border-line-strong" aria-hidden />
          ) : i.dashed ? (
            <svg width="16" height="6" aria-hidden>
              <line x1="0" y1="3" x2="16" y2="3" stroke={i.color} strokeWidth="2" strokeDasharray="3 2" />
            </svg>
          ) : (
            <span className="inline-block h-2.5 w-3.5 rounded-[1px]" style={{ background: i.color }} aria-hidden />
          )}
          {i.label}
        </li>
      ))}
    </ul>
  );
}
