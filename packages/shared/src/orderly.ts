// Venue client contracts shared by ops-venue (implements), bookrunner-agent and risk (consume).
// Two implementations of QuotingVenue:
//   - OrderlyVenue  (services/ops-venue/src/orderly/*): Orderly REST v1 (VERIFY), or the local
//                    simulator services/mock-orderly when ORDERLY_MODE=mock.
//   - EngineVenue   (services/bookrunner-agent/src/venues/engine.ts): in-house PoolEngine; a "quote" is
//                    translated to desk.execute(SetQuote{spreadBps, skewBps, maxNetExposureUsd}).
//
// Orderly REST (VERIFY all paths/fields against https://orderly.network/docs before mainnet):
//   auth headers: orderly-account-id, orderly-key (ed25519 pubkey, "ed25519:<base58>"),
//                 orderly-timestamp (ms), orderly-signature = base64url(ed25519(`${ts}${METHOD}${path}${body}`))
//   POST   /v1/order                {symbol, order_type: "LIMIT"|"POST_ONLY", order_price, order_quantity, side: "BUY"|"SELL", client_order_id, reduce_only}
//   POST   /v1/batch-order          {orders: [...]}
//   DELETE /v1/orders?symbol=        cancel all for symbol
//   GET    /v1/positions             {data: {rows: [{symbol, position_qty, average_open_price, mark_price, unsettled_pnl}]}}
//   GET    /v1/client/holding        {data: {holding: [{token, holding, frozen}]}}
//   GET    /v1/trades?symbol&start_t {data: {rows: [{id, symbol, side, executed_price, executed_quantity, fee, executed_timestamp, is_maker}]}}
//   POST   /v1/withdraw_request      EIP-712 signed by the account's (delegate) signer
//   DELETE /v1/orderly_key           remove a trade key (key revocation)
//   Builder / Perp Anything (VERIFY): POST /v1/builder/symbol, POST /v1/builder/symbol/price_source,
//                 GET /v1/builder/insurance_fund?symbol, GET /v1/builder/fee_settlements?start_t
//   The mock adds: POST /mock/price {symbol, price, held}, POST /mock/taker {symbol, side, qty},
//                 POST /mock/settle (daily builder fee settlement now), GET /mock/state

export type Side = "BUY" | "SELL";

export interface QuoteLevel {
  px: number;
  qty: number; // units of underlying
}

export interface TwoSidedQuote {
  bid?: QuoteLevel;
  ask?: QuoteLevel;
  reduceOnly?: boolean;
}

export interface VenuePosition {
  symbol: string;
  netQty: number; // signed units
  avgPx: number;
  markPx: number;
  netExposureUsd: bigint; // signed USD 6dp (netQty * markPx)
  unrealizedPnlUsd: bigint;
}

export interface VenueFill {
  tradeId: string;
  symbol: string;
  side: "buy" | "sell"; // from the book's perspective
  qty: number;
  px: number;
  feeUsd: number; // positive = paid by the book; negative = rebate
  ts: number; // unix ms
  maker: boolean;
}

export interface VenueAccount {
  equityUsd: bigint; // USD 6dp, signed-safe as bigint
  freeCollateralUsd: bigint;
  position: VenuePosition | null;
}

/** What the bookrunner agent and the risk service need from a venue. */
export interface QuotingVenue {
  readonly kind: "orderly" | "engine";
  /** Cancel/replace the book's resting two-sided quote. Omitted side = no quote on that side. */
  replaceQuote(q: TwoSidedQuote): Promise<void>;
  cancelAll(): Promise<void>;
  account(): Promise<VenueAccount>;
  fillsSince(sinceMs: number): Promise<VenueFill[]>;
}

/** Builder-side operations (ops-venue only). */
export interface OrderlyBuilderApi {
  createSymbol(p: { symbol: string; baseAsset: string; priceSource: "builder" | "chainlink"; sessions: `0x${string}` }): Promise<{ symbol: string }>;
  setBuilderPrice(p: { symbol: string; price: number; held: boolean; ts: number }): Promise<void>;
  insuranceFund(symbol: string): Promise<{ balanceUsd: bigint }>;
  fundInsurance(p: { symbol: string; amountUsd: bigint }): Promise<void>;
  feeSettlements(sinceMs: number): Promise<Array<{ id: string; symbol: string; amountUsd: bigint; period: number; ts: number }>>;
  requestWithdraw(p: { accountId: string; amountUsd: bigint; to: `0x${string}`; nonce: string }): Promise<{ withdrawId: string }>;
  revokeTradeKey(p: { accountId: string; keyPrefix: string }): Promise<void>;
}
