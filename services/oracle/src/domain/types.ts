import type { Hex } from "viem";

/** One observation of a ticker by one source. `ts` = observation time, unix ms. */
export interface SourceQuote {
  name: string;
  price: number;
  ts: number;
}

/** One fetched observation: USD per SHARE of the equity (never per Stock Token), `ts` unix ms. */
export interface SourceObservation {
  price: number;
  ts: number;
  /** Per-observation freshness bound (e.g. a Chainlink feed's heartbeat); overrides the source's. */
  maxAgeMs?: number;
}

/**
 * synthetic = devnet / testnet GBM (impossible on mainnet); live = market data: chainlink (on-chain feeds),
 * pyth (Pyth Pro, sources/pyth.ts), http (generic / Finnhub, sources/http.ts), dex (Uniswap v3 TWAP of the Stock
 * Token, sources/dex-twap.ts: a confirm source only, never a signing one).
 */
export type SourceKind = "synthetic" | "chainlink" | "pyth" | "http" | "dex";

/**
 * Aggregation policy (domain/confirm.ts): median = the median of >= ORACLE_MIN_SOURCES agreeing sources (devnet,
 * testnet, tests); primary-confirm = the primary source (Chainlink) alone sets and signs the price (sourceCount 1),
 * every other live source only confirms it (divergence -> warning + alert, never a different price). Mainnet:
 * primary-confirm.
 */
export type OraclePolicy = "median" | "primary-confirm";
export const ORACLE_POLICIES = ["median", "primary-confirm"] as const;
/** The signing source of the primary-confirm policy. */
export const PRIMARY_SOURCE = "chainlink";
/** Role of a source in /health: primary (signs), confirm (compared only), median (one vote). */
export type SourceRole = "primary" | "confirm" | "median";

export function sourceRole(policy: OraclePolicy, s: Pick<PriceSource, "name">): SourceRole {
  if (policy === "median") return "median";
  return s.name === PRIMARY_SOURCE ? "primary" : "confirm";
}

/** Pluggable price source. Returns null when the source has no (usable) observation. */
export interface PriceSource {
  readonly name: string;
  /** Unset = treated as "http" (a live, non-Chainlink source). */
  readonly kind?: SourceKind;
  /** Observations older than this are ignored by the aggregator (default ORACLE_MAX_SOURCE_AGE_MS). */
  readonly maxAgeMs?: number;
  fetch(ticker: string): Promise<SourceObservation | null>;
}

export const sourceKind = (s: Pick<PriceSource, "kind">): SourceKind => s.kind ?? "http";

export interface IndexComponent {
  priceId: string; // component price id label, e.g. "NVDA"
  weightBps: number; // sum over components == 1e4
}

/** One oracle key the service publishes. */
export interface UniverseEntry {
  /** Human label / Redis key suffix, e.g. "NVDA" or "RHX5". */
  priceId: string;
  /** AttestedOracle key (bytes32), e.g. bytes32("NVDA"). */
  underlying: Hex;
  kind: "equity" | "index";
  components: IndexComponent[];
  /** Encoded charter sessions governing `held`; the feed is open only when every one is open. */
  sessions: Hex[];
  /** Orderly symbols (venue = Orderly books on this key) receiving builder prices. */
  venueSymbols: string[];
  /** Book ids quoting on this key (diagnostics). */
  bookIds: number[];
}
