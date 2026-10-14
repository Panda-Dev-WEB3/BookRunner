import type { CSSProperties } from "react";
import { Img, staticFile } from "remotion";
import { C } from "../theme";
import { withAlpha } from "./color";

/**
 * The blue engraved logo on a cream disc with a faint halo ring and a soft shadow (the GitHub social preview's look),
 * so it reads on the navy background. `size` is the disc diameter in px; the ring sits outside it.
 */
export const LogoDisc: React.FC<{ size: number; style?: CSSProperties }> = ({ size, style }) => {
  const ring = Math.round(size * 0.04);
  return (
    <div
      style={{
        width: size,
        height: size,
        flex: "none",
        boxSizing: "border-box",
        borderRadius: "50%",
        background: C.cream,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: `0 0 0 ${ring}px ${withAlpha(C.light, 0.1)}, 0 ${Math.round(size * 0.06)}px ${Math.round(size * 0.22)}px ${withAlpha(C.deep, 0.75)}`,
        ...style,
      }}
    >
      <Img src={staticFile("logo.png")} style={{ width: Math.round(size * 0.74), height: Math.round(size * 0.74) }} />
    </div>
  );
};
