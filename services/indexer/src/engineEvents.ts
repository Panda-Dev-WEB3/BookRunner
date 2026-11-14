// PoolEngine trader events (trading page v2, 2026-11): every Trade / Liquidation / ClosedOut / MarginChanged /
// FundingSettled log -> one engine_trader_events row, the source of the page's trade and PnL history (`trade.fills`).
// Raw on-chain values only (no unit or price conversion here: the API reads them through the shared engine helpers).
// Idempotent per (tx, logIndex). Runs next to the position handlers (engineHandlers.ts, the liquidation keeper's
// trader set), which it leaves unchanged.
import { arg } from "./convert";
import type { Handler } from "./handlers";
import type { EngineTraderEventRow } from "./store";

type Fields = Omit<EngineTraderEventRow, "txHash" | "logIndex" | "block" | "ts" | "marketId" | "trader">;

const ev = (traderKey: string, f: (a: Record<string, unknown>) => Fields): Handler =>
  async ({ log, ts, store }) => {
    await store.insertEngineTraderEvent({
      txHash: log.txHash.toLowerCase(),
      logIndex: log.logIndex,
      block: Number(log.blockNumber),
      ts,
      marketId: arg.num(log.args, "marketId"),
      trader: arg.addr(log.args, traderKey),
      ...f(log.args),
    });
  };

const s = (a: Record<string, unknown>, k: string) => arg.big(a, k).toString();

export const ENGINE_EVENT_HANDLERS: Record<string, Handler> = {
  "engine.Trade": ev("trader", (a) => ({
    kind: "trade",
    sizeRaw: s(a, "sizeDelta"),
    newSizeRaw: s(a, "newSize"),
    priceWad: s(a, "fillPriceWad"),
    feeRaw: s(a, "feeUsd"),
    pnlRaw: s(a, "realizedPnlUsd"),
  })),
  "engine.Liquidation": ev("trader", (a) => ({
    kind: "liquidation",
    sizeRaw: s(a, "size"),
    newSizeRaw: "0",
    priceWad: s(a, "priceWad"),
    feeRaw: s(a, "feeUsd"),
    badDebtRaw: s(a, "badDebtUsd"),
    counterparty: arg.addr(a, "liquidator"),
  })),
  "engine.ClosedOut": ev("trader", (a) => ({
    kind: "closed_out",
    sizeRaw: s(a, "size"),
    newSizeRaw: "0",
    priceWad: s(a, "priceWad"),
    badDebtRaw: s(a, "badDebtUsd"),
    counterparty: arg.addr(a, "by"),
  })),
  "engine.MarginChanged": ev("trader", (a) => ({ kind: "margin", marginDeltaRaw: s(a, "delta") })),
  "engine.FundingSettled": ev("trader", (a) => ({ kind: "funding", fundingRaw: s(a, "owedUsd") })),
};

/** The position handlers with the trader-event handler of the same log run after each (and FundingSettled added). */
export function withEngineEvents(base: Record<string, Handler>): Record<string, Handler> {
  const out: Record<string, Handler> = { ...base };
  for (const [k, h] of Object.entries(ENGINE_EVENT_HANDLERS)) {
    const first = base[k];
    out[k] = first
      ? async (ctx) => {
          await first(ctx);
          await h(ctx);
        }
      : h;
  }
  return out;
}
