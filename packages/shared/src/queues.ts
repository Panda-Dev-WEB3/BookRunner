// BullMQ queue names, Redis pub/sub channels and keys, and job payloads shared across services.

export const QUEUES = {
  jury: "bkrn-jury", // charter -> model jury
  venueOps: "bkrn-venue-ops", // symbol creation, IF funding, withdrawals, reports (ops-venue)
  marks: "bkrn-marks", // mark per book per period (mark)
  receipts: "bkrn-receipts", // hourly receipts root per book (receipts)
  settlements: "bkrn-settlements", // settlement sweep + distribute per book per period (waterfall)
  webhooks: "bkrn-webhooks", // webhook deliveries (api)
  events: "bkrn-events", // domain events fan-out (indexer/api)
} as const;

export const CHANNELS = {
  oraclePrice: (priceId: string) => `bkrn:oracle:price:${priceId}`,
  quotes: (bookId: number | bigint) => `bkrn:agent:quotes:${bookId}`,
  fills: (bookId: number | bigint) => `bkrn:agent:fills:${bookId}`,
  riskState: (bookId: number | bigint) => `bkrn:risk:state:${bookId}`,
  kill: (bookId: number | bigint) => `bkrn:risk:kill:${bookId}`,
  domainEvents: "bkrn:events",
} as const;

export const KEYS = {
  oracleLast: (priceId: string) => `bkrn:oracle:last:${priceId}`, // JSON OraclePriceMsg
  oracleBundle: "bkrn:oracle:bundle", // JSON OracleBundleMsg (pull oracle: latest signed priceData, every tick)
  venueReport: (bookId: number | bigint) => `bkrn:venue:report:${bookId}`, // JSON VenueReportMsg (ops-venue, signed)
  riskState: (bookId: number | bigint) => `bkrn:risk:state:${bookId}`, // JSON LimitsSnapshot + meta
  agentHeartbeat: (bookId: number | bigint) => `bkrn:agent:hb:${bookId}`, // unix ms
  agentQuote: (bookId: number | bigint) => `bkrn:agent:quote:${bookId}`, // JSON QuoteMsg (latest)
  liveNav: (bookId: number | bigint) => `bkrn:nav:live:${bookId}`, // JSON LiveNav (risk/mark estimate)
  venueSymbolIssues: "bkrn:ops-venue:symbol-issues", // JSON VenueSymbolIssuesMsg (ops-venue, every book poll, TTL)
  oracleVenueFeed: "bkrn:oracle:venue-feed", // JSON OracleVenueFeedMsg (oracle, every tick, TTL; also PUBLISHed on the same name)
  builderFeedStatus: "bkrn:ops-venue:builder-feed", // JSON BuilderFeedStatusMsg (ops-venue live builder price push, TTL)
} as const;

/** The oracle refreshes KEYS.oracleVenueFeed every tick; a stopped oracle lets it expire (ops-venue then stops pushing). */
export const ORACLE_VENUE_FEED_TTL_SEC = 30;
/**
 * ops-venue refreshes KEYS.builderFeedStatus every few seconds while it pushes live builder prices. The TTL is far
 * above the alert thresholds (services/alerts builder_price_push: 30 s failing, status older than 60 s) so a stalled
 * push loop leaves an old status behind that alerts, instead of a missing one.
 */
export const BUILDER_FEED_STATUS_TTL_SEC = 600;

/**
 * The oracle's signed prices keyed by Orderly venue symbol (the builder-price push targets of Orderly books), every
 * tick to KEYS.oracleVenueFeed and the channel of the same name. With ORDERLY_MODE=live ops-venue (the holder of the
 * Orderly key) pushes them to Orderly's Builder Oracle WebSocket; it never makes a price up, it only re-sends the
 * latest one between ticks, and it stops when `held` (session closed) or `stale` (the oracle has no publishable price).
 */
export interface OracleVenueFeedMsg {
  v: 1;
  ts: number; // unix ms (oracle tick)
  /** ORACLE_TICK_MS: ops-venue never treats a price as stale before 3 ticks, whatever its own max age */
  tickMs?: number;
  prices: OracleVenuePrice[];
}

export interface OracleVenuePrice {
  /** venue symbol (shared venueSymbol: PERP_<T>_USDC_<broker> with ORDERLY_MODE=live) */
  symbol: string;
  priceId: string;
  /** the per-share price of the latest signed OraclePriceMsg for priceId */
  price: number;
  /** session closed: the oracle holds the last open price (Orderly freezes the index OFF_MARKET; nothing is pushed) */
  held: boolean;
  /** in session but the oracle has no publishable price this tick (sources failing): nothing is pushed */
  stale: boolean;
  /** OraclePriceMsg.publishedAt (unix s, chain head time) */
  publishedAt: number;
  /** unix ms (oracle wall clock) when that price was signed: the age ops-venue checks */
  signedAt: number;
}

/** Per-symbol state of the live builder price push (ops-venue). Every state but pushing / held is a failure. */
export type BuilderPushState = "pushing" | "held" | "stale" | "no-price" | "invalid" | "disconnected" | "rejected" | "not-configured";

/** ops-venue's live builder price push, for services/alerts (builder_price_push). */
export interface BuilderFeedStatusMsg {
  v: 1;
  ts: number; // unix ms
  intervalMs: number;
  maxAgeMs: number;
  socket: { state: string; lastError: string | null; host: string | null };
  symbols: Array<{
    symbol: string;
    base: string;
    bookIds: number[];
    state: BuilderPushState;
    /** unix ms of the last publish sent */
    lastPushAt: number | null;
    /** last price sent */
    price: number | null;
    /** unix ms: start of the current failing run (null = pushing or held) */
    failingSince: number | null;
    error: string | null;
    /**
     * every book on this symbol is still in Subscription: the builder market / ORACLE_<broker> feed may not be listed
     * yet (manual Orderly One listing, VERIFY O20), so a failure is logged, not paged
     */
    preListing: boolean;
  }>;
}

/** ops-venue refreshes KEYS.venueSymbolIssues every book poll; a stopped ops-venue lets it expire. */
export const VENUE_SYMBOL_ISSUES_TTL_SEC = 600;

/**
 * Orderly books whose charter symbol has no Orderly market under the current config (ORDERLY_MODE=live: not listed,
 * not traded; every non-trading duty still runs). services/alerts raises one alert per book.
 */
export interface VenueSymbolIssuesMsg {
  v: 1;
  ts: number; // unix ms
  mode: "mock" | "live";
  books: Array<{ bookId: number; charterSymbol: string; error: string }>;
  /** live builder price push enabled (KEYS.builderFeedStatus expected; alerts raise a missing status) */
  builderPush?: boolean;
}

export interface OraclePriceMsg {
  priceId: string; // e.g. "NVDA" or index name
  underlying: `0x${string}`;
  priceWad: string;
  price: number;
  publishedAt: number; // unix seconds
  held: boolean;
  sourceCount: number;
  sources: Array<{ name: string; price: number; ts: number }>;
  sourcesHash: `0x${string}`;
  signature: `0x${string}`;
}

/**
 * Pull oracle bundle (docs/LOW_GAS.md §1): the latest signed update of every live price id, ready to be
 * carried as the `priceData` argument of a consumer transaction. Published every oracle tick to
 * KEYS.oracleBundle (expires when the oracle stops) and served by the oracle at GET /prices/signed.
 */
export interface OracleBundleMsg {
  /** abi.encode(PriceUpdate[], bytes[]) — see encodePriceData / decodePriceData */
  priceData: `0x${string}`;
  /** unix seconds: the newest publishedAt in the bundle (each update keeps its own publishedAt) */
  publishedAt: number;
  /** EIP-712 domain the signatures are bound to */
  chainId: number;
  oracle: `0x${string}`;
  /** price ids in priceData order */
  priceIds: string[];
}

/** Signed venue report (docs/LOW_GAS.md §2) as published by ops-venue under KEYS.venueReport(bookId). */
export interface VenueReportMsg {
  bookId: number;
  chainId: number;
  adapter: `0x${string}`;
  insuranceUsd: string; // decimal USD 6dp
  marginUsd: string; // decimal USD 6dp, signed
  netExposureUsd: string; // decimal USD 6dp, signed
  asOf: number; // unix seconds
  sig: `0x${string}`; // EIP-712 VenueReport signature by an OPS_VENUE holder
  /** abi.encode(insuranceUsd, marginUsd, netExposureUsd, asOf, sig) — the commitAndApply venueReport argument */
  venueReport: `0x${string}`;
}

export interface QuoteMsg {
  bookId: number;
  ts: number; // unix ms
  bid: number;
  ask: number;
  size: number; // units of underlying per side
  mid: number;
  oracle: number;
  inventoryUsd: number; // signed
  skewBps: number;
  widthBps: number;
  sides: { bid: boolean; ask: boolean };
}

export interface FillMsg {
  bookId: number;
  ts: number;
  side: "buy" | "sell"; // from the BOOK's perspective
  qty: number;
  px: number;
  feeUsd: number;
  venueTradeId: string;
  maker: boolean;
}

export interface KillMsg {
  bookId: number;
  ts: number;
  reason: string;
  breaches: string[];
}

// ---- job payloads ----
export interface JuryJob {
  charterId: number;
}
export interface VenueOpsJob {
  kind: "create_symbol" | "fund_if" | "deposit_mm" | "execute_withdraw" | "report" | "sweep_fees" | "revoke_key";
  bookId: number;
  amountUsd?: string;
  requestNonce?: string;
  period?: number;
}
export interface MarkJob {
  bookId: number;
  periodEnd: number;
}
export interface ReceiptsJob {
  bookId: number;
  hourStart: number;
}
export interface SettlementJob {
  bookId: number;
  period: number;
}
export interface WebhookJob {
  eventId: number;
  subscriptionId: number;
}
