import { Easing, interpolateColors, useCurrentFrame } from "remotion";
import { COPY } from "../copy";
import { FONT } from "../fonts";
import { BASE, C, type Format } from "../theme";
import { withAlpha } from "../ui/color";
import { contentBox } from "../ui/Stage";
import { Body, Headline, Label } from "../ui/Text";
import { ramp, rise, stagger } from "../ui/motion";

const T = COPY.proof;
/**
 * Scene-local frames. The four mark fields appear, gather into one mark (30–180), the mark is signed, then drops
 * onto the chain as the newest block (220–300). From 330 the earlier periods' marks light up: one per period.
 */
const AT = {
  chips: 10,
  gather: [70, 140],
  card: [118, 165],
  seal: 182,
  chain: 188,
  drop: [220, 300],
  /** After the landing, the chain and captions glide up to the optical centre (the mark has left the space above). */
  settle: [306, 352],
  signed: 240,
  gas: 330,
  periods: 340,
} as const;

type Pt = [number, number];
type Rect = { x: number; y: number; w: number; h: number };

type Geo = {
  chip: { w: number; h: number; font: number };
  /** Chip centres before (spread) and after (inside the mark) gathering. */
  start: Pt[];
  end: Pt[];
  card: Rect;
  /** Header label ("MARK") position and size inside the card. */
  header: { x: number; y: number; size: number };
  seal: { c: Pt; size: number };
  chain: { periods: number; per: number; size: number; gap: number; pgap: number; x0: number; cy: number };
  captionTop: number;
  captionSize: number;
  /** Vertical shift (px, negative = up) applied to the chain group by the settle. */
  settleY: number;
};

/**
 * Title on top; the mark card in the upper middle; the chain below it; captions under the chain. The card keeps a
 * column on its right free for the seal (as the charter card keeps one for its stamp), so the seal never covers a field.
 */
function geometry(format: Format): Geo {
  const { W, H } = contentBox(format);
  const p = {
    landscape: { cw: 300, ch: 68, font: 32, pad: 34, head: 36, hg: 18, gg: 22, sealCol: 190, seal: 160, cardCy: 290, chainCy: 548, per: 4, periods: 4, size: 72, gap: 20, pgap: 48, capGap: 62, capLines: 2 },
    square: { cw: 290, ch: 64, font: 30, pad: 30, head: 36, hg: 16, gg: 18, sealCol: 190, seal: 156, cardCy: 268, chainCy: 506, per: 3, periods: 3, size: 66, gap: 18, pgap: 40, capGap: 56, capLines: 2 },
    portrait: { cw: 310, ch: 76, font: 36, pad: 32, head: 42, hg: 20, gg: 20, sealCol: 196, seal: 170, cardCy: 640, chainCy: 1030, per: 3, periods: 3, size: 76, gap: 18, pgap: 36, capGap: 70, capLines: 3 },
  }[format];
  const cardW = 2 * p.pad + 2 * p.cw + p.gg + p.sealCol;
  const cardH = 2 * p.pad + p.head + p.hg + 2 * p.ch + p.gg;
  const card: Rect = { x: (W - cardW) / 2, y: p.cardCy - cardH / 2, w: cardW, h: cardH };
  const gx = card.x + p.pad;
  const gy = card.y + p.pad + p.head + p.hg;
  const end: Pt[] = [0, 1, 2, 3].map((i) => [gx + (i % 2) * (p.cw + p.gg) + p.cw / 2, gy + Math.floor(i / 2) * (p.ch + p.gg) + p.ch / 2]);
  // Spread: one row (landscape) or a loose 2x2 (square, portrait), centred on the frame. The row is ordered NAV, P&L,
  // Inventory, Receipt root so that, gathering rows first and columns second, no two chips ever cross.
  const ROW_SLOT = [0, 2, 1, 3];
  const start: Pt[] =
    format === "landscape"
      ? [0, 1, 2, 3].map((i) => [W / 2 + (ROW_SLOT[i] - 1.5) * (p.cw + 40), p.cardCy])
      : [0, 1, 2, 3].map((i) => [W / 2 + (i % 2 ? 1 : -1) * (p.cw / 2 + 50), p.cardCy + (i < 2 ? -1 : 1) * (p.ch / 2 + (format === "portrait" ? 90 : 56))]);
  const chainW = p.periods * (p.per * p.size + (p.per - 1) * p.gap) + (p.periods - 1) * p.pgap;
  const captionSize = Math.round(BASE[format] * 0.8);
  const captionTop = p.chainCy + p.size / 2 + p.capGap;
  // Settle: centre the chain group (chain top to last caption line) a little above the middle of the space under the title.
  const titleBottom = Math.round(BASE[format] * 1.5) * 1.15;
  const groupTop = p.chainCy - p.size / 2;
  const groupBottom = captionTop + p.capLines * captionSize * 1.35 + Math.round(BASE[format] * 0.3);
  const target = titleBottom + (H - titleBottom) * 0.47;
  return {
    chip: { w: p.cw, h: p.ch, font: p.font },
    start,
    end,
    card,
    header: { x: gx, y: card.y + p.pad, size: Math.max(26, Math.round(BASE[format] * 0.6)) },
    seal: { c: [card.x + card.w - p.pad - p.sealCol / 2 + 6, gy + p.ch + p.gg / 2], size: p.seal },
    chain: { periods: p.periods, per: p.per, size: p.size, gap: p.gap, pgap: p.pgap, x0: (W - chainW) / 2, cy: p.chainCy },
    captionTop,
    captionSize,
    settleY: Math.round(target - (groupTop + groupBottom) / 2),
  };
}

/** Rect of block `k` of period `q` on the chain. */
function blockRect(g: Geo, q: number, k: number): Rect {
  const { per, size, gap, pgap, x0, cy } = g.chain;
  const x = x0 + q * (per * size + (per - 1) * gap + pgap) + k * (size + gap);
  return { x, y: cy - size / 2, w: size, h: size };
}

/** Which block of each earlier period carries that period's mark (deterministic, varied). The last period's mark is the newest block. */
const MARK_AT = [1, 2, 0];

/** Seal: blue ring draws on, then the word lands; tilted, settling from 1.2x (the charter stamp's look). */
const Seal: React.FC<{ c: Pt; size: number; frame: number; label: string }> = ({ c, size, frame, label }) => {
  if (frame < AT.seal) return null;
  const draw = ramp(frame, AT.seal, AT.seal + 20, Easing.out(Easing.cubic));
  const word = ramp(frame, AT.seal + 8, AT.seal + 22);
  const settle = ramp(frame, AT.seal, AT.seal + 14, Easing.out(Easing.back(1.6)));
  const r = size / 2;
  return (
    <div
      style={{
        position: "absolute",
        left: c[0] - r,
        top: c[1] - r,
        width: size,
        height: size,
        transform: `rotate(-12deg) scale(${1.2 - 0.2 * settle})`,
      }}
    >
      <svg width={size} height={size} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <circle
          cx={r}
          cy={r}
          r={r - 5}
          fill={withAlpha(C.blue, 0.16 * word)}
          stroke={C.blue}
          strokeWidth={8}
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - draw}
          transform={`rotate(-90 ${r} ${r})`}
        />
        <circle cx={r} cy={r} r={r - 15} fill="none" stroke={C.blue} strokeWidth={2} opacity={word} />
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
          fontSize: Math.max(26, Math.round(size * 0.2)),
          color: C.cream,
          opacity: word,
        }}
      >
        {label}
      </div>
    </div>
  );
};

/** One mark field as a pill centred on `c`. */
const Chip: React.FC<{ c: Pt; w: number; h: number; font: number; text: string; style: React.CSSProperties }> = ({ c, w, h, font, text, style }) => (
  <div
    style={{
      position: "absolute",
      left: c[0] - w / 2,
      top: c[1] - h / 2,
      width: w,
      height: h,
      boxSizing: "border-box",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 999,
      border: `2px solid ${C.line}`,
      background: withAlpha(C.panel, 0.9),
      fontFamily: FONT.sans,
      fontWeight: 500,
      fontSize: font,
      color: C.cream,
      whiteSpace: "nowrap",
      ...style,
    }}
  >
    {text}
  </div>
);

/** Scene 7 (450 frames): NAV, inventory, P&L and the receipt root become one signed mark, committed on-chain. */
export const Proof: React.FC<{ format: Format }> = ({ format }) => {
  const frame = useCurrentFrame();
  const g = geometry(format);
  const { periods, per, size } = g.chain;
  const last = periods - 1;
  const slot = blockRect(g, last, per - 1); // the newest block: where the mark lands

  // Drop: the card shrinks into the slot and falls onto the chain; its contents fade out early so no text shrinks.
  const fall = ramp(frame, AT.drop[0], AT.drop[1], Easing.in(Easing.quad));
  const shrink = ramp(frame, AT.drop[0], AT.drop[0] + 45, Easing.inOut(Easing.cubic));
  const contentOut = ramp(frame, AT.drop[0], AT.drop[0] + 22);
  const landed = frame >= AT.drop[1];
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const cardCx = lerp(g.card.x + g.card.w / 2, slot.x + slot.w / 2, shrink);
  const cardCy = lerp(g.card.y + g.card.h / 2, slot.y + slot.h / 2, fall);
  const cardW = lerp(g.card.w, slot.w, shrink);
  const cardH = lerp(g.card.h, slot.h, shrink);
  const k = cardW / g.card.w; // content scale while it fades
  const dx = cardCx - (g.card.x + g.card.w / 2);
  const dy = cardCy - (g.card.y + g.card.h / 2);
  const cardIn = ramp(frame, AT.card[0], AT.card[1], Easing.out(Easing.cubic));
  const lit = ramp(frame, AT.drop[1] - 10, AT.drop[1]); // the mark block turns blue as it lands
  const pulse = ramp(frame, AT.drop[1], AT.drop[1] + 30, Easing.out(Easing.cubic));
  const settle = ramp(frame, AT.settle[0], AT.settle[1], Easing.inOut(Easing.cubic));

  const chainIn = rise(frame, AT.chain);
  const linkW = 3;
  const blockStyle = (r: Rect, on: number): React.CSSProperties => ({
    position: "absolute",
    left: r.x,
    top: r.y,
    width: r.w,
    height: r.h,
    boxSizing: "border-box",
    borderRadius: 12,
    border: `2px solid ${interpolateColors(on, [0, 1], [C.line, C.light])}`,
    background: interpolateColors(on, [0, 1], [C.panel, C.blue]),
  });

  // Chain: blocks, links, the empty slot, then brackets under each period.
  const blocks: React.ReactNode[] = [];
  for (let q = 0; q < periods; q++) {
    for (let b = 0; b < per; b++) {
      if (q === last && b === per - 1) continue; // the slot is drawn separately
      const on = q < last && b === MARK_AT[q % MARK_AT.length] ? ramp(frame, AT.periods + stagger(q, 14), AT.periods + stagger(q, 14) + 12) : 0;
      blocks.push(<div key={`${q}-${b}`} style={blockStyle(blockRect(g, q, b), on)} />);
    }
  }
  const first = blockRect(g, 0, 0);
  const bracketY = g.chain.cy + size / 2 + 20;
  const bracketDraw = ramp(frame, AT.gas, AT.gas + 25);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Headline format={format} style={{ position: "absolute", left: 0, right: 0, top: 0, textWrap: "balance", ...rise(frame, 0) }}>
        {T.title}
      </Headline>

      <div style={{ position: "absolute", inset: 0, transform: `translateY(${g.settleY * settle}px)` }}>
      {/* Chain */}
      <div style={{ position: "absolute", inset: 0, ...chainIn }}>
        <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          <defs>
            <linearGradient id="proof-lead" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor={C.light} stopOpacity={0} />
              <stop offset="1" stopColor={C.light} stopOpacity={0.35} />
            </linearGradient>
          </defs>
          {/* Earlier history fading in from the left, then one link line behind every block. */}
          <rect x={first.x - 90} y={g.chain.cy - linkW / 2} width={90} height={linkW} fill="url(#proof-lead)" />
          <line x1={first.x} x2={slot.x} y1={g.chain.cy} y2={g.chain.cy} stroke={C.line} strokeWidth={linkW} />
          {Array.from({ length: periods }, (_, q) => {
            const a = blockRect(g, q, 0);
            const b = blockRect(g, q, per - 1);
            const p = ramp(bracketDraw, stagger(q, 0.12), stagger(q, 0.12) + 0.6);
            const x1 = a.x + 4;
            const x2 = b.x + b.w - 4;
            return (
              <path
                key={q}
                d={`M ${x1} ${bracketY - 10} V ${bracketY} H ${x2} V ${bracketY - 10}`}
                fill="none"
                stroke={C.light}
                strokeOpacity={0.7}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={1 - p}
              />
            );
          })}
        </svg>
        {blocks}
        {/* Empty slot at the head of the chain until the mark lands in it. */}
        {!landed ? (
          <div style={{ ...blockStyle(slot, 0), background: "transparent", border: `2px dashed ${withAlpha(C.light, 0.6)}` }} />
        ) : null}
      </div>

      {/* Landing pulse around the newest block. */}
      {landed ? (
        <div
          style={{
            position: "absolute",
            left: slot.x + slot.w / 2 - (slot.w / 2) * (1 + 0.8 * pulse),
            top: slot.y + slot.h / 2 - (slot.h / 2) * (1 + 0.8 * pulse),
            width: slot.w * (1 + 0.8 * pulse),
            height: slot.h * (1 + 0.8 * pulse),
            boxSizing: "border-box",
            borderRadius: 12 + 10 * pulse,
            border: `3px solid ${C.light}`,
            opacity: 1 - pulse,
          }}
        />
      ) : null}

      {/* The mark: its frame (card, then the falling block), and its contents. */}
      {frame >= AT.card[0] ? (
        <div
          style={{
            position: "absolute",
            left: cardCx - cardW / 2,
            top: cardCy - cardH / 2,
            width: cardW,
            height: cardH,
            boxSizing: "border-box",
            borderRadius: lerp(18, 12, shrink),
            border: `2px solid ${interpolateColors(lit, [0, 1], [C.cream, C.light])}`,
            background: interpolateColors(lit, [0, 1], [C.panel, C.blue]),
            opacity: cardIn,
            transform: `scale(${1.04 - 0.04 * cardIn})`,
          }}
        />
      ) : null}
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: 1 - contentOut,
          transform: `translate(${dx}px, ${dy}px) scale(${k})`,
          transformOrigin: `${g.card.x + g.card.w / 2}px ${g.card.y + g.card.h / 2}px`,
        }}
      >
        <Label format={format} size={g.header.size} style={{ position: "absolute", left: g.header.x, top: g.header.y, opacity: cardIn }}>
          {T.mark}
        </Label>
        {T.items.map((text, i) => {
          // Rows first (y), then columns (x): with the spread ordered as in geometry(), chips never cross.
          const t0 = AT.gather[0] + stagger(i, 5);
          const my = ramp(frame, t0, t0 + 32, Easing.inOut(Easing.cubic));
          const mx = ramp(frame, t0 + 24, AT.gather[1] + stagger(i, 5), Easing.inOut(Easing.cubic));
          const c: Pt = [lerp(g.start[i][0], g.end[i][0], mx), lerp(g.start[i][1], g.end[i][1], my)];
          return <Chip key={text} c={c} w={g.chip.w} h={g.chip.h} font={g.chip.font} text={text} style={rise(frame, AT.chips + stagger(i, 10))} />;
        })}
        <Seal c={g.seal.c} size={g.seal.size} frame={frame} label={T.seal} />
      </div>

      {/* Captions under the chain. */}
      <div style={{ position: "absolute", left: 0, right: 0, top: g.captionTop, display: "flex", flexDirection: "column", alignItems: "center", gap: Math.round(BASE[format] * 0.3) }}>
        <Body format={format} size={g.captionSize} style={{ color: C.cream, textAlign: "center", textWrap: "balance", opacity: ramp(frame, AT.signed, AT.signed + 20) }}>
          {T.signed}
        </Body>
        <Body format={format} size={g.captionSize} style={{ color: C.light, textAlign: "center", textWrap: "balance", opacity: ramp(frame, AT.gas, AT.gas + 20) }}>
          {T.gas}
        </Body>
      </div>
      </div>
    </div>
  );
};

