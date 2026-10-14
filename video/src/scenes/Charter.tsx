import { Easing, interpolateColors, useCurrentFrame } from "remotion";
import { COPY } from "../copy";
import { FONT } from "../fonts";
import { BASE, C, type Format } from "../theme";
import { withAlpha } from "../ui/color";
import { Node } from "../ui/Node";
import { contentBox } from "../ui/Stage";
import { Body, Headline } from "../ui/Text";
import { ramp, rise, stagger } from "../ui/motion";

const T = COPY.charter;
/** Scene-local frames: fields tick in, the committee appears, the card slides over, seats vote, stamp, caption. */
const AT = {
  fields: 30,
  committee: 170,
  slide: [200, 260],
  arrow: [235, 265],
  /** The model jury posts its verdict, then two of the three bonded members vote (the 2-of-3 threshold). */
  verdict: 266,
  votes: [284, 296],
  threshold: 300,
  stamp: 320,
  caption: 360,
} as const;

type Layout = {
  /** Card above the committee (true) or beside it. */
  stacked: boolean;
  cardW: number;
  comW: number;
  /** Space between card and committee (the arrow sits in it). */
  gap: number;
  /** Field grid columns inside the card. */
  cols: number;
  /** Field font size (px). */
  field: number;
  stamp: number;
  seat: number;
  /** Stacked only: how far the card travels down to the committee. */
  lead: number;
};
const LAYOUT: Record<Format, Layout> = {
  landscape: { stacked: false, cardW: 640, comW: 580, gap: 140, cols: 1, field: 30, stamp: 180, seat: 46, lead: 0 },
  square: { stacked: true, cardW: 900, comW: 900, gap: 64, cols: 2, field: 28, stamp: 164, seat: 40, lead: 56 },
  portrait: { stacked: true, cardW: 900, comW: 900, gap: 120, cols: 1, field: 40, stamp: 210, seat: 58, lead: 120 },
};

/** Checkbox whose tick draws in as `p` goes 0 -> 1. */
const Tick: React.FC<{ size: number; p: number }> = ({ size: s, p }) => (
  <svg width={s} height={s} style={{ flex: "none", overflow: "visible" }}>
    <rect
      x={1.5}
      y={1.5}
      width={s - 3}
      height={s - 3}
      rx={s * 0.22}
      fill={withAlpha(C.blue, 0.25 * p)}
      stroke={interpolateColors(p, [0, 1], [C.line, C.light])}
      strokeWidth={2.5}
    />
    <path
      d={`M ${s * 0.25} ${s * 0.52} L ${s * 0.43} ${s * 0.7} L ${s * 0.76} ${s * 0.32}`}
      fill="none"
      stroke={C.cream}
      strokeWidth={Math.max(3, s * 0.11)}
      strokeLinecap="round"
      strokeLinejoin="round"
      pathLength={1}
      strokeDasharray={1}
      strokeDashoffset={1 - p}
    />
  </svg>
);

/**
 * Model-jury seat: a chip glyph that posts a verdict (a document) as `verdict` goes 0 -> 1. The jury recommends; it
 * does not vote, so it is never lit like a bonded seat.
 */
const JurySeat: React.FC<{ size: number; verdict: number }> = ({ size: s, verdict }) => {
  const stroke = interpolateColors(verdict, [0, 1], [C.muted, C.cream]);
  const pins = [0.35, 0.5, 0.65];
  // Verdict document: bottom-right of the chip, rising into place.
  const dw = s * 0.5;
  const dh = s * 0.62;
  const dx = s * 0.98;
  const dy = s * 0.34 + (1 - verdict) * s * 0.15;
  const fold = dw * 0.32;
  return (
    <svg width={s * 1.55} height={s} style={{ flex: "none", overflow: "visible" }}>
      <rect x={s * 0.2} y={s * 0.2} width={s * 0.6} height={s * 0.6} rx={s * 0.1} fill="none" stroke={stroke} strokeWidth={3} />
      <rect x={s * 0.39} y={s * 0.39} width={s * 0.22} height={s * 0.22} rx={s * 0.03} fill={stroke} />
      {pins.map((k) => (
        <g key={k} stroke={stroke} strokeWidth={3} strokeLinecap="round">
          <line x1={s * k} y1={s * 0.05} x2={s * k} y2={s * 0.17} />
          <line x1={s * k} y1={s * 0.83} x2={s * k} y2={s * 0.95} />
          <line x1={s * 0.05} y1={s * k} x2={s * 0.17} y2={s * k} />
          <line x1={s * 0.83} y1={s * k} x2={s * 0.95} y2={s * k} />
        </g>
      ))}
      <g opacity={verdict} stroke={C.cream} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round">
        <path
          d={`M ${dx} ${dy} H ${dx + dw - fold} L ${dx + dw} ${dy + fold} V ${dy + dh} H ${dx} Z`}
          fill={C.panel}
        />
        <path d={`M ${dx + dw - fold} ${dy} V ${dy + fold} H ${dx + dw}`} fill="none" />
        <line x1={dx + dw * 0.22} x2={dx + dw * 0.78} y1={dy + dh * 0.55} y2={dy + dh * 0.55} />
        <line x1={dx + dw * 0.22} x2={dx + dw * 0.62} y1={dy + dh * 0.76} y2={dy + dh * 0.76} />
      </g>
    </svg>
  );
};

/** Bonded member seat: a ring with a bond dot. Lit (`on` 0 -> 1) when it votes. */
const BondedSeat: React.FC<{ size: number; on: number }> = ({ size: s, on }) => (
  <svg width={s} height={s} style={{ flex: "none" }}>
    <circle cx={s / 2} cy={s / 2} r={s * 0.4} fill={withAlpha(C.blue, on)} stroke={interpolateColors(on, [0, 1], [C.muted, C.light])} strokeWidth={3} />
    <circle cx={s / 2} cy={s / 2} r={s * 0.12} fill={interpolateColors(on, [0, 1], [C.muted, C.cream])} />
  </svg>
);

/** Circular stamp: blue ring draws on (`p`), then the word lands; slight tilt and a settle from 1.2x. */
const Stamp: React.FC<{ size: number; frame: number; label: string; style: React.CSSProperties }> = ({ size, frame, label, style }) => {
  const draw = ramp(frame, AT.stamp, AT.stamp + 22, Easing.out(Easing.cubic));
  const word = ramp(frame, AT.stamp + 10, AT.stamp + 24);
  const settle = ramp(frame, AT.stamp, AT.stamp + 14, Easing.out(Easing.back(1.6)));
  if (frame < AT.stamp) return null;
  const c = size / 2;
  return (
    <div style={{ position: "absolute", width: size, height: size, transform: `rotate(-12deg) scale(${1.2 - 0.2 * settle})`, ...style }}>
      <svg width={size} height={size} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <circle
          cx={c}
          cy={c}
          r={c - 5}
          fill={withAlpha(C.blue, 0.14 * word)}
          stroke={C.blue}
          strokeWidth={8}
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - draw}
          transform={`rotate(-90 ${c} ${c})`}
        />
        <circle cx={c} cy={c} r={c - 15} fill="none" stroke={C.blue} strokeWidth={2} opacity={word} />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: FONT.serif,
          fontWeight: 600,
          fontSize: Math.max(26, Math.round(size * 0.145)),
          color: C.cream,
          opacity: word,
        }}
      >
        {label}
      </div>
    </div>
  );
};

/** Arrow from card to committee, drawn on with `p`; horizontal or pointing down. */
const Arrow: React.FC<{ length: number; down: boolean; p: number }> = ({ length: n, down, p }) => {
  const w = down ? 40 : n;
  const h = down ? n : 40;
  const d = down
    ? `M 20 14 V ${n - 14} M 8 ${n - 28} L 20 ${n - 14} L 32 ${n - 28}`
    : `M 14 20 H ${n - 14} M ${n - 28} 8 L ${n - 14} 20 L ${n - 28} 32`;
  return (
    <svg width={w} height={h} style={{ flex: "none" }}>
      <path d={d} fill="none" stroke={C.light} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - p} />
    </svg>
  );
};

/** Scene 4 (450 frames): a sponsor's charter is filled in, goes to the Risk Committee, and is approved. */
export const Charter: React.FC<{ format: Format }> = ({ format }) => {
  const frame = useCurrentFrame();
  const L = LAYOUT[format];
  const base = BASE[format];
  const pad = Math.round(base * (L.stacked ? 0.55 : 0.8));
  const slide = ramp(frame, AT.slide[0], AT.slide[1], Easing.inOut(Easing.cubic));
  // Landscape: the card starts flush with the title's left edge and slides right until the pair is centred.
  const dx = L.stacked ? 0 : (contentBox(format).W - (L.cardW + L.gap + L.comW)) / 2;
  const cardMove = L.stacked ? `translateY(${-L.lead * (1 - slide)}px)` : `translateX(${-dx * (1 - slide)}px)`;
  const committee = rise(frame, AT.committee);
  // Bonded seat i (0-2) lights when it votes; only the first two do, which is enough to approve.
  const vote = (i: number) => (i < AT.votes.length ? ramp(frame, AT.votes[i], AT.votes[i] + 8) : 0);
  const nodePadY = Math.round(base * 0.5);
  const nodePadX = Math.round(base * 0.65);

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      <Headline format={format} style={{ textWrap: "balance", ...rise(frame, 0) }}>
        {T.title}
      </Headline>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: L.stacked ? "column" : "row",
          alignItems: "center",
          justifyContent: "center",
          paddingTop: L.lead,
        }}
      >
        {/* The charter card. */}
        <div
          style={{
            position: "relative",
            boxSizing: "border-box",
            width: L.cardW,
            background: C.panel,
            border: `2px solid ${C.cream}`,
            borderRadius: 18,
            padding: pad,
            fontFamily: FONT.sans,
            transform: cardMove,
            opacity: rise(frame, 6).opacity,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: Math.round(base * 0.75), lineHeight: 1.25, color: C.cream }}>{T.sponsor}</div>
          <div style={{ height: 1.5, background: C.line, margin: `${Math.round(base * 0.35)}px 0 ${Math.round(base * 0.45)}px` }} />
          <div
            style={{
              position: "relative",
              display: "grid",
              gridTemplateColumns: `repeat(${L.cols}, 1fr)`,
              columnGap: 24,
              rowGap: Math.round(L.field * 0.42),
              paddingRight: L.stamp + 16,
            }}
          >
            {T.fields.map((f, i) => {
              const t0 = AT.fields + stagger(i, 10);
              return (
                <div key={f} style={{ display: "flex", alignItems: "center", gap: Math.round(L.field * 0.45), ...rise(frame, t0) }}>
                  <Tick size={Math.round(L.field * 1.05)} p={ramp(frame, t0 + 4, t0 + 14, Easing.out(Easing.quad))} />
                  <span style={{ fontWeight: 500, fontSize: L.field, lineHeight: 1.3, color: C.cream }}>{f}</span>
                </div>
              );
            })}
            {/* Centred on the field list, in the column kept free for it (never over the header rule). */}
            <Stamp size={L.stamp} frame={frame} label={T.stamp} style={{ right: 0, top: `calc(50% - ${L.stamp / 2}px)` }} />
          </div>
        </div>

        <div style={{ opacity: frame >= AT.arrow[0] ? 1 : 0 }}>
          <Arrow length={L.gap} down={L.stacked} p={ramp(frame, AT.arrow[0], AT.arrow[1], Easing.out(Easing.quad))} />
        </div>

        {/* The Risk Committee: title, note, and its four seats (model jury + three bonded members). */}
        <div style={{ position: "relative", width: L.comW, ...committee }}>
          <Node format={format} title={T.committee} note={T.committeeNote} style={{ width: "100%", textWrap: "balance", paddingBottom: nodePadY * 2 + L.seat + 6 }} />
          <div
            style={{
              position: "absolute",
              left: nodePadX,
              bottom: nodePadY + 4,
              display: "flex",
              alignItems: "center",
              gap: Math.round(L.seat * 0.3),
            }}
          >
            <JurySeat size={L.seat} verdict={ramp(frame, AT.verdict, AT.verdict + 12, Easing.out(Easing.quad))} />
            <svg width={L.seat * 0.5} height={L.seat} style={{ flex: "none" }}>
              <path
                d={`M ${L.seat * 0.25} ${L.seat * 0.32} V ${L.seat * 0.68} M ${L.seat * 0.07} ${L.seat / 2} H ${L.seat * 0.43}`}
                stroke={C.muted}
                strokeWidth={3}
                strokeLinecap="round"
              />
            </svg>
            {[0, 1, 2].map((i) => (
              <BondedSeat key={i} size={L.seat} on={vote(i)} />
            ))}
            <div
              style={{
                marginLeft: Math.round(L.seat * 0.2),
                fontFamily: FONT.sans,
                fontWeight: 500,
                fontSize: Math.max(26, Math.round(base * 0.55)),
                color: C.light,
                whiteSpace: "nowrap",
                opacity: ramp(frame, AT.threshold, AT.threshold + 14),
              }}
            >
              {T.threshold}
            </div>
          </div>
        </div>
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
        {T.approved}
      </Body>
    </div>
  );
};
