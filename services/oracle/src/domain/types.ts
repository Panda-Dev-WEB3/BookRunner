import type { Hex } from "viem";

/** One observation of a ticker by one source. `ts` = observation time, unix ms. */
export interface SourceQuote {
  name: string;
  price: number;
  ts: number;
}

/** Pluggable price source. Returns null when the source has no (usable) observation. */
export interface PriceSource {
  readonly name: string;
  /** Observations older than this are ignored by the aggregator (default ORACLE_MAX_SOURCE_AGE_MS). */
  readonly maxAgeMs?: number;
  fetch(ticker: string): Promise<{ price: number; ts: number } | null>;
}

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
