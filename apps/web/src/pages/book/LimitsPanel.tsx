import { POLL, trpc } from "../../api/trpc";
import { MiniLine } from "../../components/charts/MiniLine";
import { Chip, EmptyState, MeterBar, Panel, StateChip, ValueKind } from "../../components/ui";
import type { LimitsView, MandateView } from "../../lib/api-types";
import { fmtAge, fmtBps, fmtPct, fmtUsd, fmtUsdFloat, ageMs, toNum } from "../../lib/format";
import { HEDGE_THRESHOLD_PCT, breachText, drawdownMeter, hedgeMeter, limitState, utilMeter } from "../../lib/limits";
import type { MarkStatement } from "../../lib/markStatement";

export function LimitsPanel(props: { bookId: number; limits: LimitsView | null; mandate: MandateView | null; now: number; lastStatement?: MarkStatement | null }) {
  const { limits: l, mandate: m } = props;
  const series = trpc.book.limits.useQuery({ bookId: props.bookId }, { refetchInterval: POLL.slow });
  const age = ageMs(l?.ts ?? null, props.now);
  const maxInv = toNum(m?.maxInventoryUsd ?? null);
  const markExposure = props.lastStatement?.venue.netExposureUsd ?? null;
  const exposureText =
    l?.netExposureUsd != null
      ? fmtUsdFloat(l.netExposureUsd, { signed: true, compact: true })
      : markExposure !== null
        ? `${fmtUsd(markExposure, { signed: true, compact: true })} at mark #${props.lastStatement?.markId}`
        : "n/a";

  return (
    <Panel
      title="Inventory, hedge & limits"
      meta={l ? `${l.source === "live" ? "risk monitor" : "last stored snapshot"}${age === null ? "" : ` · ${fmtAge(age)} ago`}` : undefined}
      actions={
        <div className="flex items-center gap-2">
          {l?.offHours && <Chip tone="serious">Off-hours</Chip>}
          <StateChip meta={limitState(l?.state)} solid={l?.state === "killed"} />
        </div>
      }
    >
      {!l || !m ? (
        <EmptyState compact title="No risk snapshot yet" body="The risk service classifies the book's limits every few seconds once the book is live." />
      ) : (
        <>
          {l.breaches.length > 0 && (
            <ul className="mb-3 space-y-1 rounded-[2px] border border-critical/40 bg-critical/5 p-2 text-[12px]">
              {l.breaches.map((b) => (
                <li key={b} className="flex items-center gap-2">
                  <span className="size-1.5 rounded-[1px] bg-critical" aria-hidden />
                  <span className="font-medium">{b}</span>
                  <span className="text-ink-2">{breachText(b)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <MeterBar
              label="Inventory"
              meter={utilMeter(l.inventoryUtil)}
              value={fmtPct(l.inventoryUtil)}
              sub={`net ${exposureText} · max ${fmtUsd(m.maxInventoryUsd, { compact: true })}`}
            />
            {(() => {
              const hm = hedgeMeter(l.hedgeRatioBps, m.hedgeRatioMinBps, m.hedgeRatioMaxBps);
              return (
                <MeterBar
                  label="Hedge ratio"
                  meter={hm}
                  value={l.hedgeRatioBps === null ? "n/a" : fmtPct(l.hedgeRatioBps / 10_000, 0)}
                  sub={`band ${fmtPct(m.hedgeRatioMinBps / 10_000, 0)} to ${fmtPct(m.hedgeRatioMaxBps / 10_000, 0)}`}
                  status={
                    hm.inBand === null ? (
                      <span title={`Band enforced once |exposure| is at least ${HEDGE_THRESHOLD_PCT}% of max inventory`}>below threshold</span>
                    ) : hm.inBand ? (
                      <span className="text-good-ink">in band</span>
                    ) : (
                      <span className="text-warn-ink">out of band</span>
                    )
                  }
                />
              );
            })()}
            <MeterBar
              label="Quote skew"
              meter={utilMeter(l.skewUtil, 0.8)}
              value={fmtPct(l.skewUtil)}
              sub={`of max ${m.maxSkewBps} bps`}
            />
            {(() => {
              const dm = drawdownMeter(l.drawdownBps, m.killAtDrawdownBps);
              return (
                <MeterBar
                  label="Drawdown"
                  meter={dm}
                  value={fmtBps(l.drawdownBps, { dp: 0 })}
                  sub={`kill at ${fmtBps(m.killAtDrawdownBps)}`}
                  status={dm.util !== null ? <span>{fmtPct(dm.util, 0)} of kill</span> : null}
                />
              );
            })()}
          </div>
          <div className="mt-5 border-t border-line pt-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="eyebrow">Last 24h</span>
              <ValueKind kind="live" />
            </div>
            {series.data && series.data.series.length > 0 ? (
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-4">
                {(
                  [
                    ["Inventory util (max)", series.data.series.map((s) => ({ t: Date.parse(s.bucket), v: s.inventoryUtilMax * 100 })), [{ v: 90, label: "90" }, { v: 100, label: "100" }], (v: number) => `${v.toFixed(0)}%`, undefined],
                    ["Skew util (max)", series.data.series.map((s) => ({ t: Date.parse(s.bucket), v: s.skewUtilMax * 100 })), [{ v: 100, label: "100" }], (v: number) => `${v.toFixed(0)}%`, undefined],
                    [
                      "Hedge ratio (avg)",
                      series.data.series.filter((s) => s.hedgeRatioAvg !== null).map((s) => ({ t: Date.parse(s.bucket), v: (s.hedgeRatioAvg ?? 0) / 100 })),
                      [],
                      (v: number) => `${v.toFixed(0)}%`,
                      [m.hedgeRatioMinBps / 100, m.hedgeRatioMaxBps / 100] as [number, number],
                    ],
                    ["Drawdown (min)", series.data.series.map((s) => ({ t: Date.parse(s.bucket), v: s.drawdownMin })), [{ v: m.killAtDrawdownBps, label: "kill" }], (v: number) => `${v.toFixed(0)} bps`, undefined],
                  ] as const
                ).map(([label, data, refs, fmt, band]) => (
                  <div key={label}>
                    <div className="mb-1 text-[10.5px] text-muted">{label}</div>
                    <MiniLine height={44} data={[...data]} format={fmt} refLines={[...refs]} band={band} ariaLabel={label} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[11.5px] text-muted">{series.isLoading ? "Loading history…" : "No stored limit samples in the last 24 hours."}</div>
            )}
          </div>
          {maxInv !== null && (
            <p className="mt-3 text-[11px] text-muted">
              Utilisation is |net venue exposure| over the mandate's max inventory. Agents quote reduce-only on the growing side above 90%; above 100% is a breach.
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
