// Inline glossary term: a dotted-underlined button that shows the plain-language definition from
// lib/glossary.ts on hover, keyboard focus or tap (WCAG 1.4.13: dismissible with Escape, hoverable,
// stays while pinned). Screen readers get the definition as the button's description.
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { GLOSSARY, type GlossaryId } from "../lib/glossary";
import { cx } from "./cx";

interface Pos {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
}

const GAP = 8;
const EDGE = 12;
const EST_HEIGHT = 150;

function placeFor(el: HTMLElement): Pos {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(320, vw - EDGE * 2);
  const left = Math.max(EDGE, Math.min(r.left + r.width / 2 - width / 2, vw - EDGE - width));
  const above = r.bottom + GAP + EST_HEIGHT > vh && r.top - GAP - EST_HEIGHT > 0;
  return above ? { bottom: vh - r.top + GAP, left, width } : { top: r.bottom + GAP, left, width };
}

export function Term(props: {
  id: GlossaryId;
  /** Text shown in the sentence (defaults to the glossary's term name). */
  children?: ReactNode;
  className?: string;
}) {
  const entry = GLOSSARY[props.id];
  const descId = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const close = useCallback(() => {
    cancelClose();
    setOpen(false);
    setPinned(false);
  }, []);
  const show = () => {
    cancelClose();
    setOpen(true);
  };
  const scheduleClose = () => {
    if (pinned) return;
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  };

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const update = () => btn.current && setPos(placeFor(btn.current));
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && close();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btn.current?.contains(t) || tip.current?.contains(t)) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, close]);

  useEffect(() => cancelClose, []);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Escape" && open) {
      // keep an enclosing dialog open: Escape dismisses the definition first
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={cx("term", props.className)}
        aria-describedby={descId}
        aria-expanded={open}
        onMouseEnter={show}
        onMouseLeave={scheduleClose}
        onFocus={show}
        onBlur={() => !pinned && setOpen(false)}
        onKeyDown={onKeyDown}
        onClick={() => {
          if (pinned) close();
          else {
            setPinned(true);
            show();
          }
        }}
      >
        {props.children ?? entry.term}
      </button>
      <span id={descId} hidden>
        {`${entry.term}: ${entry.short}`}
      </span>
      {open && pos && (
        <span
          ref={tip}
          aria-hidden
          onMouseEnter={show}
          onMouseLeave={scheduleClose}
          className="fade-in fixed z-[70] block rounded-control border border-line-strong bg-surface p-3 text-left text-[12.5px] leading-[1.5] font-normal tracking-normal text-ink-2 normal-case shadow-pop"
          style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width }}
        >
          <span className="mb-1 block text-[13px] font-semibold text-ink">{entry.term}</span>
          <span className="block">{entry.short}</span>
        </span>
      )}
    </>
  );
}
