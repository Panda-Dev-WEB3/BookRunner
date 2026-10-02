import { useEffect, useState } from "react";
import { MiniLine } from "../../components/charts/MiniLine";
import { QuoteLadder } from "../../components/charts/QuoteLadder";
import { Chip, EmptyState, KV, Panel, ValueKind } from "../../components/ui";
import type { MandateView, QuoteView } from "../../lib/api-types";
import { AGENTS_LINE } from "../../lib/copy";
import { fmtAgo, fmtBps, fmtNum, fmtPct, fmtUsdFloat } from "../../lib/format";
import { ringPush } from "../../lib/nav";
import { ladderModel, quoteFreshness } from "../../lib/quote";

interface Sample {
  t: number;
  width: number;
  skew: number;
}

export function QuotePanel(props: { quote: QuoteView | null; mandate: MandateView | null; now: number; agentAlive: boolean; killed: boolean }) {
  const { quote, mandate } = props;
  const [hist, setHist] = useState<Sample[]>([]);
  useEffect(() => {
    if (!quote) return;
    const mid = (quote.bid + quote.ask) / 2;
    const width = mid > 0 ? ((quote.ask - quote.bid) / mid) * 10_000 : 0;
    const skew = quote.oracle > 0 ? ((mid - quote.oracle) / quote.oracle) * 10_000 : 0;
    setHist((h) => ringPush(h, { t: quote.ts, width, skew }, 120, (a, b) => a.t === b.t));
  }, [quote]);

  const fresh = quote ? quoteFreshness(quote.ts, props.now) : null;
  return (
    <Panel
      title="Live quote"
      meta={quote ? `${fmtAgo(props.now - quote.ts)}` : undefined}
      actions={
        <div className="flex items-center gap-2">
          {fresh === "stale" && <Chip tone="warn">Stale</Chip>}
          <ValueKind kind="live" />
        </div>
      }
    >
      {!quote || !mandate ? (
        <EmptyState
          compact
          title={props.killed ? "Quoting stopped: mandate killed" : "No live quote"}
          body={
            props.killed
              ? "Agents cancel all quotes on a kill; the committee may re-mandate."
              : props.agentAlive
                ? "The agent is running but has not published a quote yet."
                : `${AGENTS_LINE} No agent heartbeat for this book right now.`
          }
        />
      ) : (
        (() => {
          const m = ladderModel(quote, { minQuoteWidthBps: mandate.minQuoteWidthBps, maxSkewBps: mandate.maxSkewBps });
          return (
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <QuoteLadder m={m} />
              <div className="min-w-0">
                <div className="mb-3 grid grid-cols-2 gap-3">
                  <div>
                    <div className="eyebrow">Width</div>
                    <div className="num text-[17px] font-medium">{fmtBps(m.widthBps, { dp: 1 })}</div>
                    <div className="mt-0.5">
                      <Chip tone={m.widthOk && !m.crossed ? "good" : "critical"}>{m.crossed ? "Crossed" : m.widthOk ? `min ${mandate.minQuoteWidthBps} bps` : `below min ${mandate.minQuoteWidthBps}`}</Chip>
                    </div>
                  </div>
                  <div>
                    <div className="eyebrow">Skew vs oracle</div>
                    <div className="num text-[17px] font-medium">{fmtBps(m.skewBps, { signed: true, dp: 1 })}</div>
                    <div className="mt-0.5">
                      <Chip tone={m.skewOk ? (m.skewUtil >= 0.8 ? "warn" : "good") : "critical"}>{m.skewOk ? `${fmtPct(m.skewUtil, 0)} of max ${mandate.maxSkewBps}` : `beyond max ${mandate.maxSkewBps}`}</Chip>
                    </div>
                  </div>
                </div>
                <KV
                  rows={[
                    ["Bid / Ask", `${fmtNum(quote.bid, 2)} / ${fmtNum(quote.ask, 2)}`],
                    ["Mid · Oracle", `${fmtNum(m.mid, 2)} · ${fmtNum(quote.oracle, 2)}`],
                    ["Size per side", `${fmtNum(quote.size, 4)} units`],
                    ["Inventory", fmtUsdFloat(quote.inventoryUsd, { signed: true })],
                    ["Sides quoted", quote.sides ? `${quote.sides.bid ? "bid" : "no bid"} · ${quote.sides.ask ? "ask" : "no ask"}` : "both"],
                  ]}
                />
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <div className="mb-1 text-[10.5px] text-muted">Width (bps), this session</div>
                    <MiniLine
                      height={44}
                      data={hist.map((h) => ({ t: h.t, v: h.width }))}
                      color="var(--accent)"
                      format={(v) => v.toFixed(1)}
                      refLines={[{ v: mandate.minQuoteWidthBps, label: "min" }]}
                      ariaLabel="Quote width history"
                      emptyText="Collecting"
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-[10.5px] text-muted">Skew (bps), this session</div>
                    <MiniLine
                      height={44}
                      data={hist.map((h) => ({ t: h.t, v: h.skew }))}
                      color="var(--accent)"
                      format={(v) => v.toFixed(1)}
                      refLines={[
                        { v: mandate.maxSkewBps, label: "max+" },
                        { v: -mandate.maxSkewBps, label: "max-" },
                      ]}
                      ariaLabel="Quote skew history"
                      emptyText="Collecting"
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })()
      )}
    </Panel>
  );
}
