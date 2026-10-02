// Book NAV from signed marks, stacked by tranche (Senior at the base, Junior on top: the first-loss
// layer). The live estimate is drawn as a dashed extension with a hollow marker, never as a mark.
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtDateTime, fmtTime, fmtUsd } from "../../lib/format";
import { type NavPoint, hasTrancheSplit } from "../../lib/nav";

interface Row {
  t: number;
  kind: "mark" | "live";
  markId: number | null;
  nav: number;
  senior: number | null;
  junior: number | null;
  sM?: number;
  jM?: number;
  navM?: number;
  navL?: number;
}

function rows(series: NavPoint[], split: boolean): Row[] {
  const lastMarkIdx = series.map((p) => p.kind).lastIndexOf("mark");
  const hasLive = series.some((p) => p.kind === "live");
  return series.map((p, i) => ({
    t: p.t,
    kind: p.kind,
    markId: p.markId,
    nav: p.nav,
    senior: p.senior,
    junior: p.junior,
    sM: p.kind === "mark" && split ? (p.senior ?? undefined) : undefined,
    jM: p.kind === "mark" && split ? (p.junior ?? undefined) : undefined,
    navM: p.kind === "mark" && !split ? p.nav : undefined,
    navL: hasLive && (p.kind === "live" || i === lastMarkIdx) ? p.nav : undefined,
  }));
}

const usdTick = (v: number) => fmtUsd(v.toFixed(6), { compact: true, dp: 0, symbol: true });

function TooltipBody({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: Row }> }) {
  const r = payload?.[0]?.payload;
  if (!active || !r) return null;
  return (
    <div className="min-w-[180px] rounded-control border border-line-strong bg-surface px-2.5 py-2 text-[11.5px] shadow-sm">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="font-semibold">{r.kind === "live" ? "Live estimate" : `Mark #${r.markId}`}</span>
        <span className="num text-muted">{fmtDateTime(r.t)}</span>
      </div>
      <table className="num w-full">
        <tbody>
          {r.junior !== null && (
            <tr>
              <td className="pr-3 text-ink-2">
                <span className="mr-1.5 inline-block size-2 rounded-[1px] bg-junior align-middle" />
                Junior
              </td>
              <td className="text-right">{fmtUsd(r.junior.toFixed(6))}</td>
            </tr>
          )}
          {r.senior !== null && (
            <tr>
              <td className="pr-3 text-ink-2">
                <span className="mr-1.5 inline-block size-2 rounded-[1px] bg-senior align-middle" />
                Senior
              </td>
              <td className="text-right">{fmtUsd(r.senior.toFixed(6))}</td>
            </tr>
          )}
          <tr className="border-t border-line">
            <td className="pt-0.5 pr-3 font-medium">Book NAV</td>
            <td className="pt-0.5 text-right font-medium">{fmtUsd(r.nav.toFixed(6))}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function NavChart({ series, height = 260 }: { series: NavPoint[]; height?: number }) {
  const split = hasTrancheSplit(series);
  const data = rows(series, split);
  const t0 = data[0]?.t ?? 0;
  const t1 = data[data.length - 1]?.t ?? 0;
  const spanDays = (t1 - t0) / 86_400_000;
  const tickFmt = (t: number) => (spanDays > 2 ? fmtDateTime(t).slice(5, 10) : fmtTime(t).slice(0, 5));
  return (
    <div style={{ height }} className="w-full" role="img" aria-label="Book NAV by tranche at each mark">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={tickFmt}
            tick={{ fill: "var(--muted)", fontSize: 10.5, fontFamily: "var(--font-mono)" }}
            axisLine={{ stroke: "var(--line-strong)" }}
            tickLine={false}
            minTickGap={36}
          />
          <YAxis
            tickFormatter={usdTick}
            tick={{ fill: "var(--muted)", fontSize: 10.5, fontFamily: "var(--font-mono)" }}
            axisLine={false}
            tickLine={false}
            width={58}
            domain={[0, "auto"]}
          />
          <Tooltip content={(p) => <TooltipBody active={p.active} payload={p.payload as ReadonlyArray<{ payload?: Row }>} />} cursor={{ stroke: "var(--line-strong)" }} isAnimationActive={false} />
          {split ? (
            <>
              <Area
                dataKey="sM"
                stackId="m"
                type="linear"
                stroke="var(--senior)"
                strokeWidth={2}
                fill="var(--senior)"
                fillOpacity={0.12}
                isAnimationActive={false}
                dot={false}
                activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2, fill: "var(--senior)" }}
                connectNulls={false}
              />
              <Area
                dataKey="jM"
                stackId="m"
                type="linear"
                stroke="var(--junior)"
                strokeWidth={2}
                fill="var(--junior)"
                fillOpacity={0.12}
                isAnimationActive={false}
                dot={false}
                activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2, fill: "var(--junior)" }}
                connectNulls={false}
              />
            </>
          ) : (
            <Area
              dataKey="navM"
              type="linear"
              stroke="var(--accent)"
              strokeWidth={2}
              fill="var(--accent)"
              fillOpacity={0.1}
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2, fill: "var(--accent)" }}
            />
          )}
          <Line
            dataKey="navL"
            type="linear"
            stroke="var(--ink-2)"
            strokeWidth={2}
            strokeDasharray="4 3"
            isAnimationActive={false}
            connectNulls
            dot={(d: { cx?: number; cy?: number; payload?: Row; index?: number }) =>
              d.payload?.kind === "live" && d.cx != null && d.cy != null ? (
                <circle key={`live-${d.index}`} cx={d.cx} cy={d.cy} r={4.5} fill="var(--surface)" stroke="var(--ink)" strokeWidth={2} />
              ) : (
                <g key={`n-${d.index}`} />
              )
            }
            activeDot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
