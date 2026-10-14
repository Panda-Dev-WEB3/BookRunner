import type { CSSProperties } from "react";
import { OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import { FONT } from "../fonts";
import { C, type Format } from "../theme";
import { withAlpha } from "./color";
import { ramp } from "./motion";

/** One recorded clip (a path under `public/`) shown from `from` for `durationInFrames`, with its own address. */
export type FrameClip = { src: string; url: string; from: number; durationInFrames: number };

/** Chrome bar height and address text size (px) per format; the address stays >= 26 px. */
const BAR: Record<Format, { h: number; font: number; dot: number }> = {
  landscape: { h: 56, font: 28, dot: 13 },
  square: { h: 50, font: 26, dot: 11 },
  portrait: { h: 54, font: 28, dot: 12 },
};

/** Total height (px) of a frame with the given visible clip height. */
export function frameHeight(format: Format, viewHeight: number): number {
  return BAR[format].h + viewHeight;
}

const Lock: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size * 0.8} height={size} viewBox="0 0 16 20" style={{ flex: "none" }}>
    <rect x={1.5} y={8.5} width={13} height={10} rx={2} fill="none" stroke={C.muted} strokeWidth={2} />
    <path d="M4.5 8.5 V6 a3.5 3.5 0 0 1 7 0 V8.5" fill="none" stroke={C.muted} strokeWidth={2} />
  </svg>
);

/**
 * A minimal browser window playing 16:9 screen recordings (muted) at `width`. The clip is scaled to the frame's width
 * and shown from its top; `viewHeight` (default: the full 16:9 height) crops the bottom, like a shorter window.
 * With several clips, each later one cross-fades in over `fade` frames from its `from`, and the address follows.
 */
export const BrowserFrame: React.FC<{
  format: Format;
  src: string | readonly FrameClip[];
  /** Address for a single `src`. */
  url?: string;
  width: number;
  viewHeight?: number;
  fade?: number;
  style?: CSSProperties;
}> = ({ format, src, url = "", width, viewHeight, fade = 20, style }) => {
  const frame = useCurrentFrame();
  const clips: readonly FrameClip[] = typeof src === "string" ? [{ src, url, from: 0, durationInFrames: Infinity }] : src;
  const videoH = Math.round((width * 9) / 16);
  const viewH = viewHeight ?? videoH;
  const bar = BAR[format];
  // Opacity of clip i: later clips cover earlier ones as they fade in.
  const shown = clips.map((c, i) => (i === 0 ? 1 : ramp(frame, c.from, c.from + fade)));
  // Address: the old one fades out over the first half of the cross-fade, the new one in over the second half.
  const half = fade / 2;
  const addr = clips.map((c, i) => {
    const inn = i === 0 ? 1 : ramp(frame, c.from + half, c.from + fade);
    const out = i + 1 < clips.length ? 1 - ramp(frame, clips[i + 1].from, clips[i + 1].from + half) : 1;
    return inn * out;
  });

  return (
    <div
      style={{
        width,
        height: bar.h + viewH,
        boxSizing: "content-box",
        borderRadius: 16,
        overflow: "hidden",
        border: `2px solid ${C.line}`,
        background: C.deep,
        boxShadow: `0 30px 80px ${withAlpha(C.deep, 0.7)}`,
        ...style,
      }}
    >
      {/* Chrome: three window dots and the address pill. */}
      <div
        style={{
          height: bar.h,
          display: "flex",
          alignItems: "center",
          gap: bar.dot,
          padding: `0 ${Math.round(bar.h * 0.4)}px`,
          boxSizing: "border-box",
          background: C.panel,
          borderBottom: `1.5px solid ${C.line}`,
        }}
      >
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ width: bar.dot, height: bar.dot, borderRadius: 99, background: withAlpha(C.light, 0.35), flex: "none" }} />
        ))}
        <div
          style={{
            position: "relative",
            flex: 1,
            height: Math.round(bar.h * 0.72),
            marginLeft: bar.dot,
            borderRadius: 999,
            background: C.deep,
            border: `1.5px solid ${withAlpha(C.light, 0.18)}`,
          }}
        >
          {clips.map((c, i) => (
            <div
              key={c.src}
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                gap: Math.round(bar.font * 0.45),
                padding: `0 ${Math.round(bar.h * 0.36)}px`,
                fontFamily: FONT.sans,
                fontWeight: 500,
                fontSize: bar.font,
                color: C.light,
                whiteSpace: "nowrap",
                opacity: addr[i],
              }}
            >
              <Lock size={Math.round(bar.font * 0.8)} />
              {c.url}
            </div>
          ))}
        </div>
      </div>

      {/* Viewport */}
      <div style={{ position: "relative", width, height: viewH, overflow: "hidden" }}>
        {clips.map((c, i) => (
          <Sequence key={c.src} from={c.from} durationInFrames={c.durationInFrames} layout="none">
            <OffthreadVideo
              src={staticFile(c.src)}
              muted
              style={{ position: "absolute", left: 0, top: 0, width, height: videoH, opacity: shown[i] }}
            />
          </Sequence>
        ))}
      </div>
    </div>
  );
};
