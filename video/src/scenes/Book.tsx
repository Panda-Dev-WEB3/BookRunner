import type { CSSProperties } from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { COPY } from "../copy";
import { BASE, C, type Format } from "../theme";
import { PathFlow, roundedRoute } from "../ui/Flow";
import { Node } from "../ui/Node";
import { contentBox } from "../ui/Stage";
import { Body, Headline } from "../ui/Text";
import { rise } from "../ui/motion";

const T = COPY.book;
type Pt = [number, number];
type Rect = { x: number; y: number; w: number; h: number };
type Box = "alloc" | "senior" | "junior" | "book" | "venue0" | "venue1";
type Link = { path: Pt[]; color: string; start: number };

/** Frame each box rises in, and when each connector starts (scene-local). */
const APPEAR: Record<Box, number> = { alloc: 20, senior: 45, junior: 60, book: 165, venue0: 285, venue1: 297 };
const FLOW = { tranches: 90, book: 200, venues: 320 };
const CAPTION = 430;
/** Corner radius of the connector elbows (px). */
const CORNER = 18;

const midY = (r: Rect): number => r.y + r.h / 2;
const midX = (r: Rect): number => r.x + r.w / 2;

/**
 * Landscape: allocators | senior over junior | the book | venues, left to right, centred between title and caption.
 * Connectors are elbows from one box's edge to the next box's edge, turning in the gap between the columns.
 */
function landscape(): { rects: Record<Box, Rect>; links: Link[] } {
  const cy = 435;
  const alloc = { x: 0, y: cy - 70, w: 300, h: 140 };
  const senior = { x: 410, y: cy - 20 - 175, w: 470, h: 175 };
  const junior = { x: 410, y: cy + 20, w: 470, h: 175 };
  const book = { x: 990, y: cy - 50, w: 250, h: 100 };
  const venue0 = { x: 1340, y: cy - 30 - 130, w: 340, h: 130 };
  const venue1 = { x: 1340, y: cy + 30, w: 340, h: 130 };
  const elbow = (a: Pt, b: Pt): Pt[] => {
    const xm = (a[0] + b[0]) / 2;
    return [a, [xm, a[1]], [xm, b[1]], b];
  };
  const ax = alloc.x + alloc.w;
  const tx = senior.x + senior.w;
  const bx = book.x + book.w;
  return {
    rects: { alloc, senior, junior, book, venue0, venue1 },
    links: [
      { path: elbow([ax, cy - 30], [senior.x, midY(senior)]), color: C.light, start: FLOW.tranches },
      { path: elbow([ax, cy + 30], [junior.x, midY(junior)]), color: C.blue, start: FLOW.tranches },
      { path: elbow([tx, midY(senior)], [book.x, cy - 25]), color: C.light, start: FLOW.book },
      { path: elbow([tx, midY(junior)], [book.x, cy + 25]), color: C.blue, start: FLOW.book },
      { path: elbow([bx, cy - 25], [venue0.x, midY(venue0)]), color: C.cream, start: FLOW.venues },
      { path: elbow([bx, cy + 25], [venue1.x, midY(venue1)]), color: C.cream, start: FLOW.venues },
    ],
  };
}

/**
 * Square and portrait: a top-to-bottom stack. Senior and junior are inset by a gutter `g` on both sides. Straight
 * connectors run down the middle (allocators -> senior, junior -> book, book -> venues); capital for the junior
 * tranche runs down the left gutter into the junior box's left edge, and the senior tranche's flow to the book leaves
 * the senior box's right edge and runs down the right gutter to the book. Every connector goes edge to edge, so none
 * passes behind a box.
 */
function stacked(format: Format): { rects: Record<Box, Rect>; links: Link[] } {
  const { W, H } = contentBox(format);
  const p = format === "square"
    ? { title: 80, caption: 50, tg: 44, cg: 36, g: 150, hA: 74, hT: 122, hV: 114, gapT: 34, gapV: 60, maxF: 90 }
    : { title: 93, caption: 116, tg: 60, cg: 30, g: 170, hA: 110, hT: 190, hV: 165, gapT: 44, gapV: 60, maxF: 130 };
  const top0 = p.title + p.tg;
  const bottom0 = H - p.caption - p.cg;
  const fixed = p.hA + p.hT * 2 + p.gapT + p.hA + p.hV;
  const F = Math.min(p.maxF, (bottom0 - top0 - fixed) / 3);
  let y = top0 + (bottom0 - top0 - fixed - 3 * F) / 2;
  const alloc = { x: 0, y, w: W, h: p.hA };
  y += p.hA + F;
  const senior = { x: p.g, y, w: W - 2 * p.g, h: p.hT };
  y += p.hT + p.gapT;
  const junior = { x: p.g, y, w: W - 2 * p.g, h: p.hT };
  y += p.hT + F;
  const book = { x: 0, y, w: W, h: p.hA };
  y += p.hA + F;
  const vw = (W - p.gapV) / 2;
  const venue0 = { x: 0, y, w: vw, h: p.hV };
  const venue1 = { x: vw + p.gapV, y, w: vw, h: p.hV };
  const gl = p.g / 2; // left gutter line
  const gr = W - p.g / 2; // right gutter line
  const down = (x: number, a: Rect, b: Rect): Pt[] => [[x, a.y + a.h], [x, b.y]];
  return {
    rects: { alloc, senior, junior, book, venue0, venue1 },
    links: [
      { path: down(W / 2, alloc, senior), color: C.light, start: FLOW.tranches },
      { path: [[gl, alloc.y + alloc.h], [gl, midY(junior)], [junior.x, midY(junior)]], color: C.blue, start: FLOW.tranches },
      { path: [[senior.x + senior.w, midY(senior)], [gr, midY(senior)], [gr, book.y]], color: C.light, start: FLOW.book },
      { path: down(W / 2, junior, book), color: C.blue, start: FLOW.book },
      { path: down(midX(venue0), book, venue0), color: C.cream, start: FLOW.venues },
      { path: down(midX(venue1), book, venue1), color: C.cream, start: FLOW.venues },
    ],
  };
}

/** Scene 3 (600 frames): allocators fund senior and junior tranches; the book capitalises the venue. */
export const Book: React.FC<{ format: Format }> = ({ format }) => {
  const frame = useCurrentFrame();
  const { rects, links } = format === "landscape" ? landscape() : stacked(format);
  const pad = format === "square" ? "16px 26px" : undefined;
  const at = (b: Box, extra: CSSProperties = {}): CSSProperties => ({
    position: "absolute",
    left: rects[b].x,
    top: rects[b].y,
    width: rects[b].w,
    height: rects[b].h,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    textAlign: "center",
    ...(pad ? { padding: pad } : {}),
    ...rise(frame, APPEAR[b]),
    ...extra,
  });
  const captionIn = interpolate(frame, [CAPTION, CAPTION + 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Headline format={format} style={{ position: "absolute", left: 0, right: 0, top: 0, ...rise(frame, 0) }}>
        {T.title}
      </Headline>
      {links.map((l, i) => (
        <PathFlow key={i} path={roundedRoute(l.path, CORNER)} color={l.color} start={l.start} radius={format === "portrait" ? 7 : 6} />
      ))}
      <Node format={format} title={T.allocators} style={at("alloc")} />
      <Node format={format} title={T.senior} note={T.seniorNote} style={at("senior", { border: `2px solid ${C.light}` })} />
      <Node format={format} title={T.junior} note={T.juniorNote} style={at("junior", { border: `2px solid ${C.blue}` })} />
      <Node format={format} title={T.book} style={at("book", { border: `2px solid ${C.cream}` })} />
      <Node format={format} title={T.venue[0]} style={at("venue0")} />
      <Node format={format} title={T.venue[1]} style={at("venue1")} />
      <Body
        format={format}
        size={Math.round(BASE[format] * 0.8)}
        style={{ position: "absolute", left: 0, right: 0, bottom: 0, color: C.light, textAlign: "center", textWrap: "balance", opacity: captionIn }}
      >
        {T.caption}
      </Body>
    </div>
  );
};
