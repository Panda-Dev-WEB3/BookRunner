// Trading page building blocks: the market header (price and its age, session badge, funding, open interest, room,
// fees and margins), the market list, the risk text, the contract card and the prepared-transaction wrapper.
import { type ReactNode, useState } from "react";
import { Link } from "react-router";
import { useNow } from "../../api/hooks";
import type { PreparedTx, TradeMarket } from "../../lib/api-types";
import { bpsPct, fmtBps, fmtPrice, fmtUsd, toNum } from "../../lib/format";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { TxRunner } from "../../wallet/TxRunner";
import { Callout, Card, Chip, Hash, KV, Stat, StatGrid } from "../ui";
import { SESSION_BADGE, fmtLeverage, priceAge, tradeRiskLines } from "./tradeLogic";
import { useRefreshTrade } from "./useTrade";

export const marketTitle = (m: Pick<TradeMarket, "name" | "symbol">) => m.name ?? m.symbol;

export function SessionBadge({ m }: { m: Pick<TradeMarket, "session"> }) {
  const b = SESSION_BADGE[m.session];
  return <Chip tone={b.tone}>{b.label}</Chip>;
}

export function PriceAge({ m }: { m: Pick<TradeMarket, "price" | "tradePriceMaxAgeSeconds"> }) {
  const now = useNow(1_000);
  // re-derive the age locally between refetches
  const age = m.price ? Math.max(0, Math.floor(now / 1000) - m.price.publishedAtSec) : null;
  const a = priceAge(age, m.tradePriceMaxAgeSeconds);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={a.tone === "good" ? "size-1.5 rounded-full bg-good" : "size-1.5 rounded-full bg-warn"} aria-hidden />
      <span>signed {a.text}</span>
    </span>
  );
}

const fundingText = (bps: number) => (bps === 0 ? "0 bps / day" : `${fmtBps(bps, { signed: true, dp: Math.abs(bps) < 1 ? 2 : 1 })} / day (${bps > 0 ? "longs pay" : "shorts pay"})`);

export function MarketHeader({ m }: { m: TradeMarket }) {
  const sym = useSettlementSymbol();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink sm:text-[26px]">{marketTitle(m)}</h1>
            <SessionBadge m={m} />
          </div>
          <div className="mt-1 text-[12.5px] text-ink-2">
            {m.symbol} · market #{m.marketId} · book #{m.bookId}
          </div>
        </div>
        <div className="text-right">
          <div className="num text-[28px] font-medium leading-8 tracking-[-0.02em] sm:text-[32px]">{m.price ? fmtPrice(toNum(m.price.price)) : "—"}</div>
          <div className="num text-[12px] text-ink-2">
            <PriceAge m={m} />
            {m.price?.held ? " · session closed" : ""}
          </div>
        </div>
      </div>
      {m.reasons.length > 0 && (
        <Callout tone={m.canTrade ? "warn" : "neutral"} compact>
          <ul className="space-y-1">
            {m.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Callout>
      )}
      <StatGrid cols={4}>
        <Stat label="Buy / sell for 1 unit" value={m.quote.buyPrice ? `${fmtPrice(toNum(m.quote.buyPrice))} / ${fmtPrice(toNum(m.quote.sellPrice))}` : "—"} sub={`Spread ${fmtBps(m.quote.spreadBps)}${m.quote.skewBps ? `, skew ${fmtBps(m.quote.skewBps, { signed: true })}` : ""} · fee ${fmtBps(m.fees.takerFeeBps)}`} />
        <Stat label="Funding" value={fundingText(m.funding.ratePerDayBps)} sub="Paid by the side with more open interest, received by the other side; settled against the pool" />
        <Stat
          label="Open interest"
          value={`${fmtUsd(m.openInterest.longUsd, { compact: true })} / ${fmtUsd(m.openInterest.shortUsd, { compact: true })}`}
          sub={`Long / short in ${sym} · pool net ${fmtUsd(m.openInterest.poolNetExposureUsd, { compact: true, signed: true })}`}
        />
        <Stat label="Room left" value={`${fmtUsd(m.caps.buyRoomUsd, { compact: true })} / ${fmtUsd(m.caps.sellRoomUsd, { compact: true })}`} sub={`Buy / sell, under an inventory cap of ${fmtUsd(m.caps.inventoryCapUsd, { compact: true })} ${sym}`} />
        <Stat
          label="Max leverage"
          value={fmtLeverage(m.margin.orderLeverageCap)}
          sub={m.margin.refusesUnholdable ? `Capped at what survives a session close · initial margin ${bpsPct(m.margin.initialMarginBps)}` : `Initial margin ${bpsPct(m.margin.initialMarginBps)} · maintenance ${bpsPct(m.margin.maintenanceMarginBps)}`}
        />
        <Stat label="Held through a close" value={fmtLeverage(m.margin.holdableLeverage)} sub={`Off-hours requirement ${bpsPct(m.margin.offHoursMarginBps)} of notional`} />
        <Stat label="Insurance fund" value={fmtUsd(m.pool.insuranceUsd, { compact: true })} sub={`Absorbs bad debt first · pool cash ${fmtUsd(m.pool.cashUsd, { compact: true })}`} />
        <Stat label="Price bound" value={`${m.tradePriceMaxAgeSeconds} s`} sub="Oldest signed price a trade may carry" />
      </StatGrid>
    </div>
  );
}

export function MarketList({ markets }: { markets: TradeMarket[] }) {
  return (
    <ul className="grid gap-4 md:grid-cols-2">
      {markets.map((m) => (
        <li key={m.marketId}>
          <Link to={`/trade/${m.marketId}`} className="block h-full">
            <Card interactive className="h-full">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[16px] font-semibold text-ink">{marketTitle(m)}</div>
                  <div className="text-[12px] text-ink-2">
                    {m.symbol} · market #{m.marketId}
                  </div>
                </div>
                <SessionBadge m={m} />
              </div>
              <div className="mt-4 flex items-end justify-between gap-3">
                <div className="num text-[24px] font-medium">{m.price ? fmtPrice(toNum(m.price.price)) : "—"}</div>
                <div className="num text-right text-[12px] text-ink-2">
                  <PriceAge m={m} />
                  <div>up to {fmtLeverage(m.margin.orderLeverageCap)} · fee {fmtBps(m.fees.takerFeeBps)}</div>
                </div>
              </div>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function TradeRisks({ m }: { m: TradeMarket | null }) {
  return (
    <ul className="grid gap-4 md:grid-cols-2">
      {tradeRiskLines(m).map((l) => (
        <li key={l.title} className="rounded-card border border-line bg-surface p-4">
          <div className="text-[13.5px] font-semibold text-ink">{l.title}</div>
          <p className="mt-1 text-[12.5px] text-ink-2">{l.body}</p>
        </li>
      ))}
    </ul>
  );
}

export function EngineContract({ m }: { m: TradeMarket }) {
  return (
    <Card title="Contracts" description="Every transaction on this page is checked against the PoolEngine your book's adapter names on chain before your wallet opens." padding="md">
      <KV
        rows={[
          ["PoolEngine", <Hash key="e" value={m.engine} kind="address" />],
          ["Book adapter", <Hash key="a" value={m.adapter} kind="address" />],
          ["Underlying price id", <Hash key="u" value={m.underlying} kind="hash" />],
        ]}
      />
    </Card>
  );
}

/** The API's notes, the prepared transactions (verified, then signed in the wallet) and the confirmation. */
export function Prepared(props: { txs: PreparedTx[]; warnings: string[]; signer: string; amount?: bigint | null; doneText: ReactNode; onDone: () => void; onBack: () => void; children?: ReactNode }) {
  const refresh = useRefreshTrade();
  const [done, setDone] = useState(false);
  return (
    <div className="space-y-3">
      {props.warnings.length > 0 && !done && (
        <Callout tone="neutral" compact title="Before you sign">
          <ul className="list-disc space-y-1 pl-4">
            {props.warnings.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Callout>
      )}
      {!done && props.children}
      <TxRunner
        txs={props.txs}
        signer={props.signer}
        amount={props.amount}
        onConfirmed={() => {
          setDone(true);
          refresh();
        }}
      />
      {done ? (
        <Callout
          tone="success"
          compact
          title={props.doneText}
          action={
            <button type="button" className="btn btn-sm" onClick={props.onDone}>
              Done
            </button>
          }
        />
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" onClick={props.onBack}>
          Back
        </button>
      )}
    </div>
  );
}
