// Charter terms in human units: market, capital, mandate (with explanations), tranche terms.
import type { ReactNode } from "react";
import type { CharterView, MandateView } from "../lib/api-types";
import { FIELD_HELP, SESSION_PRESETS } from "../lib/charterForm";
import { venueDetail, venueLabel } from "../lib/copy";
import { bpsPct, fmtBps, fmtDuration, fmtUsd, shortHex } from "../lib/format";
import { isTestChain } from "../wallet/network";
import { Hash } from "./ui";

function Row({ k, v, help }: { k: string; v: ReactNode; help?: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-line py-1.5 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[12.5px] text-ink-2">{k}</div>
        {help && <div className="text-[11px] leading-snug text-muted">{help}</div>}
      </div>
      <div className="num text-right text-[12.5px]">{v}</div>
    </div>
  );
}

export function MandateTerms({ m, explain = true }: { m: MandateView; explain?: boolean }) {
  const h = (k: string) => (explain ? FIELD_HELP[k] : undefined);
  return (
    <div>
      <Row k="Max inventory" v={fmtUsd(m.maxInventoryUsd, { symbol: true })} help={h("mandate.maxInventoryUsd")} />
      <Row k="Max skew" v={fmtBps(m.maxSkewBps)} help={h("mandate.maxSkewBps")} />
      <Row k="Min quote width" v={fmtBps(m.minQuoteWidthBps)} help={h("mandate.minQuoteWidthBps")} />
      <Row k="Hedge ratio band" v={`${bpsPct(m.hedgeRatioMinBps)} to ${bpsPct(m.hedgeRatioMaxBps)}`} help={h("mandate.hedgeRatio")} />
      <Row k="Max hedge leverage" v={`${m.maxHedgeLeverage.toFixed(2)}x`} help={h("mandate.maxHedgeLeverage")} />
      <Row k="No new risk off-hours" v={m.noNewRiskOffHours ? "Yes" : "No"} help={h("mandate.noNewRiskOffHours")} />
      <Row k="Kill at drawdown" v={fmtBps(m.killAtDrawdownBps)} help={h("mandate.killAtDrawdownBps")} />
      <Row k="Hedge allow-list root" v={<Hash value={m.hedgeAllowRoot} />} help={h("mandate.hedgeAllow")} />
    </div>
  );
}

export function CharterTerms({ c, explain = false, stacked = false }: { c: CharterView; explain?: boolean; stacked?: boolean }) {
  const preset = SESSION_PRESETS.find((p) => p.id === c.sessionsPreset);
  const h = (k: string) => (explain ? FIELD_HELP[k] : undefined);
  return (
    <div className={stacked ? "grid gap-y-4" : "grid gap-x-6 gap-y-4 md:grid-cols-2"}>
      <div>
        <div className="eyebrow mb-1">Market</div>
        <Row k="Underlying" v={c.ticker ?? (c.underlyingToken ? shortHex(c.underlyingToken) : shortHex(c.underlying))} help={c.underlyingKind === "index" ? "Registered index" : "Stock Token"} />
        <Row k="Venue" v={venueLabel(c.venue)} help={venueDetail(c.venue, isTestChain)} />
        <Row k="Venue symbol" v={c.symbol || "—"} />
        <Row k="Oracle" v={c.oracle === "attested" ? "Attested multi-source" : c.oracle === "chainlink" ? "Equity feed reader" : "Unknown"} help={h("oracle")} />
        <Row k="Sessions" v={preset?.label ?? "Custom"} help={preset?.detail} />
        {c.venue === "pool_engine" && <Row k="Taker / maker fee" v={`${c.takerFeeBps} / ${c.makerFeeBps} bps`} />}
        <div className="eyebrow mt-4 mb-1">Capital</div>
        <Row k="IF size" v={fmtUsd(c.ifTargetUsd, { symbol: true })} help={h("ifSizeUsd")} />
        <Row k="MM inventory" v={fmtUsd(c.mmInventoryUsd, { symbol: true })} help={h("mmInventoryUsd")} />
        <div className="eyebrow mt-4 mb-1">Tranche terms</div>
        <Row k="Senior cap" v={`${bpsPct(c.seniorCapBps)} of book capital`} help={h("seniorCapBps")} />
        <Row k="Senior share of fee flow" v={bpsPct(c.seniorHurdleBps)} help={h("seniorShareBps")} />
        <Row k="Subscription window" v={fmtDuration(c.subscriptionWindowSeconds)} />
        <Row k="Junior notice" v={fmtDuration(c.juniorNoticeSeconds)} help="Notice is not a gate" />
        <Row k="Per-wallet cap" v={Number(c.perWalletCapUsd) > 0 ? fmtUsd(c.perWalletCapUsd, { symbol: true }) : "None"} />
        <Row k="Sponsor" v={<Hash value={c.sponsor} kind="address" />} />
      </div>
      <div>
        <div className="eyebrow mb-1">Mandate</div>
        <MandateTerms m={c.mandate} explain={explain} />
      </div>
    </div>
  );
}
