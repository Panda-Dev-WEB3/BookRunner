// Table of contents for the How it works page. Desktop: a sticky side column with the section being
// read highlighted. Phones and tablets: a sticky bar under the header that names the current section
// and expands into the full list.
import { useEffect, useId, useRef, useState } from "react";
import { cx } from "../cx";
import { IconChevronDown } from "../icons";
import { AnchorLink } from "./parts";
import { LEARN_SECTIONS, sectionPosition } from "./sections";

export function LearnTocDesktop(props: { activeId: string | null }) {
  const pos = sectionPosition(props.activeId);
  return (
    <nav aria-label="On this page" className="sticky top-24 hidden max-h-[calc(100dvh-7rem)] overflow-y-auto pb-6 lg:block">
      <div className="eyebrow mb-3">On this page</div>
      <ol className="relative space-y-0.5 border-l border-line">
        {LEARN_SECTIONS.map((s, i) => {
          const on = s.id === props.activeId;
          return (
            <li key={s.id}>
              <AnchorLink
                to={s.id}
                aria-current={on ? "location" : undefined}
                className={cx(
                  "-ml-px flex items-baseline gap-2.5 border-l-2 py-1.5 pr-2 pl-3.5 text-[13.5px] transition-colors duration-150",
                  on ? "border-accent font-semibold text-ink" : "border-transparent text-ink-2 hover:border-line-strong hover:text-ink",
                )}
              >
                <span className={cx("tnum w-5 shrink-0 text-[11.5px]", on ? "text-accent-text" : "text-muted")}>{String(i + 1).padStart(2, "0")}</span>
                <span>{s.label}</span>
              </AnchorLink>
            </li>
          );
        })}
      </ol>
      {pos && (
        <div className="mt-5 pl-3.5">
          <div className="h-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
            <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${((pos.index + 1) / LEARN_SECTIONS.length) * 100}%` }} />
          </div>
          <div className="tnum mt-1.5 text-[11.5px] text-muted">
            Section {pos.index + 1} of {LEARN_SECTIONS.length}
          </div>
        </div>
      )}
    </nav>
  );
}

export function LearnTocMobile(props: { activeId: string | null }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pos = sectionPosition(props.activeId);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <div ref={box} className="sticky top-16 z-30 -mx-4 border-b border-line bg-surface/95 backdrop-blur-md supports-[backdrop-filter]:bg-surface/85 sm:-mx-6 lg:hidden">
      <nav aria-label="On this page">
        <button
          ref={btn}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="flex h-12 w-full items-center gap-3 px-4 text-left sm:px-6"
        >
          <span className="eyebrow shrink-0">On this page</span>
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">
            {pos ? (
              <>
                <span className="tnum mr-1.5 text-muted">{String(pos.index + 1).padStart(2, "0")}</span>
                {pos.label}
              </>
            ) : (
              "Sections"
            )}
          </span>
          <IconChevronDown size={18} className={cx("shrink-0 text-muted transition-transform duration-200", open && "rotate-180")} />
        </button>
        {pos && (
          <div className="h-0.5 bg-surface-3" aria-hidden>
            <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${((pos.index + 1) / LEARN_SECTIONS.length) * 100}%` }} />
          </div>
        )}
        <ol id={panelId} hidden={!open} className="fade-in max-h-[60dvh] overflow-y-auto border-t border-line px-2 py-2 sm:px-4">
          {LEARN_SECTIONS.map((s, i) => {
            const on = s.id === props.activeId;
            return (
              <li key={s.id}>
                <AnchorLink
                  to={s.id}
                  onNavigate={() => setOpen(false)}
                  aria-current={on ? "location" : undefined}
                  className={cx("flex items-baseline gap-3 rounded-control px-3 py-2.5 text-[14px]", on ? "bg-accent-soft font-semibold text-ink" : "text-ink-2 hover:bg-surface-2")}
                >
                  <span className={cx("tnum w-5 shrink-0 text-[12px]", on ? "text-accent-text" : "text-muted")}>{String(i + 1).padStart(2, "0")}</span>
                  {s.label}
                </AnchorLink>
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}
