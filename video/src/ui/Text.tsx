import type { CSSProperties, ReactNode } from "react";
import { FONT } from "../fonts";
import { BASE, C, type Format } from "../theme";

type Props = { format: Format; size?: number; style?: CSSProperties; children?: ReactNode };

/** Serif 600 headline. `size` is px; defaults to 1.5x the base size of the format. */
export const Headline: React.FC<Props> = ({ format, size = Math.round(BASE[format] * 1.5), style, children }) => (
  <div
    style={{
      fontFamily: FONT.serif,
      fontWeight: 600,
      fontSize: size,
      lineHeight: 1.15,
      letterSpacing: "-0.01em",
      color: C.cream,
      ...style,
    }}
  >
    {children}
  </div>
);

/** Small uppercase sans 500 label with wide tracking. Defaults to 0.5x the base size. */
export const Label: React.FC<Props> = ({ format, size = Math.round(BASE[format] * 0.5), style, children }) => (
  <div
    style={{
      fontFamily: FONT.sans,
      fontWeight: 500,
      fontSize: size,
      lineHeight: 1.3,
      letterSpacing: "0.16em",
      textTransform: "uppercase",
      color: C.light,
      ...style,
    }}
  >
    {children}
  </div>
);

/** Sans 400 body copy. Defaults to the base size of the format. */
export const Body: React.FC<Props> = ({ format, size = BASE[format], style, children }) => (
  <div
    style={{ fontFamily: FONT.sans, fontWeight: 400, fontSize: size, lineHeight: 1.35, color: C.cream, ...style }}
  >
    {children}
  </div>
);
