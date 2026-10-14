import type { CSSProperties } from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { COPY } from "../copy";
import { BASE, C, type Format } from "../theme";
import { Flow } from "../ui/Flow";
import { Node } from "../ui/Node";
import { contentBox } from "../ui/Stage";
import { Body, Headline } from "../ui/Text";
import { rise } from "../ui/motion";

const T = COPY.book;
type Pt = [number, number];
type Rect = { x: number; y: number; w: number; h: number };
type Box = "alloc" | "senior" | "junior" | "book" | "venue0" | "venue1";
type Link = { from: Pt; to: Pt; color: string; start: number; count: number };

/** Frame each box rises in, and when each particle stream starts (scene-local). */
const APPEAR: Record<Box, number> = { alloc: 20, senior: 45, junior: 60, book: 165, venue0: 285, venue1: 297 };
const FLOW = { tranches: 90, book: 200, venues: 320 };
const CAPTION = 430;

const right = (r: Rect, dy = 0): Pt => [r.x + r.w, r.y + r.h / 2 + dy];
const left = (r: Rect, dy = 0): Pt => [r.x, r.y + r.h / 2 + dy];
const top = (r: Rect, dx = 0): Pt => [r.x + r.w / 2 + dx, r.y];
const bottom = (r: Rect, dx = 0): Pt => [r.x + r.w / 2 + dx, r.y + r.h];

/** Landscape: allocators | senior over junior | the book | venues, left to right, centred between title and caption. */
function landscape(): { rects: Record<Box, Rect>; links: Link[] } {
  const cy = 435;
  const alloc = { x: 0, y: cy - 70, w: 300, h: 140 };
  const senior = { x: 410, y: cy - 15 - 175, w: 470, h: 175 };
  const junior = { x: 410, y: cy + 15, w: 470, h: 175 };
  const book = { x: 990, y: cy - 50, w: 250, h: 100 };
  const venue0 = { x: 1340, y: cy - 30 - 130, w: 340, h: 130 };
  const venue1 = { x: 1340, y: cy + 30, w: 340, h: 130 };
  return {
    rects: { alloc, senior, junior, book, venue0, venue1 },
    links: [
      { from: right(alloc, -20), to: left(senior), color: C.light, start: FLOW.tranches, count: 8 },
      { from: right(alloc, 20), to: left(junior), color: C.blue, start: FLOW.tranches, count: 8 },
      { from: right(senior), to: left(book, -15), color: C.light, start: FLOW.book, count: 8 },
      { from: right(junior), to: left(book, 15), color: C.blue, start: FLOW.book, count: 8 },
      { from: right(book, -15), to: left(venue0), color: C.cream, start: FLOW.venues, count: 8 },
      { from: right(book, 15), to: left(venue1), color: C.cream, start: FLOW.venues, count: 8 },
    ],
  };
}

/**
 * Square and portrait: a top-to-bottom stack. Senior and junior are inset by a gutter on both sides; capital for the
 * junior tranche runs down the left gutter (past the senior box), the senior tranche's flow to the book runs down the
 * right gutter (past the junior box), so no stream crosses a box.
 */
function stacked(format: Format): { rects: Record<Box, Rect>; links: Link[] } {
  const { W, H } = contentBox(format);
  const p = format === "square"
    ? { title: 80, caption: 47, tg: 40, cg: 36, g: 160, hA: 76, hT: 124, hV: 120, gapT: 14, gapV: 60, maxF: 90 }
    : { title: 93, caption: 116, tg: 30, cg: 30, g: 170, hA: 110, hT: 190, hV: 165, gapT: 18, gapV: 60, maxF: 130 };
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
  return {
    rects: { alloc, senior, junior, book, venue0, venue1 },
    links: [
      { from: bottom(alloc), to: top(senior), color: C.light, start: FLOW.tranches, count: 5 },
      { from: [p.g * 0.35, alloc.y + alloc.h], to: left(junior), color: C.blue, start: FLOW.tranches, count: 9 },
      // Leaves the upper part of the senior box and lands on the book's top-right corner: Flow bows its path to the
      // left on the way down, and this keeps the stream >= 18 px clear of the junior box (checked numerically).
      { from: [senior.x + senior.w, senior.y + senior.h * 0.2], to: [W, book.y], color: C.light, start: FLOW.book, count: 9 },
      { from: bottom(junior), to: top(book), color: C.blue, start: FLOW.book, count: 5 },
      { from: [venue0.x + vw / 2, book.y + book.h], to: top(venue0), color: C.cream, start: FLOW.venues, count: 5 },
      { from: [venue1.x + vw / 2, book.y + book.h], to: top(venue1), color: C.cream, start: FLOW.venues, count: 5 },
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
        <Flow key={i} from={l.from} to={l.to} color={l.color} start={l.start} count={l.count} radius={format === "portrait" ? 7 : 6} />
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
