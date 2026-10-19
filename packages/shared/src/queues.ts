// BullMQ queue names, Redis pub/sub channels and keys, and job payloads shared across services.
//
// Bus namespace (one per STACK, mandatory): every channel, key and BullMQ queue name below carries the namespace of the
// stack the process belongs to, `bkrn:<ns>:…` (queues `bkrn-<ns>-…`). Redis pub/sub channels are global to a Redis
// server, whatever the db index, so two stacks on one Redis (or a mis-pointed REDIS_URL) would otherwise receive each
// other's kills, risk states, oracle prices and domain events. ns = BKRN_BUS_NS, else the network: NETWORK (devnet |
// testnet | testnet-live | mainnet), else from CHAIN_ID (31337 devnet, 46630 testnet, 4663 mainnet). The live-Orderly
// rehearsal stack pins BKRN_BUS_NS=testnet-live (scripts/network-profile.ts). Published messages also carry `ns`
// (busJson); subscribers drop a message whose `ns` differs from theirs (busForeign, logged once per channel and ns).
import type { VenueMarketMsg } from "./venueMarket";

const NS_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The stack's bus namespace from an environment (pure). */
export function busNamespace(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.BKRN_BUS_NS?.trim();
  if (explicit) {
    if (!NS_RE.test(explicit)) throw new Error(`BKRN_BUS_NS must be lowercase letters, digits and '-' (got "${explicit}")`);
    return explicit;
  }
  const net = env.NETWORK?.trim().toLowerCase();
  if (net && NS_RE.test(net)) return net;
  const chainId = Number(env.CHAIN_ID ?? 31337);
  return chainId === 31337 ? "devnet" : chainId === 46630 ? "testnet" : chainId === 4663 ? "mainnet" : `chain${chainId}`;
}

/** This process's bus namespace (fixed at start: dev.ts / systemd set the env before a service starts). */
export const BUS_NS = busNamespace();

/** JSON of a bus message stamped with this stack's namespace (`ns`). */
export function busJson(msg: object, ns: string = BUS_NS): string {
  return JSON.stringify({ ...msg, ns });
}

/**
 * The foreign namespace of a received bus message, or null when it is this stack's (or carries none: only this
 * stack's publishers write its namespaced channels). A foreign message must be dropped.
 */
export function busForeign(raw: string | object | null | undefined, ns: string = BUS_NS): string | null {
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const got = o && typeof o === "object" ? (o as { ns?: unknown }).ns : undefined;
  return typeof got === "string" && got !== ns ? got : null;
}

/** Drops foreign messages, logging once per (channel, foreign ns). Returns true when the message must be ignored. */
export function busDropper(warn: (msg: string, meta: Record<string, unknown>) => void, ns: string = BUS_NS): (channel: string, raw: string | object) => boolean {
  const seen = new Set<string>();
  return (channel, raw) => {
    const foreign = busForeign(raw, ns);
    if (foreign === null) return false;
    const k = `${channel}|${foreign}`;
    if (!seen.has(k)) {
      seen.add(k);
      warn("bus message from another stack dropped (namespace mismatch)", { channel, ns: foreign, mine: ns });
    }
    return true;
  };
}

/** Channel / key / queue names of a namespace (BUS_NS for this process; another stack's for tests and guards). */
export function busNames(ns: string = BUS_NS) {
  const p = `bkrn:${ns}`;
  return {
    QUEUES: {
      jury: `bkrn-${ns}-jury`, // charter -> model jury
      venueOps: `bkrn-${ns}-venue-ops`, // symbol creation, IF funding, withdrawals, reports (ops-venue)
      marks: `bkrn-${ns}-marks`, // mark per book per period (mark)
      receipts: `bkrn-${ns}-receipts`, // hourly receipts root per book (receipts)
      settlements: `bkrn-${ns}-settlements`, // settlement sweep + distribute per book per period (waterfall)
      webhooks: `bkrn-${ns}-webhooks`, // webhook deliveries (api)
      events: `bkrn-${ns}-events`, // domain events fan-out (indexer/api)
    },
    CHANNELS: {
      oraclePrice: (priceId: string) => `${p}:oracle:price:${priceId}`,
      quotes: (bookId: number | bigint) => `${p}:agent:quotes:${bookId}`,
      fills: (bookId: number | bigint) => `${p}:agent:fills:${bookId}`,
      riskState: (bookId: number | bigint) => `${p}:risk:state:${bookId}`,
      kill: (bookId: number | bigint) => `${p}:risk:kill:${bookId}`,
      /** psubscribe pattern over every book's kill channel */
      killPattern: `${p}:risk:kill:*`,
      domainEvents: `${p}:events`,
    },
    KEYS: {
      oracleLast: (priceId: string) => `${p}:oracle:last:${priceId}`, // JSON OraclePriceMsg
      oracleBundle: `${p}:oracle:bundle`, // JSON OracleBundleMsg (pull oracle: latest signed priceData, every tick)
      venueReport: (bookId: number | bigint) => `${p}:venue:report:${bookId}`, // JSON VenueReportMsg (ops-venue, signed; also PUBLISHed on the same name)
      venueReportRecent: (bookId: number | bigint) => `${p}:venue:report:${bookId}:recent`, // list, newest first
      riskState: (bookId: number | bigint) => `${p}:risk:state:${bookId}`, // JSON LimitsSnapshot + meta
      agentHeartbeat: (bookId: number | bigint) => `${p}:agent:hb:${bookId}`, // unix ms
      agentQuote: (bookId: number | bigint) => `${p}:agent:quote:${bookId}`, // JSON QuoteMsg (latest)
      agentDeskRejects: (bookId: number | bigint) => `${p}:agent:desk-rejects:${bookId}`, // JSON DeskRejectsMsg (agent, TTL; alerts desk_stale_trade_price)
      busForged: (source: string) => `${p}:bus:forged:${source}`, // JSON BusForgedMsg (agent-<id> / ops-venue / risk, TTL; alerts bus_forged_message)
      liveNav: (bookId: number | bigint) => `${p}:nav:live:${bookId}`, // JSON LiveNav (risk/mark estimate)
      venueSymbolIssues: `${p}:ops-venue:symbol-issues`, // JSON VenueSymbolIssuesMsg (ops-venue, every book poll, TTL)
      oracleVenueFeed: `${p}:oracle:venue-feed`, // JSON OracleVenueFeedMsg (oracle, every tick, TTL; also PUBLISHed on the same name)
      builderFeedStatus: `${p}:ops-venue:builder-feed`, // JSON BuilderFeedStatusMsg (ops-venue live builder price push, TTL)
      venueEverListed: `${p}:ops-venue:ever-listed`, // SET of venue symbols ever seen listed (survives restarts: listed -> missing, never awaiting)
      supervisorStatus: `${p}:supervisor:status`, // JSON SupervisorStatus (scripts/dev.ts)
    },
  };
}

const NAMES = busNames();
export const QUEUES = NAMES.QUEUES;
export const CHANNELS = NAMES.CHANNELS;
export const KEYS = NAMES.KEYS;
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
 * Every entry carries the oracle's EIP-712 SIGNED PriceUpdate (underlying, priceWad, publishedAt, held, sourceCount,
 * sourcesHash + signature, the same message AttestedOracle verifies): ops-venue pushes only a price whose signature
 * recovers to an oracle signer under this feed's domain (chainId + AttestedOracle), takes the price, the age and `held`
 * from the SIGNED fields, and caps the per-push deviation. The unsigned fields (price, stale, signedAt) are informative.
 */
export interface OracleVenueFeedMsg {
  v: 1;
  ts: number; // unix ms (oracle tick)
  /** ORACLE_TICK_MS: ops-venue never treats a price as stale before 3 ticks, whatever its own max age */
  tickMs?: number;
  /** EIP-712 domain of the signatures (AttestedOracle on this chain); absent = an older oracle: nothing is pushed */
  chainId?: number;
  oracle?: `0x${string}`;
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
  /** unix ms (oracle wall clock) when that price was signed (informative; ops-venue ages the SIGNED publishedAt) */
  signedAt: number;
  // ---- the signed PriceUpdate (IAttestedOracle.PriceUpdate) and its signature; required for a push
  underlying?: `0x${string}`;
  /** decimal string (WAD): the pushed price is priceWad / 1e18 */
  priceWad?: string;
  sourceCount?: number;
  sourcesHash?: `0x${string}`;
  signature?: `0x${string}`;
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
     * the builder market was never seen listed on Orderly (ops-venue's listing check: phase awaiting = absent from GET
     * /v1/public/info/{symbol} or NEW / PENDING; before a successful check: every book on it is in Subscription), so a
     * failure is logged, not paged. A market that was listed and is now missing is NOT preListing
     * (manual Orderly One listing, VERIFY O20)
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
  /** ORDERLY_LISTING_MODE (absent: an older ops-venue, api) */
  listingMode?: ListingMode;
  /**
   * Orderly market state per venue symbol of the tradable books in Subscription / Live / Retiring (ops-venue listing
   * check, GET /v1/public/info/{symbol}; VERIFY O20). Read by alerts (venue_listing_pending, venue_market_restricted,
   * venue_market_missing, venue_listing_check), the API's /health and the agent (venueMarketGate).
   */
  markets?: VenueMarketMsg[];
  /**
   * Manual listing mode: IF withdrawals of retiring books waiting for the admin to delist the market in Orderly One
   * (alerts venue_delist_pending).
   */
  delistWaits?: Array<{ bookId: number; symbol: string; since: number }>;
  /** ORDERLY_IF_MODE (absent: an older ops-venue, contract): the insurance-fund account model (docs/VERIFY.md O10) */
  ifMode?: "contract" | "builder";
  /**
   * Books whose IF account cannot be provisioned (alerts venue_if_account): mismatch = the adapter's on-chain IF binding
   * does not match ORDERLY_IF_MODE / ORDERLY_IF_BUILDER_ACCOUNTS; key_pending = builder mode, ops-venue's IF ops key is
   * not registered for the builder IF account yet (the operator's wallet must add it; `since` unix ms).
   */
  ifAccounts?: Array<{ bookId: number; accountId: string; binding: "devnet" | "contract" | "builder"; issue: "mismatch" | "key_pending" | "prior_equity" | "reassign"; detail: string; since?: number }>;
  /**
   * Builder IF mode: IF withdrawals waiting for the operator (alerts venue_if_operator_pending). step withdraw: withdraw
   * `amount` (USD 6dp) from the builder IF account on Orderly (paid to its EOA); return: transfer it from the EOA to the
   * book's adapter. `since` unix ms.
   */
  ifOperatorWaits?: Array<{ bookId: number; nonce: string; step: "withdraw" | "payout" | "return"; amount: string; owner: string; adapter: string; since: number; writtenOffAt?: number }>;
  /** Withdraw sagas that FAILED (terminal: manual action; alerts venue_withdraw_failed, critical for IF) */
  failedWithdrawals?: Array<{ bookId: number; nonce: string; account: number; amount: string; error: string; at: number }>;
  /** Builder IF mode: Orderly withdrawals from the builder IF account no on-chain request asked for (alerts venue_if_unadopted_withdrawal) */
  ifUnadopted?: Array<{ bookId: number; accountId: string; id: string; amount: string; status: string; createdAt: number | null }>;
  /** Builder IF mode: venue IF equity below the adapter's insurance with no on-chain flow (alerts venue_if_equity_drop) */
  ifEquityDrops?: Array<{ bookId: number; accountId: string; expectedUsd: string; venueUsd: string; at: number }>;
}

/**
 * ORDERLY_LISTING_MODE. api: ops-venue lists each book's market through the listing API (mock contract; live bodies
 * VERIFY O13). manual: the admin lists the market in Orderly One; ops-venue only checks /v1/public/info and never calls
 * a listing / status endpoint (VERIFY O20).
 */
export type ListingMode = "api" | "manual";

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

/**
 * Max age (ms) of the oracle price a quote may be made on (agent: AGENT_PRICE_STALE_SECONDS default) and checked
 * against (risk: RISK_QUOTE_PRICE_MAX_AGE_MS default). One constant, so the agent stops quoting on a price as old as
 * the one risk would hold the book reduce-only for (audit M-3 hold; Task 7b review minor).
 */
export const QUOTE_PRICE_MAX_AGE_MS = 15_000;

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
  /** EIP-712 AgentQuote signed by the book's desk session key (busAuth.ts); risk ignores an unsigned quote */
  signature?: `0x${string}`;
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

/** The agent keeps the desk's StaleTradePrice rejections of the last hour (KEYS.agentDeskRejects, refreshed on each one). */
export const DESK_REJECTS_WINDOW_SEC = 3_600;

/**
 * Desk key swaps (Hedge / Flatten) the desk refused with StaleTradePrice (audit 2026-10 "old prints": the traded token's
 * price older than min(maxPriceAge, maxTradePriceAge)), written by the book's agent; services/alerts raises
 * desk_stale_trade_price when too many land within its window.
 */
export interface DeskRejectsMsg {
  v: 1;
  bookId: number;
  ts: number; // unix ms of the write
  /** unix ms of each StaleTradePrice rejection within DESK_REJECTS_WINDOW_SEC, oldest first */
  staleTradePrice: number[];
}

export interface KillMsg {
  bookId: number;
  ts: number;
  reason: string;
  breaches: string[];
  /** EIP-712 KillOrder signed by the RISK key (busAuth.ts): unix s, episode nonce, signature. Unsigned = not acted on. */
  issuedAt?: number;
  nonce?: `0x${string}`;
  signature?: `0x${string}`;
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
  /** revoke_key: the RISK-signed kill order (busAuth.ts); without a valid one ops-venue waits for the on-chain kill */
  kill?: KillMsg;
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
