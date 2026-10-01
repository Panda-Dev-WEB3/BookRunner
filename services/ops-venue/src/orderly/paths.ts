// Orderly REST v1 endpoint table. Status as researched on orderly.network/docs (2026-10):
//   [confirmed] = path + method + main fields seen in the API reference
//   VERIFY      = assumed / mock-contract path; check before mainnet
// Trading/account/key/withdraw paths are identical in mock and live mode (mock-orderly implements
// them). Builder (Perp Anything) operations differ: the mock implements the shared mock contract
// (/v1/builder/*), live uses the broker listing API (and implements the same aliases in the mock).
export const ORDERLY_PATHS = {
  // trading (scope "trading")
  order: "/v1/order", // POST [confirmed] {symbol, order_type, order_price, order_quantity, side, client_order_id(<=36), reduce_only}; 10 req/s
  batchOrder: "/v1/batch-order", // POST [confirmed] {orders: [...]} max 10; data.rows[].error_message; 1 req/s
  cancelAll: "/v1/orders", // DELETE [confirmed] ?symbol= optional -> data.status "CANCEL_ALL_SENT"; 10 req/s
  // account (scope "read")
  positions: "/v1/positions", // GET [confirmed] data{free_collateral,total_collateral_value,rows[{symbol,position_qty,average_open_price,mark_price,unsettled_pnl,...}]}
  holding: "/v1/client/holding", // GET [confirmed] data.holding[{token,holding,frozen,pending_short,updated_time}]
  trades: "/v1/trades", // GET [confirmed] ?symbol&start_t&end_t&page&size(<=500) rows[{id,symbol,fee,side,executed_price,executed_quantity,executed_timestamp,is_maker,...}]
  assetHistory: "/v1/asset/history", // GET VERIFY ?side=WITHDRAW -> rows[{id, trans_status, tx_id, amount, ...}]
  // keys
  addKey: "/v1/orderly_key", // POST [confirmed] {message: AddOrderlyKey, signature, userAddress}; scopes read|trading|asset (comma list), max 365 d
  addDelegateKey: "/v1/delegate_orderly_key", // POST [confirmed path] {message: DelegateAddOrderlyKey, signature, userAddress}
  keyInfo: "/v1/client/key_info", // GET VERIFY lists the account's orderly keys
  removeKey: "/v1/client/remove_orderly_key", // POST [confirmed] {orderly_key}
  // withdrawals (EIP-712, see eip712.ts)
  withdrawNonce: "/v1/withdraw_nonce", // GET [confirmed] -> data.withdraw_nonce
  withdraw: "/v1/withdraw_request", // POST [confirmed] {message: Withdraw, signature, userAddress, verifyingContract} -> data.withdraw_id
  delegateWithdraw: "/v1/delegate_signer_withdraw_request", // POST [confirmed path] VERIFY body (DelegateWithdraw)
  internalTransfer: "/v1/internal_transfer", // POST VERIFY {token, amount, receiver_account_id}
  publicInsuranceFund: "/v1/public/insurancefund", // GET [confirmed path] VERIFY row shape
  publicInfo: "/v1/public/info", // GET /{symbol} VERIFY -> {quote_tick, base_tick, min_notional, ...}
} as const;

export const BUILDER_PATHS = {
  mock: {
    createSymbol: "/v1/builder/symbol",
    priceSource: "/v1/builder/symbol/price_source",
    symbolStatus: "/v1/builder/symbol/status",
    insuranceFund: "/v1/builder/insurance_fund",
    feeSettlements: "/v1/builder/fee_settlements",
  },
  live: {
    // Perp Anything listing (docs: user-flows/builder-oracle, perp-anything/rwa-markets) — VERIFY bodies.
    oracleFeed: "/v1/broker/listing/oracle/feed", // POST {base_ccy, visibility, status}
    symbolContext: "/v1/broker/listing/symbol_context", // POST (RWA eligibility)
    submitListing: "/v1/broker/listing/submit", // POST {base_ccy, sources:[{source, weight}], market_session, ...}
    marketSessions: "/v1/public/rwa/market_sessions", // GET
    dailyFeeRevenue: "/v1/broker/daily_fee_revenue", // GET -> rows[{..., permissionless_listing_fee_share}] (VERIFY)
    symbolStatus: "/v1/builder/symbol/status", // VERIFY: no public API found; delisting via Orderly One admin
  },
} as const;

/** Builder Oracle push (docs: user-flows/builder-oracle): WebSocket, not REST. VERIFY host per env. */
export const ORDERLY_ORACLE_WS = {
  mainnet: "wss://ws-oracle.orderly.org",
  path: (accountId: string) => `/v1/ws/oracle/push/${accountId}`, // ?orderly_key&timestamp&sign (unpadded base64url of ed25519(timestamp))
  topic: "indexpricefeed", // {id, event:"publish", topic, ts, data:{base_ccy, price}}; >= 1/s while the session is open
} as const;

/** Documented REST rate limits (requests per window) — enforced client-side as minimum spacing. */
export const RATE_SPACING_MS: Record<string, number> = {
  [ORDERLY_PATHS.batchOrder]: 1000,
  [ORDERLY_PATHS.order]: 100,
  [ORDERLY_PATHS.cancelAll]: 100,
  [ORDERLY_PATHS.positions]: 334, // 30 / 10 s
};

/** Live base URLs (VERIFY). */
export const ORDERLY_BASE_URLS = {
  mainnet: "https://api.orderly.org",
  testnet: "https://testnet-api.orderly.org",
} as const;
