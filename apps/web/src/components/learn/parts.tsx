// Building blocks shared by the How it works sections: the section wrapper, figure frame, flow nodes and
// arrows for the HTML diagrams, in-page anchor links (smooth unless reduced motion) and the scroll spy.
import { type MouseEvent, type ReactNode, useEffect, useState } from "react";
import type { SeriesKey } from "../../lib/palette";
import { SERIES_CLASS } from "../../lib/palette";
import { cx } from "../cx";
import { pickActive } from "./sections";

/** Header height plus reading room: where a section counts as "being read". */
export const SPY_OFFSET = 140;

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** Scrolls to an element on this page, updates the URL hash and moves focus there (like a skip link). */
export function goToAnchor(id: string): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  // focus first (without scrolling): a focus change during a smooth scroll can cancel it
  el.focus({ preventScroll: true });
  const smooth = !prefersReducedMotion();
  const startY = window.scrollY;
  el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  if (smooth) {
    // some embedded browsers ignore smooth scrolling: jump if nothing moved
    window.setTimeout(() => {
      // where block "start" lands: the page's scroll-padding plus the element's scroll-margin
      const px = (v: string) => Number.parseFloat(v) || 0;
      const landing = px(getComputedStyle(document.documentElement).scrollPaddingTop) + px(getComputedStyle(el).scrollMarginTop);
      if (window.scrollY === startY && Math.abs(el.getBoundingClientRect().top - landing) > 2) el.scrollIntoView({ behavior: "auto", block: "start" });
    }, 300);
  }
  // keep react-router's history entry (state) and only swap the fragment
  window.history.replaceState(window.history.state, "", `#${id}`);
  return true;
}

/**
 * <a href="#id"> that scrolls in place; falls back to the browser when the target is missing.
 * `onNavigate` runs first (e.g. closing a menu that changes the layout), the scroll right after.
 */
export function AnchorLink(props: { to: string; children: ReactNode; className?: string; onNavigate?: () => void; "aria-current"?: "location" | undefined; title?: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!document.getElementById(props.to)) return;
    e.preventDefault();
    props.onNavigate?.();
    // after React has committed the onNavigate update (a timeout also runs in background tabs, unlike rAF)
    window.setTimeout(() => goToAnchor(props.to), 0);
  };
  return (
    <a href={`#${props.to}`} onClick={onClick} className={props.className} aria-current={props["aria-current"]} title={props.title}>
      {props.children}
    </a>
  );
}

/** Id of the section being read (scroll position), re-evaluated on scroll and resize. */
export function useScrollSpy(ids: readonly string[], offset = SPY_OFFSET): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join(",");
  useEffect(() => {
    const list = key ? key.split(",") : [];
    let frame = 0;
    const measure = () => {
      frame = 0;
      const tops = list.map((id) => document.getElementById(id)?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY);
      const doc = document.documentElement;
      const atBottom = window.innerHeight + window.scrollY >= doc.scrollHeight - 4 && window.scrollY > 0;
      const i = pickActive(tops, offset, atBottom);
      setActive(list[i] ?? null);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [key, offset]);
  return active;
}

/** One numbered chapter of the page. Focusable (tabIndex -1) so anchor links can move focus to it. */
export function LearnSection(props: { id: string; index: number; eyebrow: string; title: ReactNode; lead?: ReactNode; children: ReactNode; className?: string }) {
  const titleId = `${props.id}-title`;
  return (
    <section id={props.id} tabIndex={-1} aria-labelledby={titleId} className={cx("scroll-mt-12 focus:outline-none lg:scroll-mt-2", props.className)}>
      <div className="eyebrow !text-accent-text">
        <span className="tnum">{String(props.index + 1).padStart(2, "0")}</span> · {props.eyebrow}
      </div>
      <h2 id={titleId} className="mt-2 text-[24px] leading-tight font-semibold tracking-[-0.02em] text-ink sm:text-[30px]">
        {props.title}
      </h2>
      {props.lead && <div className="mt-3 max-w-2xl text-[15.5px] leading-relaxed text-ink-2 sm:text-[16.5px]">{props.lead}</div>}
      <div className="mt-8">{props.children}</div>
    </section>
  );
}

/** Body copy block with comfortable measure. */
export function Prose(props: { children: ReactNode; className?: string }) {
  return <div className={cx("max-w-2xl space-y-4 text-[15px] leading-relaxed text-ink-2", props.className)}>{props.children}</div>;
}

/** Diagram frame: card with a caption under the drawing. */
export function Figure(props: { children: ReactNode; caption?: ReactNode; className?: string; bodyClassName?: string; label?: string }) {
  return (
    <figure className={cx("min-w-0 rounded-card border border-line bg-surface shadow-card", props.className)} aria-label={props.label}>
      <div className={cx("p-4 sm:p-6", props.bodyClassName)}>{props.children}</div>
      {props.caption && <figcaption className="border-t border-line px-4 py-3 text-[12.5px] leading-relaxed text-muted sm:px-6">{props.caption}</figcaption>}
    </figure>
  );
}

/** A box in an HTML flow diagram, optionally tinted with a fixed series colour. */
export function FlowNode(props: { title: ReactNode; children?: ReactNode; series?: SeriesKey; icon?: ReactNode; className?: string; tone?: "default" | "muted" | "accent" }) {
  const s = props.series ? SERIES_CLASS[props.series] : null;
  const tone = props.tone === "muted" ? "border-line bg-surface-2" : props.tone === "accent" ? "border-accent/30 bg-accent-soft" : "border-line-strong bg-surface";
  return (
    <div className={cx("min-w-0 rounded-control border p-3", s ? cx(s.soft, s.border) : tone, props.className)}>
      <div className={cx("flex items-center gap-2 text-[13.5px] font-semibold", s ? s.text : "text-ink")}>
        {props.icon}
        {s && !props.icon && <span className={cx("size-2 shrink-0 rounded-full", s.bg)} aria-hidden />}
        <span className="min-w-0">{props.title}</span>
      </div>
      {props.children && <div className="mt-1 text-[12.5px] leading-snug text-ink-2">{props.children}</div>}
    </div>
  );
}

/**
 * Connector between flow nodes: points down on phones and right from `sm` (or always down when
 * `vertical`). A short label sits beside it. Decorative: the nodes carry the meaning.
 */
export function FlowArrow(props: { label?: ReactNode; series?: SeriesKey; vertical?: boolean; className?: string }) {
  const stroke = props.series ? `var(--${props.series === "bkrn" ? "backstop" : props.series})` : "var(--line-strong)";
  return (
    <div className={cx("flex shrink-0 items-center justify-center gap-1.5 text-[11.5px] font-medium text-ink-2", props.vertical ? "flex-row py-1" : "flex-row py-1 sm:flex-col sm:px-1 sm:py-0", props.className)}>
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden className={cx("shrink-0", props.vertical ? "rotate-90" : "rotate-90 sm:rotate-0")}>
        <path d="M3 12h16m-5-5 5 5-5 5" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {props.label && <span className="text-center leading-tight">{props.label}</span>}
    </div>
  );
}

/** Small coloured dot + text, used in legends inside sections. */
export function Swatch(props: { series: SeriesKey; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5", props.className)}>
      <span className={cx("inline-block size-2.5 shrink-0 rounded-[3px]", SERIES_CLASS[props.series].bg)} aria-hidden />
      {props.children}
    </span>
  );
}
