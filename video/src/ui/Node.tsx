import type { CSSProperties } from "react";
import { FONT } from "../fonts";
import { BASE, C, type Format } from "../theme";

type Props = { format: Format; title: string; note?: string; style?: CSSProperties };

/** Rounded panel box with a title and an optional muted note. Position and size it through `style`. */
export const Node: React.FC<Props> = ({ format, title, note, style }) => (
  <div
    style={{
      boxSizing: "border-box",
      background: C.panel,
      border: `1.5px solid ${C.line}`,
      borderRadius: 18,
      padding: `${Math.round(BASE[format] * 0.5)}px ${Math.round(BASE[format] * 0.65)}px`,
      fontFamily: FONT.sans,
      ...style,
    }}
  >
    <div style={{ fontWeight: 600, fontSize: Math.round(BASE[format] * 0.75), lineHeight: 1.25, color: C.cream }}>
      {title}
    </div>
    {note ? (
      <div
        style={{
          fontWeight: 400,
          fontSize: Math.round(BASE[format] * 0.55),
          lineHeight: 1.35,
          color: C.muted,
          marginTop: 8,
        }}
      >
        {note}
      </div>
    ) : null}
  </div>
);
