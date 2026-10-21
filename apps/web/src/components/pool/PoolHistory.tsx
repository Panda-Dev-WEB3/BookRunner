// Share price and premium history (observed, never a forecast): the share price at each indexed pool snapshot,
// and per day the premiums received from books, the losses marked and the recoveries.
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PoolHistoryOut } from "../../lib/api-types";
import { fmtDateTime, fmtDay, fmtUsd } from "../../lib/format";
import { SERIES } from "../../lib/palette";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { MiniLine } from "../charts/MiniLine";
import { Card, ErrorState, Legend, Segmented, SkeletonRows, Stat } from "../ui";
import { type FlowBar, flowBars, flowTotals, priceChangeText, sharePriceSeries } from "./poolLogic";

export const HISTORY_WINDOWS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
] as const;
export type HistoryWindow = (typeof HISTORY_WINDOWS)[number]["value"];

const tick = { fill: "var(--muted)", fontSize: 10.5, fontFamily: "var(--font-mono)" };
const usdTick = (v: number) => fmtUsd(Math.abs(v).toFixed(6), { compact: true, dp: 0 });

function FlowTooltip({ active, payload, sym }: { active?: boolean; payload?: ReadonlyArray<{ payload?: FlowBar }>; sym: string }) {
  const r = payload?.[0]?.payload;
  if (!active || !r) return null;
  return (
    <div className="min-w-[170px] rounded-control border border-line-strong bg-surface px-2.5 py-2 text-[11.5px] shadow-sm">
      <div className="mb-1 font-semibold">{fmtDay(r.t / 1000, "UTC")}</div>
      <div className="num flex justify-between gap-3">
        <span className="text-ink-2">Premiums</span>
        <span>
          {fmtUsd(r.premium.toFixed(6))} {sym}
        </span>
      </div>
      <div className="num flex justify-between gap-3">
        <span className="text-ink-2">Losses</span>
        <span>
          {fmtUsd((-r.loss).toFixed(6))} {sym}
        </span>
      </div>
      {r.recovery > 0 && (
        <div className="num flex justify-between gap-3">
          <span className="text-ink-2">Recoveries</span>
          <span>
            {fmtUsd(r.recovery.toFixed(6))} {sym}
          </span>
        </div>
      )}
    </div>
  );
}

function FlowChart({ bars, sym }: { bars: FlowBar[]; sym: string }) {
  if (bars.length === 0) {
    return <div className="flex h-[180px] items-center justify-center rounded-control border border-dashed border-line text-[11.5px] text-muted">No premium or loss recorded in this window</div>;
  }
  return (
    <div style={{ height: 180 }} className="w-full" role="img" aria-label="Premiums received and losses marked per day">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={bars} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} stackOffset="sign">
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="day" tick={tick} tickFormatter={(d: string) => d.slice(5)} axisLine={{ stroke: "var(--line-strong)" }} tickLine={false} minTickGap={24} />
          <YAxis tick={tick} tickFormatter={usdTick} axisLine={false} tickLine={false} width={48} />
          <ReferenceLine y={0} stroke="var(--line-strong)" />
          <Tooltip content={(p) => <FlowTooltip active={p.active} payload={p.payload as ReadonlyArray<{ payload?: FlowBar }>} sym={sym} />} cursor={{ fill: "var(--surface-3)", opacity: 0.5 }} isAnimationActive={false} />
          <Bar dataKey="premium" stackId="f" fill={SERIES.fee} isAnimationActive={false} />
          <Bar dataKey="loss" stackId="f" fill={SERIES.loss} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PoolHistory(props: { data: PoolHistoryOut | undefined; error: unknown; onRetry: () => void; window: HistoryWindow; onWindow: (w: HistoryWindow) => void }) {
  const sym = useSettlementSymbol();
  const d = props.data;
  const picker = <Segmented size="sm" ariaLabel="History window" value={props.window} onChange={props.onWindow} options={HISTORY_WINDOWS.map((w) => ({ value: w.value, label: w.label }))} />;
  if (!d) {
    return (
      <Card title="Share price and premiums" actions={picker} padding="md">
        {props.error ? <ErrorState compact error={props.error} onRetry={props.onRetry} /> : <SkeletonRows rows={5} />}
      </Card>
    );
  }
  const price = sharePriceSeries(d.points);
  const bars = flowBars(d.flows);
  const totals = flowTotals(d.flows);
  const c = d.sharePriceChange;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Share price (observed)" description="At each indexed pool snapshot. It moves only with book marks, repayments, retirements and premiums." actions={picker} padding="md">
        <MiniLine data={price} height={180} format={(v) => v.toFixed(4)} ariaLabel="Pool share price over time" emptyText="No snapshot in this window yet" />
        <div className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-3">
          <Stat label="Observed change over the window" value={<span className="text-[15px]">{priceChangeText(c)}</span>} />
          <Stat label="Period" value={<span className="text-[13px]">{c ? `${fmtDateTime(c.from)} to ${fmtDateTime(c.to)}` : "—"}</span>} />
        </div>
        <p className="mt-3 text-[11.5px] text-muted">A past change says nothing about the next period. The share price is never quoted as a rate.</p>
      </Card>
      <Card title="Premiums and losses per day" description="Premiums received from pool-funded books' gross fee flow, and losses the pool marked (shown below zero)." padding="md">
        <FlowChart bars={bars} sym={sym} />
        <div className="mt-2">
          <Legend
            items={[
              { label: "Premiums", color: SERIES.fee },
              { label: "Losses", color: SERIES.loss },
            ]}
          />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-4 border-t border-line pt-3">
          <Stat label="Premiums" series="fee" value={<span className="text-[15px]">{fmtUsd(totals.premium)}</span>} sub={`${sym}, this window`} />
          <Stat label="Losses" series="loss" value={<span className="text-[15px]">{fmtUsd(totals.loss)}</span>} sub={`${sym}, this window`} />
          <Stat label="Recoveries" value={<span className="text-[15px]">{fmtUsd(totals.recovery)}</span>} sub={`${sym}, this window`} />
        </div>
      </Card>
    </div>
  );
}
