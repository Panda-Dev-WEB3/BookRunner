import { Easing, interpolateColors, useCurrentFrame } from "remotion";
import { COPY } from "../copy";
import { FONT } from "../fonts";
import { BASE, C, type Format } from "../theme";
import { withAlpha } from "../ui/color";
import { Body, Headline } from "../ui/Text";
import { ramp, rise, stagger } from "../ui/motion";

const T = COPY.mandate;
/** Scene-local frames. `push` is the window in which the quotes are driven out of the band. */
const AT = { panel: 15, lines: 30, chips: 60, push: [360, 420], cancel: [425, 450], caption: 430 } as const;
/** Frames of quote history shown across the chart. */
const HISTORY = 120;

type Layout = {
  /** Chips in columns either side of the agent (true) or in rows above and below it. */
  side: boolean;
  panelW: number;
  chartH: number;
  /** Chip font size (px). */
  chip: number;
  gap: number;
};
const LAYOUT: Record<Format, Layout> = {
  landscape: { side: true, panelW: 900, chartH: 330, chip: 30, gap: 56 },
  square: { side: false, panelW: 900, chartH: 230, chip: 29, gap: 22 },
  portrait: { side: false, panelW: 900, chartH: 560, chip: 34, gap: 40 },
};

/*
 * Quote model, in units of the band half-height (band = [-1, 1]). The mid wobbles on three incommensurate sines
 * (|mid| <= 0.5), the half-spread is 0.3, so before the push both quotes stay inside the band (|quote| <= 0.8).
 * From AT.push[0] an eased drift of up to 1.3 drives both quotes up and out.
 */
const SPREAD = 0.3;
const mid = (f: number): number => 0.3 * Math.sin(f / 21) + 0.13 * Math.sin(f / 8.5 + 1.3) + 0.07 * Math.sin(f / 3.7 + 0.4);
const drift = (f: number): number => 1.3 * Easing.in(Easing.quad)(Math.min(1, Math.max(0, (f - AT.push[0]) / (AT.push[1] - AT.push[0]))));
const ask = (f: number): number => mid(f) + SPREAD + drift(f);
const bid = (f: number): number => mid(f) - SPREAD + drift(f);

/** First frame at which the ask leaves the band: everything that reacts to the breach keys off it. */
const BREACH = (() => {
  for (let f = AT.push[0]; f <= AT.push[1]; f++) if (ask(f) > 1) return f;
  return AT.push[1];
})();

/** Key glyph that snaps in two at `brk` (0 -> 1) and turns red. */
const Key: React.FC<{ size: number; brk: number }> = ({ size, brk }) => {
  const color = interpolateColors(brk, [0, 0.3], [C.light, C.loss]);
  const w = size * 2;
  const h = size;
  const y = h / 2;
  const cut = w * 0.56;
  const common = { fill: "none", stroke: color, strokeWidth: Math.max(3, size * 0.11), strokeLinecap: "round" as const };
  return (
    <svg width={w} height={h} style={{ flex: "none", overflow: "visible" }}>
      <g transform={`translate(${-6 * brk} ${2 * brk}) rotate(${-14 * brk} ${cut} ${y})`}>
        <circle cx={h * 0.36} cy={y} r={h * 0.26} {...common} />
        <line x1={h * 0.62} y1={y} x2={cut} y2={y} {...common} />
      </g>
      <g transform={`translate(${10 * brk} ${8 * brk}) rotate(${20 * brk} ${cut} ${y})`} opacity={1 - 0.25 * brk}>
        <line x1={cut} y1={y} x2={w * 0.94} y2={y} {...common} />
        <line x1={w * 0.8} y1={y} x2={w * 0.8} y2={y + h * 0.26} {...common} />
        <line x1={w * 0.92} y1={y} x2={w * 0.92} y2={y + h * 0.2} {...common} />
      </g>
    </svg>
  );
};

/** The agent's quote chart: band (the mandate), bid/ask history, labels at the live end. */
const Chart: React.FC<{ format: Format; w: number; h: number; frame: number }> = ({ format, w, h, frame }) => {
  const hb = h * 0.2; // band half-height in px; the chart spans +-2.5 band half-heights
  const y = (v: number) => h / 2 - v * hb;
  const labelSize = Math.max(26, Math.round(BASE[format] * 0.55));
  const xEnd = w - labelSize * 2.6; // room for the "Bid"/"Ask" labels at the live end
  const now = Math.min(frame, AT.push[1]); // quotes stop updating once cancelled
  const path = (q: (f: number) => number) =>
    Array.from({ length: HISTORY + 1 }, (_, k) => `${k === 0 ? "M" : "L"} ${((k / HISTORY) * xEnd).toFixed(1)} ${y(q(now - HISTORY + k)).toFixed(1)}`).join(" ");
  const askD = path(ask);
  const bidD = path(bid);
  const show = ramp(frame, AT.lines, AT.lines + 20);
  const cancelled = ramp(frame, AT.cancel[0], AT.cancel[1]);
  const lineOpacity = show * (1 - 0.65 * cancelled); // cancelled quotes stay as a faint trace
  // Flash: two quick red pulses, then the band stays red-tinted.
  const t = frame - BREACH;
  const flash = t < 0 ? 0 : t < 30 ? 0.22 + 0.28 * (0.5 + 0.5 * Math.cos((t / 15) * 2 * Math.PI)) : 0.22;
  const red = ramp(frame, BREACH, BREACH + 4);
  const edge = interpolateColors(red, [0, 1], [withAlpha(C.light, 0.6), C.loss]);
  const sw = format === "portrait" ? 5 : 4;
  // Label centres follow the quotes but never sit closer than one label height apart.
  const sep = Math.max(0, labelSize * 1.15 - (y(bid(now)) - y(ask(now)))) / 2;
  const fit = (cy: number) => Math.min(h - labelSize * 0.6, Math.max(labelSize * 0.7, cy)); // keep labels inside the chart
  const label = (text: string, cy: number, color: string) => (
    <text x={xEnd + 16} y={fit(cy) + labelSize * 0.35} fill={color} fontFamily={FONT.sans} fontWeight={600} fontSize={labelSize} opacity={lineOpacity}>
      {text}
    </text>
  );
  return (
    <svg width={w} height={h} style={{ display: "block", overflow: "hidden" }}>
      <defs>
        <clipPath id="mandate-in">
          <rect x={0} y={y(1)} width={w} height={2 * hb} />
        </clipPath>
        <clipPath id="mandate-out">
          <rect x={0} y={0} width={w} height={y(1)} />
          <rect x={0} y={y(-1)} width={w} height={h - y(-1)} />
        </clipPath>
      </defs>
      <rect x={0} y={y(1)} width={xEnd} height={2 * hb} fill={t < 0 ? withAlpha(C.light, 0.1) : withAlpha(C.loss, flash)} />
      <line x1={0} x2={xEnd} y1={y(1)} y2={y(1)} stroke={edge} strokeWidth={2} strokeDasharray="10 8" />
      <line x1={0} x2={xEnd} y1={y(-1)} y2={y(-1)} stroke={edge} strokeWidth={2} strokeDasharray="10 8" />
      <text
        x={0}
        y={y(-1) + labelSize * 1.25}
        fill={interpolateColors(red, [0, 1], [C.light, C.cream])}
        fontFamily={FONT.sans}
        fontWeight={500}
        fontSize={labelSize}
        letterSpacing="0.16em"
        opacity={0.85}
      >
        {T.band.toUpperCase()}
      </text>
      <g fill="none" strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round" opacity={lineOpacity}>
        <g clipPath="url(#mandate-in)">
          <path d={askD} stroke={C.cream} />
          <path d={bidD} stroke={C.light} />
        </g>
        <g clipPath="url(#mandate-out)">
          <path d={askD} stroke={C.loss} />
          <path d={bidD} stroke={C.loss} />
        </g>
      </g>
      <circle cx={xEnd} cy={y(ask(now))} r={sw * 1.6} fill={ask(now) > 1 ? C.loss : C.cream} opacity={lineOpacity} />
      <circle cx={xEnd} cy={y(bid(now))} r={sw * 1.6} fill={bid(now) > 1 ? C.loss : C.light} opacity={lineOpacity} />
      {label(T.ask, y(ask(now)) - sep, C.cream)}
      {label(T.bid, y(bid(now)) + sep, C.light)}
    </svg>
  );
};

/** Pill naming one mandate limit; turns red on breach. */
const Chip: React.FC<{ text: string; size: number; enter: number; red: number; frame: number }> = ({ text, size, enter, red, frame }) => (
  <div
    style={{
      boxSizing: "border-box",
      padding: `${Math.round(size * 0.42)}px ${Math.round(size * 0.8)}px`,
      borderRadius: 999,
      border: `2px solid ${interpolateColors(red, [0, 1], [C.line, C.loss])}`,
      background: interpolateColors(red, [0, 1], [withAlpha(C.panel, 0.85), withAlpha(C.loss, 0.25)]),
      fontFamily: FONT.sans,
      fontWeight: 500,
      fontSize: size,
      lineHeight: 1.2,
      color: C.cream,
      whiteSpace: "nowrap",
      ...rise(frame, enter),
    }}
  >
    {text}
  </div>
);

/** Scene 5 (600 frames): an agent quotes inside its mandate; when the quotes leave the band, the limits trip. */
export const Mandate: React.FC<{ format: Format }> = ({ format }) => {
  const frame = useCurrentFrame();
  const L = LAYOUT[format];
  const base = BASE[format];
  const panelPad = Math.round(base * (L.side ? 0.7 : 0.55));
  const chip = (i: number) => (
    <Chip
      key={T.limits[i]}
      text={T.limits[i]}
      size={L.chip}
      enter={AT.chips + stagger(i, 12)}
      red={ramp(frame, BREACH + 4 + stagger(i, 3), BREACH + 10 + stagger(i, 3))}
      frame={frame}
    />
  );
  const split = L.side ? 3 : 2; // chips before the panel (left column / top row)
  const first = T.limits.slice(0, split).map((_, i) => chip(i));
  const rest = T.limits.slice(split).map((_, i) => chip(split + i));
  const group = (items: React.ReactNode[], align: "flex-start" | "flex-end") => (
    <div
      style={{
        display: "flex",
        flexDirection: L.side ? "column" : "row",
        flexWrap: L.side ? "nowrap" : "wrap",
        justifyContent: "center",
        alignItems: L.side ? align : "center",
        gap: L.side ? 28 : 18,
        flex: L.side ? 1 : undefined,
      }}
    >
      {items}
    </div>
  );
  const titleSize = Math.round(base * 0.75);

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      <Headline format={format} style={{ textWrap: "balance", ...rise(frame, 0) }}>
        {T.title}
      </Headline>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: L.side ? "row" : "column",
          alignItems: "center",
          justifyContent: "center",
          gap: L.gap,
        }}
      >
        {group(first, "flex-end")}
        <div
          style={{
            boxSizing: "border-box",
            flex: "none",
            width: L.panelW,
            background: C.panel,
            border: `1.5px solid ${C.line}`,
            borderRadius: 18,
            padding: panelPad,
            ...rise(frame, AT.panel),
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: Math.round(base * 0.35) }}>
            <Key size={Math.round(titleSize * 1.15)} brk={ramp(frame, BREACH + 6, BREACH + 20, Easing.out(Easing.back(1.4)))} />
            <div style={{ fontFamily: FONT.sans, fontWeight: 600, fontSize: titleSize, lineHeight: 1.25, color: C.cream }}>{T.agent}</div>
          </div>
          <Chart format={format} w={L.panelW - 2 * panelPad - 3} h={L.chartH} frame={frame} />
        </div>
        {group(rest, "flex-start")}
      </div>
      <Body
        format={format}
        size={Math.round(base * 0.8)}
        style={{
          color: C.light,
          textAlign: "center",
          textWrap: "balance",
          marginTop: Math.round(base * 0.6),
          opacity: ramp(frame, AT.caption, AT.caption + 20),
        }}
      >
        {T.breach}
      </Body>
    </div>
  );
};
