// Sections of the How it works page, in reading order (table of contents + anchors: /learn#simulator).

export interface LearnSectionMeta {
  id: string;
  /** Short label for the table of contents. */
  label: string;
}

export const LEARN_SECTIONS: readonly LearnSectionMeta[] = [
  { id: "problem", label: "The problem" },
  { id: "lifecycle", label: "A book, end to end" },
  { id: "tranches", label: "The two tranches" },
  { id: "simulator", label: "Waterfall simulator" },
  { id: "mark", label: "The mark" },
  { id: "risk", label: "Risk controls" },
  { id: "low-gas", label: "Low gas by design" },
  { id: "bkrn", label: "BKRN" },
  { id: "glossary", label: "Glossary" },
];

/**
 * Scroll spy: the index of the section being read, given each section's top edge relative to the
 * viewport (getBoundingClientRect().top, in reading order). The current section is the last one whose
 * top has passed `offset` (the sticky header height plus some reading room). Before the first section
 * reaches it, the first section counts as current. At the very bottom of the page the last section
 * wins, so a short final section can still be highlighted.
 */
export function pickActive(tops: readonly number[], offset: number, atBottom = false): number {
  if (tops.length === 0) return -1;
  if (atBottom) return tops.length - 1;
  let active = 0;
  tops.forEach((t, i) => {
    if (t - offset <= 0) active = i;
  });
  return active;
}

/** "3 of 9" style progress label for the collapsed mobile table of contents. */
export function sectionPosition(id: string | null): { index: number; label: string } | null {
  const index = LEARN_SECTIONS.findIndex((s) => s.id === id);
  if (index < 0) return null;
  const meta = LEARN_SECTIONS[index];
  return meta ? { index, label: meta.label } : null;
}
