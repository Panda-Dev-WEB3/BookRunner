// The fixed colour coding used by every chart and diagram (tokens in styles.css, validated for
// colour-vision deficiency in both modes). Never repurpose a series colour for anything else.
//   Senior = blue · Junior = amber · Backstop / BKRN = violet · fee flow / profit = green · losses = red

export type SeriesKey = "senior" | "junior" | "backstop" | "bkrn" | "fee" | "loss";

/** CSS colour values for SVG fill/stroke and chart libraries (follow the theme automatically). */
export const SERIES: Readonly<Record<SeriesKey, string>> = {
  senior: "var(--senior)",
  junior: "var(--junior)",
  backstop: "var(--backstop)",
  bkrn: "var(--backstop)",
  fee: "var(--fee)",
  loss: "var(--loss)",
};

/** Text-safe (AA) variant of each series colour, for labels on a soft wash of the same hue. */
export const SERIES_INK: Readonly<Record<SeriesKey, string>> = {
  senior: "var(--senior-ink)",
  junior: "var(--junior-ink)",
  backstop: "var(--backstop-ink)",
  bkrn: "var(--backstop-ink)",
  fee: "var(--fee-ink)",
  loss: "var(--loss-ink)",
};

export const SERIES_LABEL: Readonly<Record<SeriesKey, string>> = {
  senior: "Senior",
  junior: "Junior",
  backstop: "Backstop",
  bkrn: "BKRN",
  fee: "Fee flow",
  loss: "Losses",
};

/** Tailwind classes per series (literal strings so Tailwind generates them). */
export const SERIES_CLASS: Readonly<Record<SeriesKey, { bg: string; soft: string; text: string; border: string; ring: string }>> = {
  senior: { bg: "bg-senior", soft: "bg-senior/12", text: "text-senior-ink", border: "border-senior/40", ring: "ring-senior/40" },
  junior: { bg: "bg-junior", soft: "bg-junior/14", text: "text-junior-ink", border: "border-junior/45", ring: "ring-junior/40" },
  backstop: { bg: "bg-backstop", soft: "bg-backstop/12", text: "text-backstop-ink", border: "border-backstop/40", ring: "ring-backstop/40" },
  bkrn: { bg: "bg-backstop", soft: "bg-backstop/12", text: "text-backstop-ink", border: "border-backstop/40", ring: "ring-backstop/40" },
  fee: { bg: "bg-fee", soft: "bg-fee/14", text: "text-fee-ink", border: "border-fee/45", ring: "ring-fee/40" },
  loss: { bg: "bg-loss", soft: "bg-loss/12", text: "text-loss-ink", border: "border-loss/40", ring: "ring-loss/40" },
};
