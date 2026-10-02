// 9. Glossary: every term from lib/glossary.ts, grouped for reading, searchable, and linkable
// (/learn#term-senior). A term reached by a link is briefly highlighted.
import { useEffect, useId, useMemo, useState } from "react";
import { GLOSSARY, type GlossaryId, termAnchor } from "../../lib/glossary";
import { cx } from "../cx";
import { IconClose } from "../icons";
import { CopyButton } from "../ui";
import { filterGroups, glossaryGroups, termFromHash } from "./glossaryGroups";
import { LearnSection, goToAnchor } from "./parts";

const HIGHLIGHT_MS = 4_000;

function Entry(props: { id: GlossaryId; highlighted: boolean; onJump: (id: GlossaryId) => void }) {
  const e = GLOSSARY[props.id];
  const anchor = termAnchor(props.id);
  const link = typeof window === "undefined" ? `/learn#${anchor}` : `${window.location.origin}/learn#${anchor}`;
  return (
    <div
      id={anchor}
      tabIndex={-1}
      className={cx(
        "scroll-mt-12 rounded-control border p-4 transition-[background-color,border-color,box-shadow] duration-200 focus:outline-none lg:scroll-mt-2",
        props.highlighted ? "border-accent bg-accent-soft shadow-raised" : "border-line bg-surface",
      )}
    >
      <dt className="flex items-start justify-between gap-3">
        <span className="text-[15px] font-semibold text-ink">{e.term}</span>
        <CopyButton value={link} label={`Copy a link to ${e.term}`} size={14} className="mt-0.5 shrink-0" />
      </dt>
      <dd className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
        <p>{e.short}</p>
        {e.long && <p className="mt-2">{e.long}</p>}
        {e.related && e.related.length > 0 && (
          <p className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px]">
            <span className="text-muted">See also:</span>
            {e.related.map((r, i) => (
              <span key={r}>
                <a
                  href={`#${termAnchor(r)}`}
                  className="link"
                  onClick={(ev) => {
                    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
                    ev.preventDefault();
                    props.onJump(r);
                  }}
                >
                  {GLOSSARY[r].term}
                </a>
                {i < (e.related?.length ?? 0) - 1 ? <span className="text-muted">,</span> : null}
              </span>
            ))}
          </p>
        )}
      </dd>
    </div>
  );
}

export function GlossarySection(props: { index: number }) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState<GlossaryId | null>(null);
  const groups = useMemo(() => glossaryGroups(), []);
  const shown = useMemo(() => filterGroups(groups, query), [groups, query]);
  const total = groups.reduce((n, g) => n + g.ids.length, 0);
  const count = shown.reduce((n, g) => n + g.ids.length, 0);

  // arriving from a link elsewhere (/learn#term-senior) highlights that term
  useEffect(() => {
    const fromHash = () => {
      const id = termFromHash(window.location.hash);
      if (id) setHighlight(id);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlight]);

  // a "see also" link may point at a term the search hides: clear it, then scroll once it renders
  const jump = (id: GlossaryId) => {
    setQuery("");
    setHighlight(id);
    setTimeout(() => goToAnchor(termAnchor(id)), 0);
  };

  return (
    <LearnSection
      id="glossary"
      index={props.index}
      eyebrow="Glossary"
      title="Every term, in plain words"
      lead="The same definitions you see when you hover or tap a dotted term anywhere in the app. Each one has its own link you can share."
    >
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <label htmlFor={searchId} className="sr-only">
            Search the glossary
          </label>
          <input
            id={searchId}
            type="search"
            className="field !min-h-10 pr-9"
            placeholder="Search terms, for example NAV"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              className="absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-[6px] text-muted hover:bg-surface-2 hover:text-ink"
              onClick={() => setQuery("")}
              aria-label="Clear the search"
            >
              <IconClose size={14} />
            </button>
          )}
        </div>
        <p className="tnum text-[12.5px] text-muted" aria-live="polite">
          {query ? `${count} of ${total} terms match` : `${total} terms`}
        </p>
      </div>
      {shown.length === 0 ? (
        <p className="rounded-control border border-dashed border-line-strong p-5 text-[13.5px] text-ink-2">
          No term matches "{query}". Try a shorter word, or{" "}
          <button type="button" className="link" onClick={() => setQuery("")}>
            show every term
          </button>
          .
        </p>
      ) : (
        <div className="space-y-8">
          {shown.map((g) => (
            <div key={g.id}>
              <h3 className="eyebrow mb-3">{g.title}</h3>
              <dl className="grid gap-3 md:grid-cols-2">
                {g.ids.map((id) => (
                  <Entry key={id} id={id} highlighted={highlight === id} onJump={jump} />
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </LearnSection>
  );
}
