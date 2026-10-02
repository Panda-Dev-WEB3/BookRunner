// Two small inline diagrams of a book's waterfall: fee flow pays down (expenses, carry, Senior's
// share, Junior's residual) and losses climb up (Junior first, then Senior, then the backstop up to
// its pool). Fixed colour coding (lib/palette.ts) and every box labelled, so colour is never the
// only cue. Each SVG is about as wide as a phone column, so the 13px labels stay legible.
import { useId } from "react";
import { SERIES } from "../../lib/palette";

const W = 320;
const BOX_H = 38;

function Box(props: { x: number; y: number; w: number; label: string; sub?: string; color: string | null; dashed?: boolean }) {
  const fill = props.color ?? "var(--surface-3)";
  const stroke = props.color ?? "var(--line-strong)";
  return (
    <g>
      <rect
        x={props.x}
        y={props.y}
        width={props.w}
        height={BOX_H}
        rx={8}
        style={{ fill, fillOpacity: props.color ? 0.14 : 1, stroke, strokeWidth: 1.5, strokeDasharray: props.dashed ? "5 4" : undefined }}
      />
      <text x={props.x + props.w / 2} y={props.y + (props.sub ? 16 : 24)} textAnchor="middle" style={{ fill: "var(--ink)", fontSize: 13, fontWeight: 600 }}>
        {props.label}
      </text>
      {props.sub && (
        <text x={props.x + props.w / 2} y={props.y + 31} textAnchor="middle" style={{ fill: "var(--ink-2)", fontSize: 11.5 }}>
          {props.sub}
        </text>
      )}
    </g>
  );
}

function Arrow(props: { x: number; y1: number; y2: number; color: string }) {
  const up = props.y2 < props.y1;
  const tip = props.y2;
  const back = up ? tip + 7 : tip - 7;
  return (
    <g style={{ stroke: props.color, fill: props.color }}>
      <line x1={props.x} y1={props.y1} x2={props.x} y2={back} style={{ strokeWidth: 2 }} />
      <path d={`M${props.x - 5} ${back} L${props.x + 5} ${back} L${props.x} ${tip} Z`} style={{ stroke: "none" }} />
    </g>
  );
}

/** Fee flow pays down: expenses, then the carry, then Senior's share, then Junior's residual. */
export function FeeFlowDiagram({ carryPct, className }: { carryPct?: string | null; className?: string }) {
  const H = 212;
  const id = useId();
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} role="img" aria-labelledby={`${id}-t ${id}-d`} width="100%">
      <title id={`${id}-t`}>Fee flow pays down</title>
      <desc id={`${id}-d`}>
        The market's fee flow pays expenses first, then the protocol carry, then Senior's share of what is left; Junior receives the rest.
      </desc>
      <Box x={20} y={4} w={280} label="Fee flow from the market" color={SERIES.fee} />
      <Arrow x={160} y1={42} y2={58} color={SERIES.fee} />
      <Box x={20} y={58} w={280} label="1. Expenses, capped on-chain" sub="oracle and keeper gas" color={null} />
      <Arrow x={160} y1={96} y2={112} color={SERIES.fee} />
      <Box x={20} y={112} w={280} label={`2. Protocol carry${carryPct ? ` (${carryPct})` : ""}`} sub="half to the backstop, half to BKRN stakers" color={SERIES.backstop} />
      <Arrow x={90} y1={150} y2={168} color={SERIES.fee} />
      <Arrow x={230} y1={150} y2={168} color={SERIES.fee} />
      <Box x={20} y={168} w={136} label="3. Senior" sub="its share, first" color={SERIES.senior} />
      <Box x={164} y={168} w={136} label="4. Junior" sub="the rest" color={SERIES.junior} />
    </svg>
  );
}

/** Losses climb up: Junior first, then Senior, then the backstop (up to what its pool holds). */
export function LossOrderDiagram({ className }: { className?: string }) {
  const H = 212;
  const id = useId();
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} role="img" aria-labelledby={`${id}-t ${id}-d`} width="100%">
      <title id={`${id}-t`}>Losses climb up</title>
      <desc id={`${id}-d`}>Losses are absorbed by Junior first. Only once Junior is used up do they reach Senior, and the backstop may then cover Senior up to what its pool holds.</desc>
      <Box x={52} y={4} w={248} label="3. Backstop pool" sub="covers Senior, up to what it holds" color={SERIES.backstop} dashed />
      <Box x={52} y={60} w={248} label="2. Senior" sub="only once Junior is used up" color={SERIES.senior} />
      <Box x={52} y={116} w={248} label="1. Junior" sub="absorbs losses first" color={SERIES.junior} />
      <Box x={52} y={172} w={248} label="Losses from the market" color={SERIES.loss} />
      <Arrow x={26} y1={206} y2={10} color={SERIES.loss} />
    </svg>
  );
}
