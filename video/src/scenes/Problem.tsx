import { useCurrentFrame } from "remotion";
import { FONT } from "../fonts";
import { COPY } from "../copy";
import { BASE, C, type Format } from "../theme";
import { Node } from "../ui/Node";
import { Body, Headline } from "../ui/Text";
import { rise } from "../ui/motion";

const T = COPY.problem;
const APPEAR = [40, 70] as const;
/** Glyph inside each empty slot (a symbol, not copy). */
const UNKNOWN = "?";

/** Per format: whether the two needs sit side by side, and whether each need stacks its slot under the node. */
const LAYOUT: Record<Format, { side: boolean; unitColumn: boolean; slot: number; gap: number }> = {
  landscape: { side: true, unitColumn: true, slot: 260, gap: 120 },
  square: { side: false, unitColumn: false, slot: 150, gap: 36 },
  portrait: { side: false, unitColumn: true, slot: 250, gap: 70 },
};

/** Split `today` into lead-in, emphasised last clause (after ", and ") and trailing punctuation; no copy strings here. */
function splitToday(s: string): [string, string, string] {
  const m = /^(.*, and )(.*?)([.!]?)$/.exec(s);
  return m ? [m[1], m[2], m[3]] : [s, "", ""];
}

/** Scene 2 (450 frames): a new market needs two kinds of capital, and today nobody underwrites either. */
export const Problem: React.FC<{ format: Format }> = ({ format }) => {
  const frame = useCurrentFrame();
  const L = LAYOUT[format];
  const base = BASE[format];
  const [lead, emphasis, tail] = splitToday(T.today);

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      <Headline format={format} style={{ textWrap: "balance", ...rise(frame, 0) }}>
        {T.title}
      </Headline>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", flexDirection: L.side ? "row" : "column", gap: L.gap, width: "100%" }}>
          {T.needs.map((need, i) => {
            const t = frame - APPEAR[i];
            // Slow pulse (1.6 s period) on the question mark, starting once the need is on screen.
            const pulse = t > 0 ? 0.5 + 0.5 * Math.sin((t / 48) * Math.PI * 2 - Math.PI / 2) : 0;
            return (
              <div
                key={need}
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: L.unitColumn ? "column" : "row",
                  gap: L.unitColumn ? 18 : 24,
                  ...rise(frame, APPEAR[i]),
                }}
              >
                <Node
                  format={format}
                  title={need}
                  style={{
                    flex: L.unitColumn ? undefined : "0 0 52%",
                    height: L.unitColumn ? undefined : L.slot,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                  }}
                />
                <div
                  style={{
                    boxSizing: "border-box",
                    flex: L.unitColumn ? undefined : 1,
                    height: L.slot,
                    border: `3px dashed ${C.line}`,
                    borderRadius: 18,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <div
                    style={{
                      fontFamily: FONT.serif,
                      fontWeight: 600,
                      fontSize: Math.round(base * (L.slot >= 200 ? 2.4 : 1.8)),
                      lineHeight: 1,
                      color: C.light,
                      opacity: 0.4 + 0.6 * pulse,
                      transform: `scale(${0.94 + 0.08 * pulse})`,
                    }}
                  >
                    {UNKNOWN}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <Body
        format={format}
        size={Math.round(base * 0.85)}
        style={{ color: C.muted, textWrap: "balance", ...rise(frame, 220) }}
      >
        {lead}
        {emphasis ? <span style={{ color: C.cream, fontWeight: 600 }}>{emphasis}</span> : null}
        {tail}
      </Body>
    </div>
  );
};
