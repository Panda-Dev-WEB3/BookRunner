import { useCurrentFrame } from "remotion";
import { FONT } from "../fonts";
import { C } from "../theme";
import { withAlpha } from "../ui/color";
import { fadeInOut, rise } from "../ui/motion";
import { DEMO_TIMING } from "./segments";

/** Caption type size (px): two lines at most for the 90-character captions within MAX_W. */
const SIZE = 34;
const MAX_W = 1240;

/**
 * Lower-third caption for one step, rendered inside a Sequence spanning the caption's window (`frames` long): fades
 * in and out over `captionFadeFrames`, with progress dots and a step counter above the text. Sits bottom-left over the
 * recording, kept compact so it covers as little of the page as it can.
 */
export const Caption: React.FC<{ text: string; index: number; count: number; frames: number }> = ({ text, index, count, frames }) => {
  const frame = useCurrentFrame();
  const fade = DEMO_TIMING.captionFadeFrames;
  const opacity = fadeInOut(frame, frames, fade, fade);
  const { transform } = rise(frame);
  return (
    <div
      style={{
        position: "absolute",
        left: 48,
        bottom: 36,
        maxWidth: MAX_W,
        boxSizing: "border-box",
        padding: "13px 30px 16px 26px",
        borderRadius: 14,
        borderLeft: `6px solid ${C.blue}`,
        background: withAlpha(C.deep, 0.92),
        boxShadow: `0 0 0 1.5px ${C.line}, 0 18px 48px ${withAlpha(C.deep, 0.55)}`,
        opacity,
        transform,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 6 }}>
        <div style={{ display: "flex", gap: 6 }}>
          {Array.from({ length: count }, (_, i) => (
            <div
              key={i}
              style={{
                width: i === index ? 22 : 7,
                height: 7,
                borderRadius: 4,
                background: i <= index ? C.light : withAlpha(C.light, 0.25),
              }}
            />
          ))}
        </div>
        <div style={{ fontFamily: FONT.sans, fontWeight: 500, fontSize: 17, letterSpacing: "0.12em", color: C.muted }}>
          {String(index + 1).padStart(2, "0")} / {String(count).padStart(2, "0")}
        </div>
      </div>
      <div
        style={{
          fontFamily: FONT.sans,
          fontWeight: 500,
          fontSize: SIZE,
          lineHeight: 1.25,
          color: C.cream,
          textWrap: "balance",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {text}
      </div>
    </div>
  );
};
