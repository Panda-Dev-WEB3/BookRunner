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
