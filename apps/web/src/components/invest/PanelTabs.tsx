// Tabs for the invest panel that keep every panel mounted (hidden when inactive), so a transaction
// list in flight keeps its state when the reader looks at the other tab. Same keyboard model as the
// shared Tabs: arrow keys, Home and End.
import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { cx } from "../ui";

export interface PanelTab<T extends string> {
  id: T;
  label: ReactNode;
  badge?: ReactNode;
  content: ReactNode;
}

export function PanelTabs<T extends string>(props: { items: Array<PanelTab<T>>; value: T; onChange: (id: T) => void; ariaLabel: string; className?: string }) {
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const idx = props.items.findIndex((t) => t.id === props.value);
    const n = props.items.length;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (idx + 1) % n;
    else if (e.key === "ArrowLeft") next = (idx - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next === null) return;
    e.preventDefault();
    const t = props.items[next];
    if (!t) return;
    props.onChange(t.id);
    refs.current[next]?.focus();
  };
  return (
    <div className={props.className}>
      <div role="tablist" aria-label={props.ariaLabel} className="scroll-x no-scrollbar flex gap-1 border-b border-line">
        {props.items.map((t, i) => {
          const on = t.id === props.value;
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
              onClick={() => props.onChange(t.id)}
              onKeyDown={onKey}
              className={cx(
                "-mb-px inline-flex h-11 items-center gap-2 border-b-2 px-3 text-[14px] font-medium whitespace-nowrap transition-colors duration-150",
                on ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink",
              )}
            >
              {t.label}
              {t.badge}
            </button>
          );
        })}
      </div>
      {props.items.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={t.id !== props.value}
          tabIndex={0}
          className="pt-5 focus-visible:outline-offset-4"
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}
