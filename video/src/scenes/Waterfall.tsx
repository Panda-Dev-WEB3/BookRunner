import type { CSSProperties } from "react";
import { Easing, interpolateColors, useCurrentFrame } from "remotion";
import { COPY } from "../copy";
import { FONT } from "../fonts";
import { BASE, C, type Format } from "../theme";
import { withAlpha } from "../ui/color";
import { Flow } from "../ui/Flow";
import { contentBox } from "../ui/Stage";
import { Headline, Label } from "../ui/Text";
import { ramp, rise, stagger } from "../ui/motion";

const T = COPY.waterfall;
type Pt = [number, number];
type Rect = { x: number; y: number; w: number; h: number };

/** Fee tiers fill one after another (30–330); losses drain Junior, then Senior, then the Backstop (340–560). */
const FEE_FILL: ReadonlyArray<readonly [number, number]> = [[42, 105], [117, 180], [192, 255], [267, 330]];
const FEE_STREAM_OUT = [335, 355] as const;
const LOSS_DRAIN: ReadonlyArray<readonly [number, number]> = [[352, 410], [422, 480], [492, 555]];
/** How far each loss bar drains: Junior and Senior are used up; the Backstop pays only up to its pool (its rest
 * level sits below the label, so the fill edge never cuts through the text once it stops moving). */
const LOSS_TO = [0, 0, 0.25];
const LOSS_STREAM_OUT = [556, 576] as const;
/** Particle speed (px/s) on every segment, and spacing between particles (px). */
const SPEED = 150;
const SPACING = 17;
/** A segment's stream starts this many frames before the tier it feeds starts to fill or drain. */
const LEAD = 12;

const FEE_COLORS = [C.muted, C.muted, C.light, C.blue];
const LOSS_COLORS = [C.blue, C.light, C.muted];

type Geo = {
  fees: { header: Rect; source: Pt; tiers: Rect[] };
  losses: { header: Rect; inlet: Pt; bars: Rect[] };
  font: number;
};

/**
 * Landscape and square: fee flow (left) and losses (right) side by side, headers aligned, the fee source above its
 * tiers and the loss inlet below its bars. Portrait: the fee column above the loss column.
 */
function geometry(format: Format): Geo {
  const { W } = contentBox(format);
  const p = {
    landscape: { title: 76, tg: 44, colW: 640, colGap: 240, hh: 42, src: 26, srcGap: 64, h: 100, gap: 44, inlet: 110, font: 29 },
    square: { title: 80, tg: 36, colW: 410, colGap: 80, hh: 42, src: 22, srcGap: 56, h: 100, gap: 36, inlet: 100, font: 29 },
    portrait: { title: 93, tg: 50, colW: W, colGap: 0, hh: 50, src: 26, srcGap: 60, h: 112, gap: 40, inlet: 90, font: 35 },
  }[format];
  const x0 = (W - (format === "portrait" ? p.colW : 2 * p.colW + p.colGap)) / 2;
  const x1 = format === "portrait" ? x0 : x0 + p.colW + p.colGap;
  const hy = p.title + p.tg;
  const header = (x: number, y: number): Rect => ({ x, y, w: p.colW, h: p.hh });
  const stack = (x: number, y: number, n: number): Rect[] =>
    Array.from({ length: n }, (_, i) => ({ x, y: y + i * (p.h + p.gap), w: p.colW, h: p.h }));

  const sourceY = hy + p.hh + p.src;
  const tiers = stack(x0, sourceY + p.srcGap, 4);
  const feesEnd = tiers[3].y + p.h;
  // Losses: side by side the bars line up with the first three fee tiers; stacked, they start below the fee column.
  const lossHeaderY = format === "portrait" ? feesEnd + 80 : hy;
  const barsY = format === "portrait" ? lossHeaderY + p.hh + 30 : tiers[0].y;
  const bars = stack(x1, barsY, 3).reverse(); // bars[0] = Junior (bottom) ... bars[2] = Backstop (top)
  return {
    fees: { header: header(x0, hy), source: [x0 + p.colW / 2, sourceY], tiers },
    losses: { header: header(x1, lossHeaderY), inlet: [x1 + p.colW / 2, bars[0].y + p.h + p.inlet], bars },
    font: p.font,
  };
}

const topMid = (r: Rect): Pt => [r.x + r.w / 2, r.y];
const bottomMid = (r: Rect): Pt => [r.x + r.w / 2, r.y + r.h];

/** One particle stream at constant pixel speed; fades out over `out` (scene-local frames). */
const Stream: React.FC<{ from: Pt; to: Pt; color: string; start: number; out: readonly [number, number]; radius: number; frame: number }> = ({
  from,
  to,
  color,
  start,
  out,
  radius,
  frame,
}) => {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return (
    <div style={{ position: "absolute", inset: 0, opacity: 1 - ramp(frame, out[0], out[1]) }}>
      <Flow from={from} to={to} color={color} start={start} count={Math.max(3, Math.round(len / SPACING))} speed={SPEED / len} radius={radius} />
    </div>
  );
};

/** Tier or bar: a panel with a liquid level (0–1) from the bottom, a bright surface line while `moving`, and border `edge`. */
const Tier: React.FC<{ r: Rect; text: string; color: string; level: number; moving: boolean; edge: string; font: number; style: CSSProperties }> = ({
  r,
  text,
  color,
  level,
  moving,
  edge,
  font,
  style,
}) => (
  <div
    style={{
      position: "absolute",
      left: r.x,
      top: r.y,
      width: r.w,
      height: r.h,
      boxSizing: "border-box",
      background: C.panel,
      border: `2px solid ${edge}`,
      borderRadius: 18,
      overflow: "hidden",
      ...style,
    }}
  >
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: `${level * 100}%`,
        background: withAlpha(color, color === C.blue ? 0.55 : 0.3),
        // Surface line only while the level moves, so a partial fill reads at a glance but never rests on the label.
        borderTop: moving && level > 0.02 && level < 0.98 ? `3px solid ${color}` : undefined,
        boxSizing: "border-box",
      }}
    />
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0 20px",
        textAlign: "center",
        textWrap: "balance",
        fontFamily: FONT.sans,
        fontWeight: 600,
        fontSize: font,
        lineHeight: 1.25,
        color: C.cream,
      }}
    >
      {text}
    </div>
  </div>
);

/** Column header: label plus an arrow giving the direction of travel. */
const Header: React.FC<{ format: Format; r: Rect; text: string; down: boolean; color: string; draw: number; style: CSSProperties }> = ({
  format,
  r,
  text,
  down,
  color,
  draw,
  style,
}) => {
  const size = Math.round(BASE[format] * 0.7);
  const ah = Math.round(size * 1.15);
  const aw = Math.round(size * 0.7);
  const d = down
    ? `M ${aw / 2} 3 V ${ah - 3} M 4 ${ah - aw / 2 - 2} L ${aw / 2} ${ah - 3} L ${aw - 4} ${ah - aw / 2 - 2}`
    : `M ${aw / 2} ${ah - 3} V 3 M 4 ${aw / 2 + 2} L ${aw / 2} 3 L ${aw - 4} ${aw / 2 + 2}`;
  return (
    <div style={{ position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h, display: "flex", alignItems: "center", justifyContent: "center", gap: 16, ...style }}>
      <Label format={format} size={size}>
        {text}
      </Label>
      <svg width={aw} height={ah} style={{ flex: "none" }}>
        <path d={d} fill="none" stroke={color} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
      </svg>
    </div>
  );
};

/** Scene 6 (600 frames): fee flow pours down through the four tiers; losses climb Junior, Senior, Backstop. */
export const Waterfall: React.FC<{ format: Format }> = ({ format }) => {
  const frame = useCurrentFrame();
  const g = geometry(format);
  const radius = format === "portrait" ? 7 : 6;
  const { tiers, source } = g.fees;
  const { bars, inlet } = g.losses;
  const feeLevel = (i: number) => ramp(frame, FEE_FILL[i][0], FEE_FILL[i][1], Easing.inOut(Easing.quad));
  const lossLevel = (i: number) => 1 - (1 - LOSS_TO[i]) * ramp(frame, LOSS_DRAIN[i][0], LOSS_DRAIN[i][1], Easing.inOut(Easing.quad));

  // Fee streams: source -> first tier, then each tier's bottom -> the next tier's top once the one above is full.
  const feeSegs: Array<[Pt, Pt, number]> = tiers.map((t, i) => [i === 0 ? source : bottomMid(tiers[i - 1]), topMid(t), FEE_FILL[i][0] - LEAD]);
  // Loss streams climb: inlet -> Junior's bottom, then each bar's top -> the next bar's bottom once it is used up.
  const lossSegs: Array<[Pt, Pt, number]> = bars.map((b, i) => [i === 0 ? inlet : topMid(bars[i - 1]), bottomMid(b), LOSS_DRAIN[i][0] - LEAD]);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Headline format={format} style={{ position: "absolute", left: 0, right: 0, top: 0, ...rise(frame, 0) }}>
        {T.title}
      </Headline>

      {feeSegs.map(([a, b, s], i) => (
        <Stream key={`f${i}`} from={a} to={b} color={C.cream} start={s} out={FEE_STREAM_OUT} radius={radius} frame={frame} />
      ))}
      {lossSegs.map(([a, b, s], i) => (
        <Stream key={`l${i}`} from={a} to={b} color={C.loss} start={s} out={LOSS_STREAM_OUT} radius={radius} frame={frame} />
      ))}

      <Header format={format} r={g.fees.header} text={T.feesLabel} down color={C.light} draw={ramp(frame, 15, 35)} style={rise(frame, 8)} />
      <Header format={format} r={g.losses.header} text={T.lossesLabel} down={false} color={C.loss} draw={ramp(frame, 25, 45)} style={rise(frame, 18)} />

      {/* Fee source and loss inlet. */}
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <circle cx={source[0]} cy={source[1]} r={radius + 4} fill={C.cream} opacity={ramp(frame, 20, 30)} />
        <circle cx={inlet[0]} cy={inlet[1]} r={radius + 4} fill={C.loss} opacity={ramp(frame, 330, 342)} />
      </svg>

      {tiers.map((r, i) => {
        const full = ramp(frame, FEE_FILL[i][1] - 6, FEE_FILL[i][1]);
        return (
          <Tier
            key={T.steps[i]}
            r={r}
            text={T.steps[i]}
            color={FEE_COLORS[i]}
            level={feeLevel(i)}
            moving={frame > FEE_FILL[i][0] && frame < FEE_FILL[i][1]}
            edge={interpolateColors(full, [0, 1], [C.line, FEE_COLORS[i]])}
            font={g.font}
            style={rise(frame, 10 + stagger(i, 6))}
          />
        );
      })}
      {bars.map((r, i) => {
        const hit = ramp(frame, LOSS_DRAIN[i][0], LOSS_DRAIN[i][0] + 8);
        return (
          <Tier
            key={T.lossSteps[i]}
            r={r}
            text={T.lossSteps[i]}
            color={LOSS_COLORS[i]}
            level={lossLevel(i)}
            moving={frame > LOSS_DRAIN[i][0] && frame < LOSS_DRAIN[i][1]}
            edge={interpolateColors(hit, [0, 1], [LOSS_COLORS[i], C.loss])}
            font={g.font}
            style={rise(frame, 20 + stagger(i, 6))}
          />
        );
      })}
    </div>
  );
};
