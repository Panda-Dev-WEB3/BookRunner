// Small-multiple line (sparkline with axis extents, reference lines and a hover crosshair).
// The SVG scales to its box; dots and the tooltip are HTML overlays so they never distort.
import { useMemo, useRef, useState } from "react";
import { fmtDateTime } from "../../lib/format";
import { paddedDomain } from "../../lib/nav";

export interface MiniPoint {
  t: number;
  v: number;
}

export function MiniLine(props: {
  data: MiniPoint[];
  color?: string;
  height?: number;
  format: (v: number) => string;
  refLines?: Array<{ v: number; label: string; tone?: "limit" | "band" }>;
  band?: [number, number];
  domain?: [number, number];
  ariaLabel: string;
  emptyText?: string;
}) {
  const h = props.height ?? 64;
  const color = props.color ?? "var(--accent)";
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const geo = useMemo(() => {
    const d = props.data.filter((p) => Number.isFinite(p.v) && Number.isFinite(p.t));
    if (d.length === 0) return null;
    const refs = (props.refLines ?? []).map((r) => r.v);
    const [lo, hi] = props.domain ?? paddedDomain([...d.map((p) => p.v), ...refs, ...(props.band ?? [])], 0.1);
    const t0 = d[0]?.t ?? 0;
    const t1 = d[d.length - 1]?.t ?? 1;
    const x = (t: number) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * 100 : 50);
    const y = (v: number) => (hi > lo ? (1 - (v - lo) / (hi - lo)) * 100 : 50);
    const pts = d.map((p) => ({ ...p, x: x(p.t), y: y(p.v) }));
    const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(3)},${p.y.toFixed(3)}`).join("");
    const area = `${line}L${pts[pts.length - 1]?.x.toFixed(3)},100L${pts[0]?.x.toFixed(3)},100Z`;
    return { pts, line, area, lo, hi, y };
  }, [props.data, props.domain, props.refLines, props.band]);

  if (!geo) {
    return (
      <div className="flex items-center justify-center rounded-control border border-dashed border-line text-[11px] text-muted" style={{ height: h }}>
        {props.emptyText ?? "No data yet"}
      </div>
    );
  }
  const last = geo.pts[geo.pts.length - 1];
  const hp = hover !== null ? geo.pts[hover] : null;

  const onMove = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const xPct = ((clientX - r.left) / r.width) * 100;
    let best = 0;
    let bd = Number.POSITIVE_INFINITY;
    geo.pts.forEach((p, i) => {
      const dd = Math.abs(p.x - xPct);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    setHover(best);
  };

  return (
    <div className="relative select-none pr-12" style={{ height: h }} role="img" aria-label={props.ariaLabel}>
      <div ref={ref} className="relative h-full" onPointerMove={(e) => onMove(e.clientX)} onPointerLeave={() => setHover(null)}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
        {props.band && (
          <rect x="0" width="100" y={geo.y(props.band[1])} height={Math.max(0, geo.y(props.band[0]) - geo.y(props.band[1]))} fill="var(--good)" opacity="0.12" />
        )}
        {(props.refLines ?? []).map((r) => (
          <line
            key={r.label}
            x1="0"
            x2="100"
            y1={geo.y(r.v)}
            y2={geo.y(r.v)}
            stroke={r.tone === "band" ? "var(--good)" : "var(--critical)"}
            strokeWidth="1"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
            opacity="0.8"
          />
        ))}
        <path d={geo.area} fill={color} opacity="0.1" />
        <path d={geo.line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {hp && <line x1={hp.x} x2={hp.x} y1="0" y2="100" stroke="var(--line-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
      </svg>
      {last && (
        <span
          className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface"
          style={{ left: `${last.x}%`, top: `${last.y}%`, background: color }}
          aria-hidden
        />
      )}
      {hp && (
        <>
          <span
            className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface"
            style={{ left: `${hp.x}%`, top: `${hp.y}%`, background: color }}
            aria-hidden
          />
          <div
            className="pointer-events-none absolute -top-1 z-10 -translate-y-full rounded-control border border-line-strong bg-surface px-1.5 py-1 text-[11px] whitespace-nowrap shadow-sm"
            style={{ left: `${Math.min(Math.max(hp.x, 18), 82)}%`, transform: "translate(-50%, -100%)" }}
          >
            <div className="num font-medium">{props.format(hp.v)}</div>
            <div className="num text-muted">{fmtDateTime(hp.t)}</div>
          </div>
        </>
      )}
      </div>
      <div className="num pointer-events-none absolute top-0 right-0 w-11 text-right text-[10px] leading-none text-muted">{props.format(geo.hi)}</div>
      <div className="num pointer-events-none absolute right-0 bottom-0 w-11 text-right text-[10px] leading-none text-muted">{props.format(geo.lo)}</div>
    </div>
  );
}
