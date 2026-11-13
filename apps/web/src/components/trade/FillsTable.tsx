// The connected wallet's trade and PnL history (trade.fills: from the indexed engine events, never Redis): trades,
// liquidations, wind-down close-outs, margin deposits / withdrawals and funding, newest first, paged; realised PnL,
// fees, funding and net above; a CSV export built in the browser from every page.
import { useState } from "react";
import { useOptional } from "../../api/hooks";
import { untypedClient } from "../../api/trpc";
import type { TradeFill, TradeFillsOut, TradeMarket } from "../../lib/api-types";
import { fmtDateTime, fmtPrice, fmtUsd, toNum } from "../../lib/format";
import { useSettlementSymbol } from "../../wallet/settlementSymbol";
import { cx } from "../cx";
import { Callout, Card, EmptyState, ErrorState, Hash, KV, Segmented, SkeletonRows, Spinner, Table, Td, Th } from "../ui";
import { FILLS_EXPORT_PAGE, FILLS_PAGE_SIZE, FILL_KIND_LABEL, fillsCsv, fillsCsvName } from "./historyLogic";
import { absUnitsText } from "./tradeLogic";

const parseFills = (raw: unknown): TradeFillsOut | null => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as TradeFillsOut) : null);

function Signed({ v, sym, dp = 2 }: { v: string | null; sym: string; dp?: number }) {
  if (v === null) return <span className="text-muted">—</span>;
  const n = toNum(v) ?? 0;
  return <span className={cx(n < 0 ? "text-critical-ink" : n > 0 ? "text-good-ink" : undefined)}>{`${fmtUsd(v, { signed: true, dp })} ${sym}`}</span>;
}

function amountOf(r: TradeFill, sym: string) {
  if (r.kind === "deposit" || r.kind === "withdrawal") return <Signed v={r.marginUsd} sym={sym} />;
  if (r.kind === "funding") return <Signed v={r.fundingUsd === null ? null : (-(toNum(r.fundingUsd) ?? 0)).toFixed(6)} sym={sym} dp={4} />;
  return <Signed v={r.realisedPnlUsd} sym={sym} />;
}

async function fetchAll(wallet: string, marketId: number | undefined): Promise<TradeFill[]> {
  const rows: TradeFill[] = [];
  for (let offset = 0; offset < 100_000; offset += FILLS_EXPORT_PAGE) {
    const page = parseFills(await untypedClient.query("trade.fills", { wallet, ...(marketId ? { marketId } : {}), offset, limit: FILLS_EXPORT_PAGE }));
    if (!page) break;
    rows.push(...page.rows);
    if (rows.length >= page.total || page.rows.length === 0) break;
  }
  return rows;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function FillsTable({ m, address, markets }: { m: TradeMarket; address: string; markets: Array<Pick<TradeMarket, "marketId" | "symbol">> }) {
  const sym = useSettlementSymbol();
  const [scope, setScope] = useState<"market" | "all">("market");
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState<"idle" | "busy" | "failed">("idle");
  const marketId = scope === "market" ? m.marketId : undefined;
  const q = useOptional("trade.fills", { wallet: address, ...(marketId ? { marketId } : {}), offset: page * FILLS_PAGE_SIZE, limit: FILLS_PAGE_SIZE }, parseFills, { refetchInterval: 15_000 });
  const d = q.data?.supported ? q.data.data : null;
  const label = (id: number) => markets.find((x) => x.marketId === id)?.symbol ?? (id === m.marketId ? m.symbol : `#${id}`);
  const pages = d ? Math.max(1, Math.ceil(d.total / FILLS_PAGE_SIZE)) : 1;

  const exportCsv = async () => {
    setExporting("busy");
    try {
      const rows = await fetchAll(address, marketId);
      download(fillsCsvName(address, marketId ? label(marketId) : null, Date.now()), fillsCsv(rows, { settlementSymbol: sym, marketLabel: label }));
      setExporting("idle");
    } catch {
      setExporting("failed");
    }
  };

  return (
    <Card
      title="Your trade history"
      description="From the engine's own events on chain, indexed: your trades, liquidations, margin and funding, with the realised PnL and the fees paid."
      actions={
        <Segmented
          ariaLabel="Markets shown"
          size="sm"
          value={scope}
          onChange={(v) => {
            setScope(v);
            setPage(0);
          }}
          options={[
            { value: "market", label: "This market" },
            { value: "all", label: "All markets" },
          ]}
        />
      }
      aria-label="Trade history"
    >
      {q.data?.supported === false ? (
        <EmptyState compact title="This API does not serve the trade history yet" />
      ) : q.error && !d ? (
        <ErrorState compact error={q.error} onRetry={() => void q.refetch()} />
      ) : !d ? (
        <SkeletonRows rows={3} />
      ) : d.total === 0 ? (
        <EmptyState compact title="No trade yet" body="Your trades, margin and funding show here once they are on chain." />
      ) : (
        <div className="space-y-4">
          <KV
            rows={[
              ["Realised PnL", <Signed key="p" v={d.totals.realisedPnlUsd} sym={sym} />],
              ["Fees paid", `${fmtUsd(d.totals.feesUsd)} ${sym} (trading ${fmtUsd(d.totals.tradingFeesUsd)}, liquidation ${fmtUsd(d.totals.liquidationFeesUsd)})`],
              ["Funding", <Signed key="f" v={(-(toNum(d.totals.fundingUsd) ?? 0)).toFixed(6)} sym={sym} dp={4} />],
              ["Net (PnL - fees + funding)", <Signed key="n" v={d.totals.netUsd} sym={sym} />],
              ["Margin in / out", `${fmtUsd(d.totals.depositedUsd)} / ${fmtUsd(d.totals.withdrawnUsd)} ${sym}`],
            ]}
          />
          {d.totals.unknownPnl > 0 && (
            <Callout tone="neutral" compact>
              {d.totals.unknownPnl === 1 ? "One liquidation's" : `${d.totals.unknownPnl} liquidations'`} realised PnL could not be rebuilt from the indexed history (its entry price is missing) and is left out of the totals.
            </Callout>
          )}
          {d.truncated && (
            <Callout tone="warn" compact>
              Only the first 10,000 events of this wallet are read: the newest are missing here.
            </Callout>
          )}
          <Table minWidth={860}>
            <thead>
              <tr>
                <Th>Time</Th>
                {scope === "all" && <Th>Market</Th>}
                <Th>Type</Th>
                <Th right>Size</Th>
                <Th right>Price</Th>
                <Th right>Fee</Th>
                <Th right title="Realised PnL of a trade or liquidation; margin moved; funding received (+) or paid (-)">
                  PnL / amount
                </Th>
                <Th>Transaction</Th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.id}>
                  <Td num>{fmtDateTime(r.at)}</Td>
                  {scope === "all" && <Td>{label(r.marketId)}</Td>}
                  <Td>
                    {FILL_KIND_LABEL[r.kind]}
                    {r.side && <span className="text-ink-2"> · {r.side === "buy" ? "buy" : "sell"}</span>}
                    {r.badDebtUsd !== null && (toNum(r.badDebtUsd) ?? 0) > 0 && <span className="text-ink-2"> · bad debt {fmtUsd(r.badDebtUsd)}</span>}
                  </Td>
                  <Td right num>
                    {r.size === null ? "—" : absUnitsText(r.size)}
                  </Td>
                  <Td right num>
                    {r.price === null ? "—" : fmtPrice(toNum(r.price))}
                  </Td>
                  <Td right num>
                    {(toNum(r.feeUsd) ?? 0) > 0 ? fmtUsd(r.feeUsd, { dp: 4 }) : "—"}
                  </Td>
                  <Td right num>
                    {amountOf(r, sym)}
                  </Td>
                  <Td>
                    <Hash value={r.txHash} kind="tx" />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-3 text-[12.5px]">
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                Newer
              </button>
              <span className="num text-ink-2">
                {d.offset + 1}–{d.offset + d.rows.length} of {d.total}
              </span>
              <button type="button" className="btn btn-sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}>
                Older
              </button>
            </div>
            <div className="flex items-center gap-2">
              {exporting === "failed" && <span className="text-critical-ink">The export failed; try again.</span>}
              <button type="button" className="btn btn-sm" disabled={exporting === "busy"} onClick={() => void exportCsv()}>
                {exporting === "busy" ? <Spinner size={12} /> : null}
                Export CSV
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
