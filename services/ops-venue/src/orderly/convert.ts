// Pure converters: Orderly REST payloads -> shared venue types (orderly.ts), and back.
import type { TwoSidedQuote, VenueAccount, VenueFill } from "@bookrunner/shared";
import { type Address, encodeAbiParameters, type Hex, keccak256, stringToHex } from "viem";

/** USD decimal (number or string) -> raw 6dp bigint, rounding to the nearest µUSD. */
export function usdRaw(x: unknown): bigint {
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : 0;
  if (!Number.isFinite(n)) return 0n;
  return BigInt(Math.round(n * 1e6));
}

export interface PositionsData {
  free_collateral?: number;
  total_collateral_value?: number;
  rows?: Array<Record<string, unknown>>;
}

export interface HoldingData {
  holding?: Array<{ token?: string; holding?: number; frozen?: number; isolated_margin?: number }>;
}

/**
 * Equity = settlement-token holding + isolated margin (Perp Anything markets are isolated-only; Orderly's
 * GET /v1/client/holding row carries `isolated_margin`) + Σ unsettled pnl (all symbols); the position is the one
 * for `symbol`. `token` is the settlement token symbol on Orderly ("USDC"; "USDG" on Robinhood Chain).
 */
export function toVenueAccount(symbol: string, pos: PositionsData, hold: HoldingData, token = "USDC"): VenueAccount {
  const want = token.toUpperCase();
  const usdc = (hold.holding ?? []).find((h) => String(h.token ?? "").toUpperCase() === want);
  const holding = Number(usdc?.holding ?? 0) + Number(usdc?.isolated_margin ?? 0);
  const frozen = Number(usdc?.frozen ?? 0);
  const rows = pos.rows ?? [];
  const upnlAll = rows.reduce((x, r) => x + Number(r.unsettled_pnl ?? 0), 0);
  const row = rows.find((r) => r.symbol === symbol);
  const qty = Number(row?.position_qty ?? 0);
  const markPx = Number(row?.mark_price ?? 0);
  const free = pos.free_collateral !== undefined ? Number(pos.free_collateral) : holding - frozen;
  return {
    equityUsd: usdRaw(holding + upnlAll),
    freeCollateralUsd: usdRaw(Math.max(0, free)),
    position:
      row && qty !== 0
        ? {
            symbol,
            netQty: qty,
            avgPx: Number(row.average_open_price ?? 0),
            markPx,
            netExposureUsd: usdRaw(qty * markPx),
            unrealizedPnlUsd: usdRaw(Number(row.unsettled_pnl ?? 0)),
          }
        : null,
  };
}

export function toVenueFill(r: Record<string, unknown>, fallbackSymbol: string): VenueFill {
  return {
    tradeId: String(r.id),
    symbol: String(r.symbol ?? fallbackSymbol),
    side: String(r.side).toUpperCase() === "BUY" ? "buy" : "sell",
    qty: Number(r.executed_quantity ?? 0),
    px: Number(r.executed_price ?? 0),
    feeUsd: Number(r.fee ?? 0),
    ts: Number(r.executed_timestamp ?? 0),
    maker: r.is_maker === undefined ? true : r.is_maker === true || Number(r.is_maker) === 1,
  };
}

/** Round to a tick: bids down, asks up (never tighter than intended). */
export function roundToTick(px: number, tick: number, dir: "down" | "up"): number {
  const n = dir === "down" ? Math.floor(px / tick + 1e-9) : Math.ceil(px / tick - 1e-9);
  const dp = Math.max(0, Math.ceil(-Math.log10(tick)));
  return Number((n * tick).toFixed(dp));
}

export function roundQty(q: number, tick: number): number {
  const n = Math.floor(q / tick + 1e-9);
  const dp = Math.max(0, Math.ceil(-Math.log10(tick)));
  return Number((n * tick).toFixed(dp));
}

export interface QuoteOrder {
  symbol: string;
  order_type: "LIMIT" | "POST_ONLY";
  side: "BUY" | "SELL";
  order_price: number;
  order_quantity: number;
  client_order_id: string;
  reduce_only: boolean;
}

/** Two-sided quote -> Orderly order bodies (empty sides and zero sizes dropped). */
export function quoteOrders(
  q: TwoSidedQuote,
  o: { symbol: string; orderType: "LIMIT" | "POST_ONLY"; priceTick: number; qtyTick: number; clientId: (side: "BUY" | "SELL") => string },
): QuoteOrder[] {
  const out: QuoteOrder[] = [];
  const add = (side: "BUY" | "SELL", px: number, qty: number) => {
    const price = roundToTick(px, o.priceTick, side === "BUY" ? "down" : "up");
    const quantity = roundQty(qty, o.qtyTick);
    if (!(price > 0) || !(quantity > 0)) return;
    out.push({ symbol: o.symbol, order_type: o.orderType, side, order_price: price, order_quantity: quantity, client_order_id: o.clientId(side), reduce_only: !!q.reduceOnly });
  };
  if (q.bid) add("BUY", q.bid.px, q.bid.qty);
  if (q.ask) add("SELL", q.ask.px, q.ask.qty);
  return out;
}

// ------------------------------------------------------------------ live builder / asset endpoints

/** GET /v1/broker/daily_fee_revenue accepts at most this many days per query (error -1103 beyond). */
export const FEE_REVENUE_MAX_DAYS = 180;

export interface DailyFeeRevenueData {
  rows?: Array<{
    date?: string;
    permissionless_listing_fee_share?: number | string;
    distributor_fee_share?: number | string;
    builder_fee_revenue?: number | string;
    cross_broker_fee?: number | string;
    total_revenue?: number | string;
  }>;
}

/** Broker-wide row (no symbol in Orderly's revenue report): see domain/fees.ts BROKER_WIDE. */
const BROKER_WIDE_SYMBOL = "*";

/**
 * Orderly daily builder revenue -> settlement rows. `date` is the settlement date (00:00 UTC of the day after
 * the revenue day), i.e. the end of the revenue day: the row's period label. Only the Perp Anything share
 * (`permissionless_listing_fee_share`, 50% of base taker fees on the builder's markets) is protocol revenue.
 */
export function parseDailyFeeRevenue(d: DailyFeeRevenueData): Array<{ id: string; symbol: string; amountUsd: bigint; period: number; ts: number }> {
  const out: Array<{ id: string; symbol: string; amountUsd: bigint; period: number; ts: number }> = [];
  for (const r of d.rows ?? []) {
    const ms = Date.parse(`${String(r.date ?? "")}T00:00:00Z`);
    if (!Number.isFinite(ms)) continue;
    out.push({ id: `fee-revenue:${r.date}`, symbol: BROKER_WIDE_SYMBOL, amountUsd: usdRaw(r.permissionless_listing_fee_share ?? 0), period: Math.floor(ms / 1000), ts: ms });
  }
  return out;
}

/** Inclusive [from, to] YYYY-MM-DD windows of at most `maxDays` days covering [startMs, endMs]. */
export function dateWindows(startMs: number, endMs: number, maxDays: number): Array<[string, string]> {
  const DAY = 86_400_000;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  let from = Math.floor(startMs / DAY) * DAY;
  const last = Math.floor(endMs / DAY) * DAY;
  const out: Array<[string, string]> = [];
  while (from <= last) {
    const to = Math.min(last, from + (maxDays - 1) * DAY);
    out.push([day(from), day(to)]);
    from = to + DAY;
  }
  return out;
}

export interface AssetHistoryRow {
  id: string;
  status: string;
  txHash: string | null;
  amountUsd: bigint;
  clientRef: string | null;
  receiver: string | null;
  createdAt: number | null;
}

/**
 * GET /v1/asset/history rows -> withdrawal records. Orderly: {id (string), tx_id, side, token, amount (token
 * units, decimal), fee, trans_status, created_time, updated_time, chain_id}; the mock adds client_ref / receiver.
 */
export function parseAssetHistory(d: { rows?: Array<Record<string, unknown>> }): AssetHistoryRow[] {
  return (d.rows ?? []).map((w) => ({
    id: String(w.id),
    status: String(w.trans_status ?? w.status ?? ""),
    txHash: w.tx_id ? String(w.tx_id) : null,
    amountUsd: usdRaw(w.amount),
    clientRef: w.client_ref ? String(w.client_ref) : null,
    receiver: w.receiver ? String(w.receiver) : null,
    createdAt: w.created_time == null || !Number.isFinite(Number(w.created_time)) ? null : Number(w.created_time),
  }));
}

/** Orderly account id (confirmed, contract-evm Utils.calculateAccountId): keccak256(abi.encode(address user, keccak256(bytes(brokerId)))). */
export function orderlyAccountId(user: Address, brokerId: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [user, keccak256(stringToHex(brokerId))]));
}
