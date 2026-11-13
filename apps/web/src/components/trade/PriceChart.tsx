// The market's oracle price over 1D / 1W / 1M (trade.history: one-minute candles of the signed price, downsampled by
// the API). Inline SVG, no chart library (the app's CSP allows no external script or font): the close per step as one
// line, held stretches (session closed) dashed, gaps in the record left open; a crosshair with the step's OHLC; the
// range's open, close, high, low and change above; the steps as a table on demand.
import { useMemo, useRef, useState } from "react";
import { useOptional } from "../../api/hooks";
import type { TradeHistoryOut, TradeMarket } from "../../lib/api-types";
import { fmtDateTime, fmtPrice, fmtTime, fmtWhen } from "../../lib/format";
import { cx } from "../cx";
import { Card, ErrorState, Legend, Segmented, Skeleton } from "../ui";
import { HISTORY_RANGE_OPTIONS, type HistoryRange, chartPoints, chartRuns, historySummary } from "./historyLogic";

const H = 200;
const parseHistory = (raw: unknown): TradeHistoryOut | null => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as TradeHistoryOut) : null);

export function useTradeHistory(marketId: number, range: HistoryRange) {
  return useOptional("trade.history", { marketId, range }, parseHistory, { refetchInterval: range === "1D" ? 30_000 : 120_000, enabled: marketId > 0 });
}

function Plot({ h, label }: { h: TradeHistoryOut; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const geo = useMemo(() => {
    const pts = chartPoints(h.points);
    if (pts.length === 0) return null;
    const t0 = Date.parse(h.from) / 1000;
    const t1 = Math.max(Date.parse(h.to) / 1000, (pts[pts.length - 1]?.t ?? t0) + 1);
    const vs = h.points.flatMap((p) => [Number(p.high), Number(p.low)]).filter((v) => Number.isFinite(v) && v > 0);
    const lo0 = Math.min(...vs);
    const hi0 = Math.max(...vs);
    const pad = (hi0 - lo0 || hi0 * 0.01) * 0.08;
    const lo = lo0 - pad;
    const hi = hi0 + pad;
    const x = (t: number) => ((t - t0) / (t1 - t0)) * 100;
    const y = (v: number) => (1 - (v - lo) / (hi - lo)) * 100;
    const runs = chartRuns(pts, h.stepSeconds).map((r) => ({ held: r.held, d: r.points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(3)},${y(p.v).toFixed(3)}`).join("") }));
    return { pts: pts.map((p) => ({ ...p, x: x(p.t), y: y(p.v) })), runs, lo: lo0, hi: hi0, y, t0, t1 };
  }, [h]);

  if (!geo) {
    return (
      <div className="flex items-center justify-center rounded-control border border-dashed border-line text-[12px] text-muted" style={{ height: H }}>
        No price recorded in this range yet.
      </div>
    );
  }
  const hp = hover !== null ? geo.pts[hover] : null;
  const hRow = hp ? h.points.find((p) => p.t === hp.t) : undefined;
  const last = geo.pts[geo.pts.length - 1];
  const onMove = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const xPct = ((clientX - r.left) / r.width) * 100;
    let best = 0;
    let bd = Number.POSITIVE_INFINITY;
    geo.pts.forEach((p, i) => {
      const d = Math.abs(p.x - xPct);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best);
  };
  const short = h.range === "1D";
  return (
    <div className="relative select-none pr-14" role="img" aria-label={label}>
      <div ref={ref} className="relative" style={{ height: H }} onPointerMove={(e) => onMove(e.clientX)} onPointerLeave={() => setHover(null)}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
          {[0, 50, 100].map((g) => (
            <line key={g} x1="0" x2="100" y1={g} y2={g} stroke="var(--grid)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          {geo.runs.map((r, i) => (
            <path
              key={i}
              d={r.d}
              fill="none"
              stroke={r.held ? "var(--muted)" : "var(--accent)"}
              strokeWidth="2"
              strokeDasharray={r.held ? "4 4" : undefined}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {hp && <line x1={hp.x} x2={hp.x} y1="0" y2="100" stroke="var(--line-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
        </svg>
        {last && (
          <span
            className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface"
            style={{ left: `${last.x}%`, top: `${last.y}%`, background: last.held ? "var(--muted)" : "var(--accent)" }}
            aria-hidden
          />
        )}
        {hp && hRow && (
          <>
            <span
              className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface"
              style={{ left: `${hp.x}%`, top: `${hp.y}%`, background: hp.held ? "var(--muted)" : "var(--accent)" }}
              aria-hidden
            />
            <div
              className="pointer-events-none absolute top-1 z-10 rounded-control border border-line-strong bg-surface px-2 py-1.5 text-[11px] whitespace-nowrap shadow-sm"
              style={{ left: `${Math.min(Math.max(hp.x, 16), 84)}%`, transform: "translateX(-50%)" }}
            >
              <div className="num text-muted">{fmtDateTime(hp.t * 1000)}</div>
              <div className="num font-medium text-ink">{fmtPrice(hp.v)}</div>
              <div className="num text-ink-2">
                O {fmtPrice(Number(hRow.open))} · H {fmtPrice(Number(hRow.high))} · L {fmtPrice(Number(hRow.low))}
              </div>
              {hRow.held && <div className="text-muted">Session closed (held price)</div>}
            </div>
          </>
        )}
      </div>
      <div className="num pointer-events-none absolute top-0 right-0 w-12 text-right text-[10.5px] leading-none text-muted">{fmtPrice(geo.hi)}</div>
      <div className="num pointer-events-none absolute right-0 w-12 text-right text-[10.5px] leading-none text-muted" style={{ top: H - 10 }}>
        {fmtPrice(geo.lo)}
      </div>
      <div className="num mt-1.5 flex justify-between text-[10.5px] text-muted">
        <span>{short ? fmtTime(geo.t0 * 1000) : fmtWhen(geo.t0)}</span>
        <span>{short ? fmtTime(geo.t1 * 1000) : fmtWhen(geo.t1)}</span>
      </div>
    </div>
  );
}

function StepsTable({ h }: { h: TradeHistoryOut }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="mt-3 text-[12px]" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-ink-2">Show the steps as a table</summary>
      {open && (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-control border border-line">
          <table className="w-full text-[11.5px]">
            <thead className="sticky top-0 bg-surface-2">
              <tr className="text-left text-ink-2">
                <th className="px-2 py-1 font-medium">Step start</th>
                <th className="px-2 py-1 text-right font-medium">Open</th>
                <th className="px-2 py-1 text-right font-medium">High</th>
                <th className="px-2 py-1 text-right font-medium">Low</th>
                <th className="px-2 py-1 text-right font-medium">Close</th>
                <th className="px-2 py-1 font-medium">Session</th>
              </tr>
            </thead>
            <tbody>
              {[...h.points].reverse().map((p) => (
                <tr key={p.t} className="num border-t border-line">
                  <td className="px-2 py-1">{fmtDateTime(p.t * 1000)}</td>
                  <td className="px-2 py-1 text-right">{fmtPrice(Number(p.open))}</td>
                  <td className="px-2 py-1 text-right">{fmtPrice(Number(p.high))}</td>
                  <td className="px-2 py-1 text-right">{fmtPrice(Number(p.low))}</td>
                  <td className="px-2 py-1 text-right">{fmtPrice(Number(p.close))}</td>
                  <td className="px-2 py-1">{p.held ? "closed" : "open"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

export function PriceChart({ m }: { m: TradeMarket }) {
  const [range, setRange] = useState<HistoryRange>("1D");
  const q = useTradeHistory(m.marketId, range);
  const h = q.data?.supported ? q.data.data : null;
  const s = h ? historySummary(h.points) : null;
  const name = m.name ?? m.symbol;
  const label = s
    ? `${name} oracle price over ${range}: from ${fmtPrice(s.first)} to ${fmtPrice(s.last)}, high ${fmtPrice(s.high)}, low ${fmtPrice(s.low)}`
    : `${name} oracle price over ${range}: no price recorded`;
  return (
    <Card
      title="Price"
      description="The oracle's signed price the market trades at, recorded every few seconds; each point closes a step."
      actions={<Segmented ariaLabel="Chart range" size="sm" value={range} onChange={setRange} options={HISTORY_RANGE_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))} />}
      aria-label="Price chart"
    >
      {q.data?.supported === false ? (
        <div className="flex items-center justify-center rounded-control border border-dashed border-line text-[12px] text-muted" style={{ height: H }}>
          This API does not serve price history yet.
        </div>
      ) : q.error && !h ? (
        <ErrorState compact error={q.error} onRetry={() => void q.refetch()} />
      ) : !h ? (
        <Skeleton className="h-[200px] w-full" />
      ) : (
        <>
          {s && (
            <div className="num mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px] text-ink-2">
              <span>
                <span className="text-[15px] font-semibold text-ink">{fmtPrice(s.last)}</span>{" "}
                <span className={cx(s.change > 0 ? "text-good-ink" : s.change < 0 ? "text-critical-ink" : undefined)}>
                  {s.change > 0 ? "+" : ""}
                  {(s.change * 100).toFixed(2)}% over {range}
                </span>
              </span>
              <span>High {fmtPrice(s.high)}</span>
              <span>Low {fmtPrice(s.low)}</span>
            </div>
          )}
          <Plot h={h} label={label} />
          {h.points.some((p) => p.held) && (
            <div className="mt-2">
              <Legend
                items={[
                  { label: "Session open", color: "var(--accent)" },
                  { label: "Session closed (held price)", color: "var(--muted)", dashed: true },
                ]}
              />
            </div>
          )}
          {h.points.length > 0 && <StepsTable h={h} />}
        </>
      )}
    </Card>
  );
}
