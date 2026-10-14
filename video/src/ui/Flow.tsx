import { interpolate, useCurrentFrame } from "remotion";
import { FPS } from "../theme";

type Pt = [number, number];
type Props = {
  from: Pt;
  to: Pt;
  color: string;
  /** Frame (scene-local) at which the stream starts to appear. */
  start?: number;
  /** Number of particles on the path. */
  count?: number;
  /** Path lengths travelled per second. */
  speed?: number;
  /** Particle radius in px. */
  radius?: number;
};

/** Point on the quadratic curve from `a` to `b`, bowed sideways by 12% of its length. */
function curve(a: Pt, b: Pt, t: number): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const c: Pt = [(a[0] + b[0]) / 2 - dy * 0.12, (a[1] + b[1]) / 2 + dx * 0.12];
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]];
}

/** Stream of small circles (coordinates are relative to the Stage content box, inside its padding) drifting from `from` to `to`, fading in and out along the path. */
export const Flow: React.FC<Props> = ({ from, to, color, start = 0, count = 12, speed = 0.3, radius = 6 }) => {
  const frame = useCurrentFrame();
  const t0 = frame - start;
  if (t0 < 0) return null;
  const appear = interpolate(t0, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  return (
    <svg width="100%" height="100%" style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}>
      {Array.from({ length: count }, (_, i) => {
        const t = (i / count + (t0 / FPS) * speed) % 1;
        const [x, y] = curve(from, to, t);
        const edge = Math.sin(Math.PI * t); // soft at both ends of the path
        return <circle key={i} cx={x} cy={y} r={radius} fill={color} opacity={appear * edge} />;
      })}
    </svg>
  );
};

/**
 * Orthogonal route through `points` with each inner corner rounded by `radius` (clamped to half of either leg),
 * returned as a dense polyline so a drawn line and the particles on it follow exactly the same curve.
 */
export function roundedRoute(points: readonly Pt[], radius: number): Pt[] {
  if (points.length < 3) return [...points];
  const out: Pt[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [p, c, n] = [points[i - 1], points[i], points[i + 1]];
    const l1 = Math.hypot(c[0] - p[0], c[1] - p[1]);
    const l2 = Math.hypot(n[0] - c[0], n[1] - c[1]);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const a: Pt = [c[0] + ((p[0] - c[0]) / l1) * r, c[1] + ((p[1] - c[1]) / l1) * r];
    const b: Pt = [c[0] + ((n[0] - c[0]) / l2) * r, c[1] + ((n[1] - c[1]) / l2) * r];
    // Quadratic Bezier a -> b with control point at the corner, sampled.
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      const u = 1 - t;
      out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Point at arc-length fraction `t` (0-1) along a polyline with cumulative lengths `cum`. */
function along(path: readonly Pt[], cum: readonly number[], t: number): Pt {
  const d = t * cum[cum.length - 1];
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const f = (d - cum[i - 1]) / seg;
  return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * f, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * f];
}

/**
 * A connector: a faint track along `path` (box edge to box edge, coordinates in the Stage content box) that draws on
 * from `start`, with particles travelling it at `speed` px/s, `spacing` px apart, fading in and out at its ends.
 */
export const PathFlow: React.FC<{
  path: readonly Pt[];
  color: string;
  start?: number;
  speed?: number;
  spacing?: number;
  radius?: number;
  track?: number;
}> = ({ path, color, start = 0, speed = 90, spacing = 28, radius = 6, track = 2.5 }) => {
  const frame = useCurrentFrame();
  const t0 = frame - start;
  if (t0 < 0) return null;
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const len = cum[cum.length - 1];
  const draw = interpolate(t0, [0, 18], [0, 1], { extrapolateRight: "clamp" });
  const count = Math.max(2, Math.round(len / spacing));
  const fade = Math.min(0.45, 24 / len); // fraction of the path over which particles fade at either end
  const d = path.map(([x, y], i) => `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg width="100%" height="100%" style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none" }}>
      <path d={d} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={track} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
      {draw >= 1
        ? Array.from({ length: count }, (_, i) => {
            const t = (i / count + ((t0 - 18) / FPS) * (speed / len)) % 1;
            const [x, y] = along(path, cum, t);
            const edge = Math.min(1, t / fade, (1 - t) / fade);
            const appear = interpolate(t0, [18, 30], [0, 1], { extrapolateRight: "clamp" });
            return <circle key={i} cx={x} cy={y} r={radius} fill={color} opacity={appear * edge} />;
          })
        : null}
    </svg>
  );
};
