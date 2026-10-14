import { AbsoluteFill } from "remotion";
import { C, FORMATS, type Format } from "../theme";

/** Safe padding (px) keeping content off the edges, per format. */
export const PAD: Record<Format, { x: number; y: number }> = {
  landscape: { x: 120, y: 120 },
  square: { x: 90, y: 90 },
  portrait: { x: 90, y: 160 },
};

/** Size of the content box inside the safe padding (the coordinate space of scene layouts and `Flow`). */
export function contentBox(format: Format): { W: number; H: number } {
  return { W: FORMATS[format].width - 2 * PAD[format].x, H: FORMATS[format].height - 2 * PAD[format].y };
}

const GRID = "rgba(140,165,230,0.07)";

/** Full-frame brand background (navy radial gradient + faint 64px grid) with safe padding around children. */
export const Stage: React.FC<{ format: Format; children?: React.ReactNode }> = ({ format, children }) => {
  const pad = PAD[format];
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse 75% 75% at 30% 45%, ${C.panel} 0%, ${C.bg} 60%, ${C.deep} 100%)`,
      }}
    >
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${GRID} 1px, transparent 1px), linear-gradient(90deg, ${GRID} 1px, transparent 1px)`,
          backgroundSize: "64px 64px",
        }}
      />
      <AbsoluteFill style={{ padding: `${pad.y}px ${pad.x}px`, color: C.cream }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};
