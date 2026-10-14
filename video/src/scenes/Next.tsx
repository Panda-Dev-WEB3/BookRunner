import { Easing, interpolateColors, spring, useCurrentFrame } from "remotion";
import { COPY } from "../copy";
import { FONT } from "../fonts";
import { BASE, C, FPS, type Format } from "../theme";
import { withAlpha } from "../ui/color";
import { LogoDisc } from "../ui/LogoDisc";
import { contentBox } from "../ui/Stage";
import { Body, Headline, Label } from "../ui/Text";
import { ramp, rise } from "../ui/motion";

const T = COPY.next;
/** Scene-local frames: the marker travels the route (30–190), the brand block rises (200+), the disclaimer lands (300+) and holds. */
const AT = { panel: 0, travel: [30, 190], markerOut: [192, 216], brand: 200, url: 214, x: 226, disclaimer: 300 } as const;

type Pt = [number, number];

type Geo = {
  /** Route panel: everything on it runs on `network`, from today's testnet to the mainnet launch. */
  panel: { x: number; y: number; w: number; h: number; pad: number };
  /** Stop centres, in order. */
  stops: Pt[];
  vertical: boolean;
  /** Stop label box width (horizontal) and font size. */
  labelW: number;
  font: number;
  dot: number;
  /** The last stop's ring is drawn a little larger (the destination), except on the vertical route where every ring is one size. */
  bigLast: boolean;
  /** Logo disc diameter and top. */
  logo: { size: number; top: number };
  urlTop: number;
  xGap: number;
};

/** Landscape and square: the route runs left to right; portrait: top to bottom. The brand block sits under the panel. */
function geometry(format: Format): Geo {
  const { W } = contentBox(format);
  const font = Math.round(BASE[format] * 0.7);
  if (format === "portrait") {
    const panel = { x: 0, y: 130, w: W, h: 470, pad: 40 };
    const x = panel.x + 90;
    const y0 = panel.y + 170;
    return {
      panel,
      stops: [0, 1, 2].map((i) => [x, y0 + i * 130] as Pt),
      vertical: true,
      labelW: W - 160,
      font,
      dot: 18,
      bigLast: false,
      logo: { size: 320, top: 730 },
      urlTop: 1090,
      xGap: 18,
    };
  }
  const landscape = format === "landscape";
  const panel = landscape ? { x: 90, y: 0, w: W - 180, h: 260, pad: 32 } : { x: 0, y: 0, w: W, h: 300, pad: 30 };
  // Stops sit well inside the panel so the longest label ("Guarded mainnet launch") keeps clear of its edge.
  const spacing = landscape ? 480 : 270;
  const ty = panel.y + (landscape ? 128 : 124);
  return {
    panel,
    stops: [0, 1, 2].map((i) => [W / 2 + (i - 1) * spacing, ty] as Pt),
    vertical: false,
    labelW: landscape ? 440 : 260,
    font,
    dot: 16,
    bigLast: true,
    logo: landscape ? { size: 196, top: 304 } : { size: 170, top: 336 },
    urlTop: landscape ? 526 : 530,
    xGap: 14,
  };
}

/** Scene 9 (450 frames): the route ahead on Robinhood Chain, then the logo, site and handle; the disclaimer holds to the end. */
export const Next: React.FC<{ format: Format }> = ({ format }) => {
  const frame = useCurrentFrame();
  const g = geometry(format);
  const n = g.stops.length;
  // Marker position along the route, in stop units (0 = today, n - 1 = mainnet launch).
  const pos = (n - 1) * ramp(frame, AT.travel[0], AT.travel[1], Easing.inOut(Easing.cubic));
  const at = (u: number): Pt => {
    const i = Math.min(n - 2, Math.floor(u));
    const t = u - i;
    return [g.stops[i][0] + (g.stops[i + 1][0] - g.stops[i][0]) * t, g.stops[i][1] + (g.stops[i + 1][1] - g.stops[i][1]) * t];
  };
  const m = at(pos);
  const first = g.stops[0];
  const lastStop = g.stops[n - 1];
  // A planned stop brightens as the marker reaches it but stays hollow: only today's stop is filled.
  const reached = (i: number) => ramp(pos, i - 0.12, i);
  const markerOpacity = 1 - ramp(frame, AT.markerOut[0], AT.markerOut[1]);
  const tail = at(Math.max(0, pos - 0.45));
  const breathe = 0.5 - 0.5 * Math.cos((frame / FPS) * Math.PI); // today's stop: a slow halo, 2 s period

  const grow = spring({ frame: frame - AT.brand, fps: FPS, config: { damping: 200 }, durationInFrames: 40 });
  const logoIn = ramp(frame, AT.brand, AT.brand + 20);
  const discSize = Math.max(28, Math.round(BASE[format] * 0.58));

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {/* Route panel */}
      <div
        style={{
          position: "absolute",
          left: g.panel.x,
          top: g.panel.y,
          width: g.panel.w,
          height: g.panel.h,
          boxSizing: "border-box",
          borderRadius: 18,
          border: `1.5px solid ${C.line}`,
          background: withAlpha(C.panel, 0.6),
          ...rise(frame, AT.panel),
        }}
      >
        <Label
          format={format}
          size={Math.round(BASE[format] * 0.6)}
          style={{ position: "absolute", left: 0, right: 0, top: g.panel.pad, textAlign: "center" }}
        >
          {T.network}
        </Label>
      </div>

      <div style={{ position: "absolute", inset: 0, ...rise(frame, AT.panel + 6) }}>
        <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          <defs>
            <linearGradient id="next-trail" gradientUnits="userSpaceOnUse" x1={tail[0]} y1={tail[1]} x2={m[0]} y2={m[1]}>
              <stop offset="0" stopColor={C.light} stopOpacity={0} />
              <stop offset="1" stopColor={C.light} stopOpacity={1} />
            </linearGradient>
          </defs>
          {/* The route is planned (dashed) all the way; the marker previews it with a short fading trail. */}
          <line x1={first[0]} y1={first[1]} x2={lastStop[0]} y2={lastStop[1]} stroke={C.line} strokeWidth={4} strokeDasharray="12 10" strokeLinecap="round" />
          {pos > 0.01 ? (
            <line x1={tail[0]} y1={tail[1]} x2={m[0]} y2={m[1]} stroke="url(#next-trail)" strokeWidth={4} strokeLinecap="round" opacity={markerOpacity} />
          ) : null}
          {/* Today: filled, with a slow halo. */}
          <circle cx={first[0]} cy={first[1]} r={g.dot + 8 + 8 * breathe} fill={withAlpha(C.light, 0.08 + 0.1 * (1 - breathe))} />
          {g.stops.map(([x, y], i) => {
            if (i === 0) return <circle key={i} cx={x} cy={y} r={g.dot} fill={C.light} />;
            const on = reached(i);
            const r = g.bigLast && i === n - 1 ? g.dot + 4 : g.dot;
            return (
              <g key={i}>
                <circle cx={x} cy={y} r={r} fill={C.bg} stroke={interpolateColors(on, [0, 1], [C.muted, C.light])} strokeWidth={4} />
                {/* A ring flashes out from each stop as the marker reaches it. */}
                <circle cx={x} cy={y} r={r + 22 * on} fill="none" stroke={C.light} strokeWidth={2.5} opacity={on * (1 - on) * 4 * 0.8} />
              </g>
            );
          })}
          {/* Marker */}
          <g opacity={markerOpacity}>
            <circle cx={m[0]} cy={m[1]} r={g.dot * 1.9} fill={withAlpha(C.light, 0.18)} />
            <circle cx={m[0]} cy={m[1]} r={g.dot * 0.75} fill={C.cream} />
          </g>
        </svg>
        {g.stops.map(([x, y], i) => {
          const on = i === 0 ? 1 : reached(i);
          const color = interpolateColors(on, [0, 1], [C.muted, C.cream]);
          const common = { fontFamily: FONT.sans, fontWeight: 600, fontSize: g.font, lineHeight: 1.25, color } as const;
          return g.vertical ? (
            <div key={T.steps[i]} style={{ position: "absolute", left: x + 60, top: y, width: g.labelW, transform: "translateY(-50%)", ...common }}>
              {T.steps[i]}
            </div>
          ) : (
            <div key={T.steps[i]} style={{ position: "absolute", left: x - g.labelW / 2, top: y + g.dot + 26, width: g.labelW, textAlign: "center", textWrap: "balance", ...common }}>
              {T.steps[i]}
            </div>
          );
        })}
      </div>

      {/* Brand block */}
      {frame >= AT.brand ? (
        <>
          <LogoDisc
            size={g.logo.size}
            style={{
              position: "absolute",
              left: `calc(50% - ${g.logo.size / 2}px)`,
              top: g.logo.top,
              opacity: logoIn,
              transform: `scale(${0.9 + 0.1 * grow})`,
            }}
          />
          <div style={{ position: "absolute", left: 0, right: 0, top: g.urlTop, display: "flex", flexDirection: "column", alignItems: "center", gap: g.xGap }}>
            <Headline format={format} style={rise(frame, AT.url)}>
              {T.url}
            </Headline>
            <Label format={format} size={Math.round(BASE[format] * 0.65)} style={{ letterSpacing: "0.06em", textTransform: "none", ...rise(frame, AT.x) }}>
              {T.x}
            </Label>
          </div>
        </>
      ) : null}

      {/* Disclaimer: small but high-contrast (light, not muted), held to the last frame (Overview does not fade the closing scene out). */}
      <Body
        format={format}
        size={discSize}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          color: C.light,
          textAlign: "center",
          textWrap: "balance",
          opacity: ramp(frame, AT.disclaimer, AT.disclaimer + 20),
        }}
      >
        {/* Hyphenated words (e.g. "Stock-perp") never break at the hyphen. */}
        {T.disclaimer.split(/(\S+-\S+)/).map((part, i) => (i % 2 ? <span key={i} style={{ whiteSpace: "nowrap" }}>{part}</span> : part))}
      </Body>
    </div>
  );
};
