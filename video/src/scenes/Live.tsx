import { Easing, useCurrentFrame } from "remotion";
import { COPY } from "../copy";
import { FONT } from "../fonts";
import { BASE, C, FPS, type Format } from "../theme";
import { BrowserFrame, frameHeight, type FrameClip } from "../ui/BrowserFrame";
import { withAlpha } from "../ui/color";
import { contentBox } from "../ui/Stage";
import { Body, Headline } from "../ui/Text";
import { ramp, rise, stagger } from "../ui/motion";

const T = COPY.live;
/** Scene-local frames: the dashboard plays 0–360, then the status page cross-fades in over 20 frames and plays to 600. */
const AT = { title: 0, frame: 8, status: 360, fade: 20, chips: 40, caption: 120 } as const;
/** Status-dot green (the live pages' "operating normally" colour); used only for the live dots. */
const LIVE = "#3fc98a";

const clips = (format: Format): readonly FrameClip[] => [
  { src: "footage/dashboard.webm", url: T.url, from: 0, durationInFrames: AT.status + AT.fade },
  {
    src: "footage/status.webm",
    url: T.statusUrl,
    from: AT.status,
    durationInFrames: 600 - AT.status,
    // Square: crop in on the status table (1.2x, the site's nav bar shifted out of view) so it fills the shorter window
    // and reads larger; the table's own borders stay inside the frame.
    ...(format === "square" ? { zoom: 1.2, shiftY: -50 } : {}),
  },
];

type Geo = {
  title: { size: number; lines: number; width: number };
  frame: { x: number; y: number; w: number; viewH: number };
  /** `row`: chips left and caption right on one line under the frame; otherwise both are centred, stacked. */
  row: boolean;
  chip: { h: number; font: number; gap: number };
  chipsTop: number;
  captionTop: number;
  captionSize: number;
};

/**
 * Title on top (at the safe padding's left edge, like every other scene), the browser frame under it, the live books
 * and the caption under the frame. Landscape crops the clip a little (a shorter window) so the whole stack stays inside
 * the safe box; square and portrait show it 960 wide, the frame reaching 30 px into the side padding (square in a
 * shorter window, its status clip zoomed in).
 */
function geometry(format: Format): Geo {
  const { W, H } = contentBox(format);
  const titleSize = Math.round(BASE[format] * 1.5);
  const captionSize = Math.round(BASE[format] * 0.8);
  if (format === "landscape") {
    const w = 1440;
    const x = (W - w) / 2;
    const y = 104;
    const viewH = 600;
    const bottom = y + frameHeight(format, viewH) + 4;
    const chip = { h: 58, font: 30, gap: 16 };
    const chipsTop = bottom + 28;
    return {
      title: { size: titleSize, lines: 1, width: W },
      frame: { x, y, w, viewH },
      row: true,
      chip,
      chipsTop,
      captionTop: chipsTop + (chip.h - captionSize * 1.35) / 2,
      captionSize,
    };
  }
  const w = 960;
  // Square: a shorter window (the status page's empty lower part is cropped; its clip is zoomed in to fill it).
  const viewH = format === "square" ? 430 : 540;
  // The title wraps inside the safe width: two lines in square, three in portrait (larger type, same width).
  const lines = format === "square" ? 2 : 3;
  const titleBottom = lines * titleSize * 1.15;
  const chip = format === "square" ? { h: 54, font: 28, gap: 14 } : { h: 68, font: 36, gap: 18 };
  const gapA = format === "square" ? 30 : 44; // frame -> chips
  const gapB = format === "square" ? 18 : 30; // chips -> caption
  const fh = frameHeight(format, viewH) + 4;
  const group = fh + gapA + chip.h + gapB + captionSize * 1.35;
  // Square: centred in the space under the title. Portrait: the group sits in the upper part of that space.
  const y = Math.round(titleBottom + (H - titleBottom - group) * (format === "square" ? 0.5 : 0.33));
  const chipsTop = y + fh + gapA;
  return {
    title: { size: titleSize, lines, width: W },
    frame: { x: (W - w) / 2, y, w, viewH },
    row: false,
    chip,
    chipsTop,
    captionTop: chipsTop + chip.h + gapB,
    captionSize,
  };
}

/** A live book: ticker pill with a green dot whose halo pulses (1.6 s period, offset per book). */
const Chip: React.FC<{ text: string; h: number; font: number; phase: number; style: React.CSSProperties }> = ({ text, h, font, phase, style }) => {
  const frame = useCurrentFrame();
  const t = ((frame / FPS + phase) % 1.6) / 1.6; // 0 -> 1 each pulse
  const dot = Math.round(h * 0.26);
  return (
    <div
      style={{
        height: h,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        gap: Math.round(h * 0.26),
        padding: `0 ${Math.round(h * 0.46)}px 0 ${Math.round(h * 0.38)}px`,
        borderRadius: 999,
        border: `2px solid ${C.line}`,
        background: withAlpha(C.panel, 0.9),
        fontFamily: FONT.sans,
        fontWeight: 600,
        fontSize: font,
        letterSpacing: "0.04em",
        color: C.cream,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      <div style={{ position: "relative", width: dot, height: dot, flex: "none" }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 99,
            background: LIVE,
            transform: `scale(${1 + 1.6 * Easing.out(Easing.quad)(t)})`,
            opacity: 0.55 * (1 - t),
          }}
        />
        <div style={{ position: "absolute", inset: 0, borderRadius: 99, background: LIVE }} />
      </div>
      {text}
    </div>
  );
};

/** Scene 8 (600 frames): the live testnet dashboard, then the status page, in a browser frame; three books live. */
export const Live: React.FC<{ format: Format }> = ({ format }) => {
  const frame = useCurrentFrame();
  const g = geometry(format);
  const chips = (
    <div style={{ display: "flex", gap: g.chip.gap }}>
      {T.books.map((b, i) => (
        <Chip key={b} text={b} h={g.chip.h} font={g.chip.font} phase={i * 0.53} style={rise(frame, AT.chips + stagger(i, 8))} />
      ))}
    </div>
  );
  const caption = (
    <Body
      format={format}
      size={g.captionSize}
      style={{ color: C.light, textAlign: g.row ? "right" : "center", textWrap: "balance", opacity: ramp(frame, AT.caption, AT.caption + 20) }}
    >
      {T.caption}
    </Body>
  );

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Headline
        format={format}
        size={g.title.size}
        style={{ position: "absolute", left: 0, width: g.title.width, top: 0, textWrap: "balance", ...rise(frame, AT.title) }}
      >
        {T.title}
      </Headline>

      <div style={{ position: "absolute", left: g.frame.x, top: g.frame.y, ...rise(frame, AT.frame) }}>
        <BrowserFrame format={format} src={clips(format)} width={g.frame.w} viewHeight={g.frame.viewH} fade={AT.fade} />
      </div>

      {g.row ? (
        <>
          <div style={{ position: "absolute", left: g.frame.x, top: g.chipsTop }}>{chips}</div>
          <div style={{ position: "absolute", right: g.frame.x, top: g.captionTop }}>{caption}</div>
        </>
      ) : (
        <>
          <div style={{ position: "absolute", left: g.frame.x, width: g.frame.w, top: g.chipsTop, display: "flex", justifyContent: "center" }}>{chips}</div>
          <div style={{ position: "absolute", left: g.frame.x, width: g.frame.w, top: g.captionTop }}>{caption}</div>
        </>
      )}
    </div>
  );
};
