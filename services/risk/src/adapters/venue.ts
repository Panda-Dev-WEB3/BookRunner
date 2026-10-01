// Live venue access for the risk service, coded against the shared QuotingVenue contract
// (packages/shared/src/orderly.ts).
//
// The canonical OrderlyVenue lives in services/ops-venue/src/client.ts (built in parallel). Until it
// is wired in, risk ships a minimal QuotingVenue of its own: account()/fillsSince() reads and
// cancelAll() — exactly what risk needs; replaceQuote() is deliberately unsupported (risk never
// quotes). To switch, return `new OrderlyVenue(...)` from OrderlyVenueProvider.forBook.
//
// VERIFY every path / field below against https://orderly.network/docs (shapes per orderly.ts).
import {
  type Logger,
  type QuotingVenue,
  type TwoSidedQuote,
  VENUE,
  type VenueAccount,
  type VenueFill,
  type VenuePosition,
  usd,
} from "@bookrunner/shared";
import type { VenueProvider } from "../ports";
import type { BookRef } from "../types";
import { errMsg } from "../util/async";
import { type OrderlySigner, orderlyAuthHeaders } from "./orderlyAuth";

export interface OrderlyRiskVenueOptions {
  baseUrl: string;
  accountId: string;
  symbol: string;
  signer: OrderlySigner | null;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

interface OrderlyEnvelope<T> {
  success?: boolean;
  data?: T;
  message?: string;
}

interface PositionRow {
  symbol: string;
  position_qty: number;
  average_open_price?: number;
  mark_price?: number;
  unsettled_pnl?: number;
}

interface HoldingRow {
  token: string;
  holding: number;
  frozen?: number;
}

interface TradeRow {
  id: string | number;
  symbol: string;
  side: string;
  executed_price: number;
  executed_quantity: number;
  fee?: number;
  executed_timestamp: number;
  is_maker?: boolean | number;
}

const n = (x: unknown): number => (typeof x === "number" ? x : typeof x === "string" ? Number(x) : 0) || 0;

export class OrderlyRiskVenue implements QuotingVenue {
  readonly kind = "orderly" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly o: OrderlyRiskVenueOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.nowMs ?? (() => Date.now());
  }

  async replaceQuote(_q: TwoSidedQuote): Promise<void> {
    throw new Error("the risk service venue client never quotes (cancel/read only)");
  }

  /** DELETE /v1/orders?symbol= — cancel every resting order of the book's symbol. */
  async cancelAll(): Promise<void> {
    await this.request("DELETE", `/v1/orders?symbol=${encodeURIComponent(this.o.symbol)}`);
  }

  async account(): Promise<VenueAccount> {
    const [pos, hold] = await Promise.all([
      this.request<{ rows?: PositionRow[] }>("GET", "/v1/positions"),
      this.request<{ holding?: HoldingRow[] }>("GET", "/v1/client/holding"),
    ]);
    const rows = pos?.rows ?? [];
    const holding = hold?.holding ?? [];
    const usdc = holding.find((h) => h.token?.toUpperCase() === "USDC");
    const cash = n(usdc?.holding);
    const frozen = n(usdc?.frozen);
    // VERIFY: equity = USDC holding + unsettled PnL across positions (Orderly's total collateral view)
    const unsettled = rows.reduce((s, r) => s + n(r.unsettled_pnl), 0);
    const row = rows.find((r) => r.symbol === this.o.symbol);
    let position: VenuePosition | null = null;
    if (row && n(row.position_qty) !== 0) {
      const qty = n(row.position_qty);
      const markPx = n(row.mark_price);
      const avgPx = n(row.average_open_price);
      position = {
        symbol: row.symbol,
        netQty: qty,
        avgPx,
        markPx,
        netExposureUsd: usd(qty * markPx),
        unrealizedPnlUsd: usd(row.unsettled_pnl !== undefined ? n(row.unsettled_pnl) : (markPx - avgPx) * qty),
      };
    }
    return { equityUsd: usd(cash + unsettled), freeCollateralUsd: usd(Math.max(0, cash - frozen)), position };
  }

  async fillsSince(sinceMs: number): Promise<VenueFill[]> {
    const data = await this.request<{ rows?: TradeRow[] }>(
      "GET",
      `/v1/trades?symbol=${encodeURIComponent(this.o.symbol)}&start_t=${Math.floor(sinceMs)}`,
    );
    return (data?.rows ?? []).map((t) => ({
      tradeId: String(t.id),
      symbol: t.symbol,
      side: String(t.side).toUpperCase() === "BUY" ? "buy" : "sell",
      qty: n(t.executed_quantity),
      px: n(t.executed_price),
      feeUsd: n(t.fee),
      ts: n(t.executed_timestamp),
      maker: !!t.is_maker,
    }));
  }

  private async request<T>(method: string, pathWithQuery: string, body?: unknown): Promise<T | undefined> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers = await orderlyAuthHeaders(this.o.signer, this.o.accountId, method, pathWithQuery, raw, this.now());
    if (raw) headers["content-type"] = "application/json";
    const res = await this.fetchImpl(`${this.o.baseUrl.replace(/\/$/, "")}${pathWithQuery}`, {
      method,
      headers,
      body: raw || undefined,
      signal: AbortSignal.timeout(this.o.timeoutMs),
    });
    const text = await res.text();
    let json: OrderlyEnvelope<T> | undefined;
    try {
      json = text ? (JSON.parse(text) as OrderlyEnvelope<T>) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok || json?.success === false) {
      throw new Error(`orderly ${method} ${pathWithQuery} -> ${res.status} ${json?.message ?? text.slice(0, 200)}`);
    }
    return json?.data;
  }
}

/** Charter symbol -> Orderly symbol. VERIFY naming (devnet/mock: PERP_<TICKER>_USDC). */
export function venueSymbol(symbol: string): string {
  return symbol.startsWith("PERP_") ? symbol : `PERP_${symbol}_USDC`;
}

export interface OrderlyVenueProviderOptions {
  mode: "mock" | "live";
  baseUrl: string;
  signer: OrderlySigner | null;
  timeoutMs: number;
  /** MM account id lookup (adapter.accountId(MM) on-chain, venue_accounts fallback). */
  accountIdOf: (ref: BookRef) => Promise<string | null>;
  log: Logger;
}

export class OrderlyVenueProvider implements VenueProvider {
  private warnedNoKey = false;

  constructor(private readonly o: OrderlyVenueProviderOptions) {}

  async forBook(ref: BookRef): Promise<QuotingVenue | null> {
    if (ref.venue !== VENUE.ORDERLY) return null; // engine books: cancel-all == adapter reduce-only
    if (this.o.mode === "live" && !this.o.signer) {
      if (!this.warnedNoKey) this.o.log.warn("ORDERLY_MODE=live without RISK_ORDERLY_SECRET: no live venue client (adapter reports only)");
      this.warnedNoKey = true;
      return null;
    }
    let accountId: string | null = null;
    try {
      accountId = await this.o.accountIdOf(ref);
    } catch (err) {
      this.o.log.warn({ bookId: ref.bookId, err: errMsg(err) }, "orderly account id lookup failed");
      throw err;
    }
    if (!accountId) return null;
    return new OrderlyRiskVenue({
      baseUrl: this.o.baseUrl,
      accountId,
      symbol: venueSymbol(ref.symbol),
      signer: this.o.signer,
      timeoutMs: this.o.timeoutMs,
    });
  }
}
