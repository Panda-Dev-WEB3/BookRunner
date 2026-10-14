import { Easing, Img, interpolate, spring, staticFile, useCurrentFrame } from "remotion";
import { COPY } from "../copy";
import { BASE, FPS, type Format } from "../theme";
import { Headline, Label } from "../ui/Text";
import { rise, stagger } from "../ui/motion";

const T = COPY.hook;
/** Max line width for the opening line, so it breaks into balanced lines rather than one long run. */
const LINE_WIDTH: Record<Format, number> = { landscape: 1300, square: 900, portrait: 900 };
const LOGO: Record<Format, number> = { landscape: 360, square: 360, portrait: 420 };

const fill = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" } as const;

/** Scene 1 (300 frames): the opening line word by word, then the logo, brand and tagline. */
export const Hook: React.FC<{ format: Format }> = ({ format }) => {
  const frame = useCurrentFrame();
  const words = T.line.split(" ");
  // Eased so the line is nearly gone before the brand is visible: the two never read on top of each other.
  const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  const lineOut = interpolate(frame, [120, 150], [1, 0], { ...clamp, easing: Easing.out(Easing.quad) });
  const brandIn = interpolate(frame, [140, 170], [0, 1], { ...clamp, easing: Easing.in(Easing.quad) });
  const grow = spring({ frame: frame - 140, fps: FPS, config: { damping: 200 }, durationInFrames: 45 });
  const tagline = rise(frame, 175);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {lineOut > 0 ? (
        <div style={{ ...fill, opacity: lineOut }}>
          <Headline
            format={format}
            size={Math.round(BASE[format] * 1.5)}
            style={{ maxWidth: LINE_WIDTH[format], textAlign: "center", textWrap: "balance" }}
          >
            {words.map((w, i) => (
              <span key={i}>
                <span style={{ display: "inline-block", ...rise(frame, 6 + stagger(i, 8)) }}>{w}</span>
                {i < words.length - 1 ? " " : null}
              </span>
            ))}
          </Headline>
        </div>
      ) : null}
      {frame >= 140 ? (
        <div style={{ ...fill, flexDirection: "column", opacity: brandIn }}>
          <Label format={format} size={Math.round(BASE[format] * 0.7)} style={{ marginBottom: 4 }}>
            {T.brand}
          </Label>
          <Img
            src={staticFile("logo.png")}
            style={{ width: LOGO[format], height: LOGO[format], transform: `scale(${0.9 + 0.1 * grow})` }}
          />
          <Headline format={format} size={Math.round(BASE[format] * 2.2)} style={{ marginTop: 36, ...tagline }}>
            {T.tagline}
          </Headline>
        </div>
      ) : null}
    </div>
  );
};
