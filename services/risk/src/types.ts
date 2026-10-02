import type { BookComponents, BookState, LimitState, LimitsSnapshot, Mandate, VenueId } from "@bookrunner/shared";
import type { Hex } from "viem";

/** Static facts about a book, resolved once at discovery. */
export interface BookRef {
  bookId: number;
  venue: VenueId;
  components: BookComponents;
  underlying: Hex;
  /** Oracle key (bytes32) for the charter underlying, from StockTokenRegistry.priceIdOf. */
  priceId: Hex;
  /** Human oracle id used in Redis keys (e.g. "NVDA"), bytes32ToStr(priceId). */
  priceIdStr: string;
  /** Charter symbol, e.g. "PERP_NVDA_USDC". */
  symbol: string;
}

export interface OracleReading {
  priceWad: bigint;
  publishedAt: number; // unix seconds
  held: boolean;
  stale: boolean;
  source: "chain" | "redis" | "none";
}

/** Everything read from chain for one book in one tick. */
export interface ChainObservation {
  bookState: BookState;
  mandate: Mandate;
  killed: boolean;
  killReason: Hex;
  adapter: {
    netExposureUsd: bigint; // signed; Orderly = last report
    deployedValueUsd: bigint; // insurance + max(margin,0) + inTransit
    insuranceEquityUsd: bigint;
    inTransitUsd: bigint;
    valuationAt: number;
  };
  /** priceStale: the desk views reverted (StalePrice) and holdings were valued at the last attested price. */
  desk: { hedgeNotionalUsd: bigint; valueUsd: bigint; priceStale?: boolean };
  vaultIdleUsd: bigint;
  unfundedClaimsUsd: bigint;
  seniorNavUsd: bigint;
  juniorNavUsd: bigint;
  perfIndexWad: bigint;
  highWaterWad: bigint;
  /** null when the oracle read failed; the monitor then falls back to KEYS.oracleLast. */
  oracle: OracleReading | null;
  maxPriceAgeSec: number;
}

export type ExposureSource = "venue_api" | "adapter_report" | "engine";

/** Fully assembled per-tick input of the pure evaluation. */
export interface BookObservation {
  bookId: number;
  venue: VenueId;
  nowMs: number;
  bookState: BookState;
  mandate: Mandate;
  killed: boolean;
  killReason: Hex;
  netExposureUsd: bigint;
  exposureSource: ExposureSource;
  deskHedgeUsd: bigint;
  /** desk valued at the last attested price because the on-chain views reverted StalePrice */
  deskPriceStale?: boolean;
  nav: NavInputs;
  oracle: OracleReading;
  quote: QuoteObservation | null;
}

export interface NavInputs {
  vaultIdleUsd: bigint;
  unfundedClaimsUsd: bigint;
  venueDeployedUsd: bigint; // adapter deployedValueUsd (live-adjusted for Orderly when the venue API answers)
  deskValueUsd: bigint;
  seniorNavUsd: bigint;
  juniorNavUsd: bigint;
  perfIndexWad: bigint;
  highWaterWad: bigint;
}

/** Subset of QuoteMsg (KEYS.agentQuote) the risk check needs. */
export interface QuoteObservation {
  ts: number; // unix ms
  bid: number;
  ask: number;
  oracle: number;
  sides: { bid: boolean; ask: boolean };
}

export interface LiveNavResult {
  navUsd: bigint;
  accountedNavUsd: bigint;
  liveIndexWad: bigint;
  highWaterWad: bigint;
  drawdownBps: number;
}

/** Persisted JSON at KEYS.liveNav(bookId). [ext] shape — suggested for packages/shared. */
export interface LiveNav {
  bookId: number;
  ts: number; // unix ms
  source: "risk";
  navUsd: string;
  vaultIdleUsd: string;
  unfundedClaimsUsd: string;
  venueDeployedUsd: string;
  deskValueUsd: string;
  accountedNavUsd: string;
  seniorNavUsd: string;
  juniorNavUsd: string;
  perfIndexWad: string;
  liveIndexWad: string;
  highWaterWad: string;
  drawdownBps: number;
  venueSource: ExposureSource;
}

// ------------------------------------------------------------------ monitor state machine

export interface HedgeBandState {
  /** unix seconds when the ratio left the band; null while in band / below threshold. */
  outOfBandSince: number | null;
  /** unix seconds of the last observation (continuity check across gaps / restarts). */
  lastObservedAt: number | null;
}

export interface BreachEpisode {
  id: string; // `${bookId}-${sinceSec}`
  since: number; // unix seconds of the first breach observation
  breaches: string[];
  /** breach observed on RISK_BREACH_CONFIRM_TICKS consecutive ticks */
  confirmed: boolean;
  /** limit.breached + DECISION receipt written (retried every tick until true) */
  notified: boolean;
}

export type KillStep =
  | "broadcast"
  | "cancel_all"
  | "reduce_only"
  | "flatten"
  | "revoke_venue_key"
  | "mandate_kill"
  | "record_kill_event"
  | "record_receipt"
  | "record_event";

/** Durable journal of one kill episode; persisted with the risk state so restarts resume it. */
export interface KillJournal {
  episodeId: string;
  /** breach = risk-initiated; followup = the mandate was killed elsewhere (book at mark, prior run). */
  mode: "breach" | "followup";
  startedAt: number; // unix seconds
  reason: string;
  breaches: string[];
  snapshot: Record<string, unknown>;
  done: KillStep[];
  failed: Partial<Record<KillStep, number>>;
  actions: string[];
  txHashes: string[];
  /** Tx that set killed=true on-chain (ours or external). */
  killTx: string | null;
  runs: number;
}

export interface MonitorState {
  lastState: LimitState | null;
  lastBreaches: string[];
  band: HedgeBandState;
  breachStreak: number;
  episode: BreachEpisode | null;
  kill: KillJournal | null;
  /** Identifier (kill tx hash or reason marker) of the last on-chain kill whose follow-up is recorded. */
  handledKill: string | null;
}

export const initialMonitorState = (): MonitorState => ({
  lastState: null,
  lastBreaches: [],
  band: { outOfBandSince: null, lastObservedAt: null },
  breachStreak: 0,
  episode: null,
  kill: null,
  handledKill: null,
});

export interface RiskMeta {
  bookId: number;
  /** Book's MMMandate address: persisted state is only restored for the same deployment. */
  mandate: string;
  ts: number; // unix ms
  tick: number;
  venue: "orderly" | "engine";
  bookState: BookState;
  maxInventoryUsd: string;
  netExposureUsd: string;
  exposureSource: ExposureSource;
  deskHedgeUsd: string;
  /** true while the desk is valued at the last attested price (on-chain valuation reverted StalePrice) */
  deskPriceStale: boolean;
  liveNavUsd: string;
  drawdownBps: number;
  oracle: { priceId: string; price: number | null; publishedAt: number; held: boolean; stale: boolean; source: OracleReading["source"] };
  quote: { ts: number; ageMs: number; used: boolean; reference: "agent" | "oracle"; widthBps: number; skewBps: number } | null;
  hedgeBand: { inBand: boolean; outOfBandSince: number | null; outOfBandSec: number; graceSec: number };
  killed: boolean;
  killReason: string | null;
  killMode: "enforce" | "alert";
  monitor: MonitorState;
}

/** JSON at KEYS.riskState(bookId) and on CHANNELS.riskState(bookId): LimitsSnapshot + meta. */
export interface RiskStatePayload extends LimitsSnapshot {
  meta: RiskMeta;
}
