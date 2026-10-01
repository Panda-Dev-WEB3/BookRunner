// Orderly books. The production QuotingVenue (`OrderlyVenue`, ed25519-signed REST) is owned by
// ops-venue (services/ops-venue/src/client.ts) and injected here. Until it is available in the
// workspace, mock mode falls back to MockOrderlyHttpVenue: a minimal client for the local
// mock-orderly simulator (permissive auth in dev), using the REST paths documented in
// packages/shared/src/orderly.ts. Live mode never uses the fallback (it cannot sign requests).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { QuotingVenue, TwoSidedQuote, VenueAccount, VenueFill } from "@bookrunner/shared";

export interface OrderlyVenueOptions {
  bookId: number;
  symbol: string;
  /** Orderly account id of the book's MM account (adapter.accountId(MM)). */
  accountId: string;
  baseUrl: string;
  mode: "mock" | "live";
  env: Record<string, string | undefined>;
}

export type OrderlyVenueFactory = (opts: OrderlyVenueOptions) => QuotingVenue | Promise<QuotingVenue>;

export const OPS_VENUE_CLIENT_PATH = resolve(import.meta.dir, "../../../ops-venue/src/client.ts");

function isQuotingVenue(v: unknown): v is QuotingVenue {
  const o = v as Record<string, unknown> | null;
  return !!o && ["replaceQuote", "cancelAll", "account", "fillsSince"].every((k) => typeof o[k] === "function");
}

/**
 * Load ops-venue's OrderlyVenue. Accepted module shapes (integration contract):
 *   export function createOrderlyVenue(opts: OrderlyVenueOptions): QuotingVenue | Promise<QuotingVenue>
 *   export class OrderlyVenue { constructor(opts: OrderlyVenueOptions) }
 * Returns null when the module is absent or exports neither.
 */
export async function loadOpsVenueFactory(path = OPS_VENUE_CLIENT_PATH): Promise<OrderlyVenueFactory | null> {
  if (!existsSync(path)) return null;
  const mod: Record<string, unknown> = await import(pathToFileURL(path).href);
  const create = mod.createOrderlyVenue;
  if (typeof create === "function") {
    return async (opts) => {
      const v: unknown = await (create as (o: OrderlyVenueOptions) => unknown)(opts);
      if (!isQuotingVenue(v)) throw new Error("ops-venue createOrderlyVenue() produced something other than a QuotingVenue");
      return v;
    };
  }
  const Ctor = mod.OrderlyVenue;
  if (typeof Ctor === "function") {
    return (opts) => {
      const v: unknown = new (Ctor as new (o: OrderlyVenueOptions) => unknown)(opts);
      if (!isQuotingVenue(v)) throw new Error("ops-venue OrderlyVenue is not a QuotingVenue");
      return v;
    };
  }
  return null;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

interface OrderlyEnvelope<T> {
  success?: boolean;
  data?: T;
  message?: string;
}

/** Minimal mock-orderly client (dev only). VERIFY field names against services/mock-orderly. */
export class MockOrderlyHttpVenue implements QuotingVenue {
  readonly kind = "orderly" as const;
  private seq = 0;

  constructor(
    private readonly opts: Pick<OrderlyVenueOptions, "bookId" | "symbol" | "accountId" | "baseUrl">,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        "content-type": "application/json",
        "orderly-account-id": this.opts.accountId,
        "orderly-timestamp": String(Date.now()),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`orderly ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    const json = (text ? JSON.parse(text) : {}) as OrderlyEnvelope<T>;
    if (json.success === false) throw new Error(`orderly ${method} ${path} failed: ${json.message ?? text.slice(0, 300)}`);
    return (json.data ?? (json as unknown)) as T;
  }

  async cancelAll(): Promise<void> {
    await this.call("DELETE", `/v1/orders?symbol=${encodeURIComponent(this.opts.symbol)}`);
  }

  async replaceQuote(q: TwoSidedQuote): Promise<void> {
    await this.cancelAll();
    const orders: Array<Record<string, unknown>> = [];
    const push = (side: "BUY" | "SELL", px: number, qty: number) => {
      this.seq++;
      orders.push({
        symbol: this.opts.symbol,
        order_type: "LIMIT",
        order_price: px,
        order_quantity: qty,
        side,
        client_order_id: `bk${this.opts.bookId}-${side[0]}-${Date.now()}-${this.seq}`,
        reduce_only: !!q.reduceOnly,
      });
    };
    if (q.bid && q.bid.qty > 0) push("BUY", q.bid.px, q.bid.qty);
    if (q.ask && q.ask.qty > 0) push("SELL", q.ask.px, q.ask.qty);
    if (orders.length === 0) return;
    await this.call("POST", "/v1/batch-order", { orders });
  }

  async account(): Promise<VenueAccount> {
    const [pos, hold] = await Promise.all([
      this.call<{ rows?: Array<Record<string, unknown>> }>("GET", "/v1/positions"),
      this.call<{ holding?: Array<Record<string, unknown>> }>("GET", "/v1/client/holding"),
    ]);
    const row = (pos.rows ?? []).find((r) => r.symbol === this.opts.symbol);
    const usdc = (hold.holding ?? []).find((h) => String(h.token).toUpperCase() === "USDC");
    const holding = Number(usdc?.holding ?? 0);
    const frozen = Number(usdc?.frozen ?? 0);
    const qty = Number(row?.position_qty ?? 0);
    const markPx = Number(row?.mark_price ?? 0);
    const upnl = Number(row?.unsettled_pnl ?? 0);
    const raw = (x: number) => BigInt(Math.round((Number.isFinite(x) ? x : 0) * 1e6));
    return {
      equityUsd: raw(holding + upnl),
      freeCollateralUsd: raw(Math.max(0, holding - frozen)),
      position: row
        ? {
            symbol: this.opts.symbol,
            netQty: qty,
            avgPx: Number(row.average_open_price ?? 0),
            markPx,
            netExposureUsd: raw(qty * markPx),
            unrealizedPnlUsd: raw(upnl),
          }
        : null,
    };
  }

  async fillsSince(sinceMs: number): Promise<VenueFill[]> {
    const data = await this.call<{ rows?: Array<Record<string, unknown>> }>(
      "GET",
      `/v1/trades?symbol=${encodeURIComponent(this.opts.symbol)}&start_t=${Math.floor(sinceMs)}`,
    );
    return (data.rows ?? [])
      .map((r) => ({
        tradeId: String(r.id),
        symbol: String(r.symbol ?? this.opts.symbol),
        side: String(r.side).toUpperCase() === "BUY" ? ("buy" as const) : ("sell" as const),
        qty: Number(r.executed_quantity ?? 0),
        px: Number(r.executed_price ?? 0),
        feeUsd: Number(r.fee ?? 0),
        ts: Number(r.executed_timestamp ?? 0),
        maker: r.is_maker === undefined ? true : !!r.is_maker,
      }))
      .filter((f) => f.ts >= sinceMs && f.qty > 0);
  }
}

/** ops-venue OrderlyVenue when available; mock fallback in mock mode; error in live mode. */
export async function createOrderlyVenue(
  opts: OrderlyVenueOptions,
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
  loader: () => Promise<OrderlyVenueFactory | null> = () => loadOpsVenueFactory(),
): Promise<QuotingVenue> {
  let factory: OrderlyVenueFactory | null = null;
  try {
    factory = await loader();
  } catch (err) {
    log.warn({ err: String(err) }, "ops-venue OrderlyVenue failed to load");
  }
  if (factory) {
    log.info({ symbol: opts.symbol, mode: opts.mode }, "using ops-venue OrderlyVenue");
    return factory(opts);
  }
  if (opts.mode === "live") throw new Error("ORDERLY_MODE=live requires ops-venue's OrderlyVenue (services/ops-venue/src/client.ts)");
  log.warn({ symbol: opts.symbol, baseUrl: opts.baseUrl }, "ops-venue OrderlyVenue not available: using the local mock-orderly HTTP client");
  return new MockOrderlyHttpVenue(opts);
}
