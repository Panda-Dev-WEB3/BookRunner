// Position panel: the wallet's position valued at the freshest signed price (entry, margin, equity, PnL, funding
// owed, margin ratio, leverage, liquidation prices in session and off-hours) and a close / partial reduce
// (trade.close: a trade of -size, allowed while reduce-only, never off-hours). Trading page v2: the liquidation-risk
// level (watch / danger / imminent, against maintenance or, while the price is held, the off-hours requirement), what
// a session close now would mean, and an opt-in browser notification while the page is open (riskLogic.ts).
import { useState } from "react";
import { trpc } from "../../api/trpc";
import type { TradeMarket, TradePositionOut } from "../../lib/api-types";
import { fmtBps, fmtPrice, fmtUsd, toNum } from "../../lib/format";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { Callout, Card, Chip, ErrorState, KV, Spinner } from "../ui";
import { RiskNotifyToggle, useRiskNotifications } from "./RiskNotify";
import { RISK_META, ifCloseText, positionRisk, riskText } from "./riskLogic";
import { Prepared } from "./TradeBits";
import { DEFAULT_SLIPPAGE_BPS, absUnitsText, closeDelta, fmtLeverage } from "./tradeLogic";

const PORTIONS = [
  { bps: 2_500, label: "Reduce 25%" },
  { bps: 5_000, label: "Reduce 50%" },
  { bps: 10_000, label: "Close all" },
] as const;

const liqText = (v: string | null | undefined) => (v === "any" ? "at any price" : v ? fmtPrice(toNum(v)) : "none");

export function PositionPanel(props: { m: TradeMarket; address: string; position: TradePositionOut | undefined; error: unknown; onRetry: () => void }) {
  const sym = useSettlementSymbol();
  const p = props.position;
  const [portion, setPortion] = useState<number | null>(null);
  const close = trpc.trade.close.useMutation();
  const risk = p ? positionRisk(p, props.m) : null;
  const notify = useRiskNotifications(risk, props.m.symbol);
  const reset = () => {
    close.reset();
    setPortion(null);
  };
  if (!p) {
    if (props.error) return <ErrorState compact error={props.error} onRetry={props.onRetry} />;
    return (
      <Card title="Your position">
        <span className="inline-flex items-center gap-2 text-[12.5px] text-ink-2">
          <Spinner size={14} /> Reading your position…
        </span>
      </Card>
    );
  }
  const flat = p.side === "flat";
  const pnl = toNum(p.unrealizedPnlUsd) ?? 0;
  const warnNow = risk ? riskText(risk.level, p.marginRatioBps, risk.requirementBps, risk.moveNow, risk.held) : null;
  const warnClose = risk ? ifCloseText(risk, props.m.margin.offHoursMarginBps) : null;
  return (
    <Card
      title="Your position"
      actions={
        flat ? undefined : (
          <>
            {risk && risk.level !== "ok" && <Chip tone={RISK_META[risk.level].tone}>{RISK_META[risk.level].label}</Chip>}
            <Chip tone={p.side === "long" ? "good" : "critical"}>{p.side === "long" ? "Long" : "Short"}</Chip>
          </>
        )
      }
      description={flat ? (toNum(p.marginUsd) ? `No open position. ${fmtUsd(p.marginUsd)} ${sym} of margin in this market.` : "No open position and no margin in this market yet.") : `Valued at ${fmtPrice(toNum(p.markPrice))} (${p.priceSource === "signed" ? "the latest signed price" : "the price on chain"}).`}
    >
      {!flat && (
        <div className="space-y-4">
          <KV
            rows={[
              ["Size", `${absUnitsText(p.size)} units · ${fmtUsd(p.notionalUsd)} ${sym}`],
              ["Entry price", fmtPrice(toNum(p.entryPrice))],
              ["Unrealised PnL", <span key="pnl" className={pnl < 0 ? "text-critical-ink" : pnl > 0 ? "text-good-ink" : undefined}>{`${fmtUsd(p.unrealizedPnlUsd, { signed: true })} ${sym}`}</span>],
              ["Funding owed", `${fmtUsd(p.fundingOwedUsd, { signed: true, dp: 4 })} ${sym}`],
              ["Margin", `${fmtUsd(p.marginUsd)} ${sym}`],
              ["Equity", `${fmtUsd(p.equityUsd)} ${sym}`],
              ["Margin ratio", p.marginRatioBps === null ? "—" : `${fmtBps(p.marginRatioBps)} (${risk?.held ? "off-hours requirement" : "maintenance"} ${fmtBps(risk?.requirementBps ?? props.m.margin.maintenanceMarginBps)})`],
              ["Leverage", fmtLeverage(p.leverage)],
              ["Liquidation price", liqText(p.liquidationPrice)],
              ["Liquidation price off-hours", liqText(p.liquidationPriceOffHours)],
              risk && !risk.held && ["If the session closes now", risk.ifClose === "ok" || risk.ifClose === null ? "margin comfortable" : RISK_META[risk.ifClose].label.toLowerCase()],
            ]}
          />
          {risk && warnNow && (
            <Callout tone={RISK_META[risk.level].callout} compact title={warnNow.title}>
              {warnNow.body}
            </Callout>
          )}
          {risk && warnClose && (
            <Callout tone={risk.ifClose === "liquidatable" ? "risk" : "warn"} compact title={warnClose.title}>
              {warnClose.body}
            </Callout>
          )}
          <RiskNotifyToggle n={notify} />
          {close.error && <ErrorState compact error={close.error} />}
          {close.isPending && (
            <span className="inline-flex items-center gap-2 text-[12.5px] text-ink-2">
              <Spinner size={14} /> Preparing with the latest signed price…
            </span>
          )}
          {close.data && portion !== null ? (
            <Prepared
              txs={close.data.txs}
              warnings={close.data.warnings}
              signer={props.address}
              amount={closeDelta(p.sizeRaw, portion)}
              doneText={portion === 10_000 ? "Position closed. The margin stays in the market until you withdraw it." : "Position reduced."}
              onDone={reset}
              onBack={reset}
            />
          ) : (
            !close.isPending && (
              <div className="flex flex-wrap gap-2">
                {PORTIONS.map((x) => (
                  <button
                    key={x.bps}
                    type="button"
                    className={x.bps === 10_000 ? "btn btn-primary btn-sm" : "btn btn-sm"}
                    disabled={!props.m.canTrade}
                    onClick={() => {
                      setPortion(x.bps);
                      close.mutate({ marketId: props.m.marketId, wallet: props.address, portionBps: x.bps, slippageBps: DEFAULT_SLIPPAGE_BPS });
                    }}
                  >
                    {x.label}
                  </button>
                ))}
              </div>
            )
          )}
          {!props.m.canTrade && <p className="text-[12px] text-ink-2">{props.m.reasons[0] ?? "Trading is paused."}</p>}
        </div>
      )}
    </Card>
  );
}
