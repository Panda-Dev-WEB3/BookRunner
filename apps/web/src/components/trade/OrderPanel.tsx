// Order panel: long / short, a size in the settlement token or in units, the slippage limit, a live quote (fill,
// price impact, fee, the resulting position, its leverage and liquidation prices), then the prepared trade with a
// "you will sign" summary and the carried price's countdown. The API checks every engine rule again before it
// prepares the trade; TxRunner verifies the calldata against the chain's PoolEngine (and the entered size).
import { useState } from "react";
import { useNow } from "../../api/hooks";
import { trpc } from "../../api/trpc";
import type { TradeMarket, TradePositionOut, TradeQuoteOut } from "../../lib/api-types";
import { fmtBps, fmtPrice, fmtUsd, toNum } from "../../lib/format";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { WalletButton } from "../../wallet/WalletButton";
import { cx } from "../cx";
import { IconArrowRight } from "../icons";
import { Callout, Card, ErrorState, Field, Hash, KV, Segmented, Spinner } from "../ui";
import { Prepared } from "./TradeBits";
import {
  DEFAULT_SLIPPAGE_BPS,
  EFFECT_LABEL,
  SLIPPAGE_PRESETS_BPS,
  absUnitsText,
  decodeTradeCall,
  exactWad,
  tradeCallText,
  type Side,
  type SizeUnit,
  fmtLeverage,
  fmtUnits,
  leverageNote,
  notionalRaw,
  orderEffect,
  orderIssue,
  orderIssueText,
  parseSlippagePct,
  priceWadOf,
  secondsLeft,
  signedSize,
  sizeFromInput,
} from "./tradeLogic";
import { useTradeQuote } from "./useTrade";

const liqText = (v: string | null | undefined) => (v === "any" ? "at any price" : v ? fmtPrice(toNum(v)) : "none");

function QuoteDetails({ q, sym }: { q: TradeQuoteOut; sym: string }) {
  return (
    <KV
      rows={[
        ["Fill price", `${fmtPrice(toNum(q.fillPrice))} (oracle ${fmtPrice(toNum(q.oraclePrice))})`],
        ["Spread and skew", q.priceImpactBps === null ? "—" : fmtBps(Math.abs(q.priceImpactBps), { dp: 2 })],
        ["Notional", `${fmtUsd(q.notionalUsd)} ${sym}`],
        ["Fee", `${fmtUsd(q.feeUsd, { dp: 4 })} ${sym}`],
        q.realisedPnlUsd !== "0.000000" && ["Realised PnL", `${fmtUsd(q.realisedPnlUsd, { signed: true })} ${sym}`],
        ["Position after", q.after.side === "flat" ? "flat" : `${q.after.side} ${absUnitsText(q.after.size)} units`],
        q.after.side !== "flat" && ["Margin after", `${fmtUsd(q.after.marginUsd)} ${sym}`],
        q.after.side !== "flat" && ["Leverage after", fmtLeverage(q.after.leverage)],
        q.after.side !== "flat" && ["Margin ratio after", q.after.marginRatioBps === null ? "—" : fmtBps(q.after.marginRatioBps)],
        q.after.side !== "flat" && q.after.liquidationPrice !== null && ["Liquidation price", liqText(q.after.liquidationPrice)],
        q.after.side !== "flat" && q.after.liquidationPriceOffHours !== null && ["Liquidation price off-hours", liqText(q.after.liquidationPriceOffHours)],
      ]}
    />
  );
}

/** What the wallet will sign: the engine, the function and its arguments in words, and the price's deadline. */
/**
 * What the wallet will sign, decoded from the prepared CALLDATA (review I-1 / M-3): the engine it goes to, the side,
 * the exact size and the exact price limit of the encoded call (never the API's description or quote echo), and the
 * carried price's deadline. An undecodable step shows nothing to sign (TxRunner refuses it too).
 */
function SignSummary({ to, data, tradableUntil, slippageBps, now }: { to: string; data: string; tradableUntil: string | null; slippageBps: number; now: number }) {
  const left = secondsLeft(tradableUntil, now);
  const call = decodeTradeCall(data);
  if (!call) return <Callout tone="risk" compact title="This step is not a PoolEngine trade">Do not sign it; prepare the order again.</Callout>;
  return (
    <div className="rounded-card border border-line bg-surface-2 p-3">
      <div className="eyebrow mb-1 !text-ink">You will sign</div>
      <KV
        rows={[
          ["Contract", <Hash key="c" value={to} kind="address" />],
          ["Function", "PoolEngine.trade(marketId, sizeDelta, acceptablePrice, priceData)"],
          ["Order", `${tradeCallText(call)} in market #${call.marketId}`],
          [call.sizeDelta > 0n ? "Pays at most" : "Receives at least", `${exactWad(call.acceptablePriceWad)} per unit (slippage ${fmtBps(slippageBps)})`],
          ["Carried price", left === null ? "—" : left > 0 ? `valid for ${left} s more` : "expired: prepare again"],
        ]}
      />
    </div>
  );
}

/** The leverage rule of this deployment, always in view next to the order. */
export function LeverageNote({ m }: { m: TradeMarket }) {
  const text = leverageNote(m.margin);
  return (
    <Callout tone={m.margin.refusesUnholdable ? "neutral" : "warn"} compact title={text.title}>
      {text.body}
    </Callout>
  );
}

export function OrderPanel(props: { m: TradeMarket; address: string | null; position: TradePositionOut | undefined }) {
  const { m, address } = props;
  const sym = useSettlementSymbol();
  const now = useNow(1_000);
  const [side, setSide] = useState<Side>("buy");
  const [unit, setUnit] = useState<SizeUnit>("usd");
  const [value, setValue] = useState("");
  const [slip, setSlip] = useState((DEFAULT_SLIPPAGE_BPS / 100).toString());
  const order = trpc.trade.order.useMutation();
  const priceWad = priceWadOf(m.price?.price);
  const size = sizeFromInput(unit, value, priceWad);
  const delta = size === null ? null : signedSize(side, size);
  const posSize = props.position ? BigInt(props.position.sizeRaw) : 0n;
  const slippageBps = parseSlippagePct(slip);
  const quote = useTradeQuote(m.marketId, delta, address, slippageBps ?? DEFAULT_SLIPPAGE_BPS, delta !== null && slippageBps !== null);
  const q = quote.data && delta !== null && quote.data.sizeDelta === delta.toString() ? quote.data : undefined;
  const issue = orderIssue(m, posSize, delta, delta !== null && priceWad ? notionalRaw(delta, priceWad) : undefined);
  const issueText = issue === "no_size" ? null : orderIssueText(issue, m);
  const effect = delta !== null ? orderEffect(posSize, delta) : null;
  const locked = order.isPending || !!order.data;
  const reset = () => order.reset();
  const left = order.data ? secondsLeft(order.data.quote.tradableUntil, now) : null;

  const change = (f: () => void) => {
    f();
    if (order.data || order.error) reset();
  };

  return (
    <Card title="Order" description="A market order against the pool, filled at the carried oracle price plus the spread, or not at all." aria-label="Order">
      <div className="space-y-4">
        <Segmented
          ariaLabel="Side"
          layout="grid"
          value={side}
          onChange={(v) => change(() => setSide(v))}
          options={[
            { value: "buy", label: posSize < 0n ? "Buy (reduce short)" : "Long / buy" },
            { value: "sell", label: posSize > 0n ? "Sell (reduce long)" : "Short / sell" },
          ]}
        />
        <Field label="Size" htmlFor="trade-size" help={unit === "usd" ? `In ${sym} of notional, converted to units at the oracle price.` : "In units of the underlying (one unit follows one share)."}>
          <div className="flex gap-2">
            <input
              id="trade-size"
              className={cx("num h-11 min-w-0 flex-1 rounded-control border border-line-strong bg-surface px-3 text-[16px] outline-none focus:border-focus", locked && "opacity-70")}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={value}
              disabled={locked}
              onChange={(e) => change(() => setValue(e.target.value.replace(/[^0-9.]/g, "")))}
            />
            <Segmented
              ariaLabel="Size unit"
              value={unit}
              onChange={(v) => change(() => setUnit(v))}
              options={[
                { value: "usd", label: sym },
                { value: "units", label: "Units" },
              ]}
            />
          </div>
        </Field>
        {size !== null && priceWad && (
          <div className="num -mt-2 text-[12px] text-ink-2">
            {unit === "usd" ? `≈ ${fmtUnits(size)} units` : `≈ ${fmtUsd(notionalRaw(size, priceWad))} ${sym}`}
            {effect ? ` · ${EFFECT_LABEL[effect]}` : ""}
          </div>
        )}
        <Field label="Slippage limit" htmlFor="trade-slippage" error={slippageBps === null ? "Between 0.01% and 5%" : null} help="The fill may be this much worse than the quote at most; otherwise nothing fills.">
          <div className="flex flex-wrap items-center gap-2">
            {SLIPPAGE_PRESETS_BPS.map((b) => (
              <button key={b} type="button" className={cx("btn btn-sm", slippageBps === b && "btn-secondary")} disabled={locked} onClick={() => change(() => setSlip((b / 100).toString()))}>
                {b / 100}%
              </button>
            ))}
            <div className="flex items-center gap-1">
              <input
                id="trade-slippage"
                className="num h-8 w-20 rounded-control border border-line-strong bg-surface px-2 text-[13px] outline-none focus:border-focus"
                inputMode="decimal"
                value={slip}
                disabled={locked}
                onChange={(e) => change(() => setSlip(e.target.value.replace(/[^0-9.]/g, "")))}
              />
              <span className="text-[12.5px] text-ink-2">%</span>
            </div>
          </div>
        </Field>

        <LeverageNote m={m} />
        {issueText && (
          <Callout tone="warn" compact>
            {issueText}
          </Callout>
        )}
        {delta !== null && !issueText && !q && quote.isFetching && (
          <span className="inline-flex items-center gap-2 text-[12.5px] text-ink-2">
            <Spinner size={14} /> Quoting…
          </span>
        )}
        {quote.error && !q && <ErrorState compact error={quote.error} />}
        {q && !order.data && (
          <div className="space-y-3">
            <QuoteDetails q={q} sym={sym} />
            {q.refusal && (
              <Callout tone="risk" compact title="The engine would refuse this order">
                {q.refusal.message}
              </Callout>
            )}
            {!q.refusal &&
              q.warnings.map((w) => (
                <Callout key={w} tone="warn" compact>
                  {w}
                </Callout>
              ))}
          </div>
        )}

        {order.error && <ErrorState compact error={order.error} />}
        {order.isPending && (
          <span className="inline-flex items-center gap-2 text-[12.5px] text-ink-2">
            <Spinner size={14} /> Preparing the order with the latest signed price…
          </span>
        )}
        {order.data && address && (
          <Prepared
            txs={order.data.txs}
            warnings={order.data.warnings}
            signer={address}
            // the size this panel computed, not the API's echo: the verifier refuses a trade of any other size
            amount={delta}
            doneText="Order filled. Your position below is updated."
            onDone={() => {
              reset();
              setValue("");
            }}
            onBack={reset}
          >
            {order.data.txs[0] && <SignSummary to={order.data.txs[0].to} data={order.data.txs[0].data} tradableUntil={order.data.quote.tradableUntil} slippageBps={order.data.quote.slippageBps} now={now} />}
            {left === 0 && (
              <Callout
                tone="warn"
                compact
                title="The carried price has expired"
                action={
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      if (delta !== null && slippageBps !== null) order.mutate({ marketId: m.marketId, wallet: address, sizeDelta: delta.toString(), slippageBps });
                    }}
                  >
                    Prepare again
                  </button>
                }
              >
                A trade sent now would revert on the price bound and only cost gas.
              </Callout>
            )}
          </Prepared>
        )}

        {!order.data &&
          !order.isPending &&
          (!address ? (
            <div className="flex flex-col items-start gap-2">
              <WalletButton label="Connect a wallet to trade" />
              <span className="text-[12px] text-muted">Connecting only shares your address.</span>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-primary w-full sm:w-auto"
              disabled={delta === null || issue !== null || slippageBps === null || !q || q.refusal !== null}
              onClick={() => {
                if (delta !== null && slippageBps !== null) order.mutate({ marketId: m.marketId, wallet: address, sizeDelta: delta.toString(), slippageBps });
              }}
            >
              Review order
              <IconArrowRight size={14} />
            </button>
          ))}
      </div>
    </Card>
  );
}
