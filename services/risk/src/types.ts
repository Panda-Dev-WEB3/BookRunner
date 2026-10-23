import type { QuoteHoldState } from "./domain/quote";
import type { BookComponents, BookState, KillMsg, LimitState, LimitsSnapshot, Mandate, MonitorStateSig, QuoteMsg, RiskStateSig, VenueId } from "@bookrunner/shared";
import type { QuoteAuth } from "./ports";
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
  /** signed: the oracle service's signed print (pull oracle), newer than the stored on-chain one */
  source: "chain" | "signed" | "redis" | "none";
}

/**
 * PoolEngine.lossBudget(marketId) (audit M-3 per-period pool loss budget; Task 7): the loss since the period's
 * anchor against its budget. `blocked`: the pool lost more than the budget, the engine refuses new risk until the
 * next period (it emits LossBudgetBreached once per period). Published for the alert, not a breach of its own: the
 * engine already enforces it and the mandate's drawdown kill stays the kill path.
 */
export interface EngineLossBudget {
  budgetBps: number;
  period: number;
  anchorEquityUsd: bigint;
  lossUsd: bigint;
  budgetUsd: bigint;
  blocked: boolean;
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
    /** Orderly: adapter.lastFlowAt() (last deposit/withdraw flow, unix s); 0 when unknown / engine. */
    lastFlowAt?: number;
    /**
     * Absent/"onchain": the adapter's stored figures. engine_signed_price: engine pool views re-read after
     * applying the signed print in an eth_call. signed_report: ops-venue's signed report (monitor overlay).
     */
    source?: "onchain" | "engine_signed_price" | "signed_report";
  };
  /**
   * Desk tokens valued through StockTokenRegistry.valueUsdAt at the newest price (signed print when newer
   * than the stored one). priceStale: some held token's newest price is older than maxPriceAge.
   * signedPrices: the desk used at least one signed print.
   */
  desk: { hedgeNotionalUsd: bigint; valueUsd: bigint; priceStale?: boolean; signedPrices?: boolean; splitWindow?: boolean; splitUntrusted?: boolean };
  vaultIdleUsd: bigint;
  unfundedClaimsUsd: bigint;
  seniorNavUsd: bigint;
  juniorNavUsd: bigint;
  perfIndexWad: bigint;
  highWaterWad: bigint;
  /** null when the oracle read failed; the monitor then falls back to KEYS.oracleLast. */
  oracle: OracleReading | null;
  maxPriceAgeSec: number;
  /** Engine books: PoolEngine.lossBudget (null when unreadable, e.g. a pre-M-3 engine); absent for Orderly books. */
  lossBudget?: EngineLossBudget | null;
  /** Book.capitalShort() (pool audit 2026-10-23 fix round 2 Info 4); absent / false when not short or unreadable. */
  capitalShort?: boolean;
}

/** signed_report: ops-venue's signed venue report (newer than the adapter's on-chain one, LOW_GAS §2). */
export type ExposureSource = "venue_api" | "adapter_report" | "signed_report" | "engine";

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
  /** audit M-2: a held token is in the split window (its price predates its multiplier change): the
   *  token is valued at the basis multiplier and the flatten skips it */
  deskSplitWindow?: boolean;
  /** some split-window token has no basis multiplier (valued at 0): the desk valuation is untrusted, the
   *  desk-dependent breaches (DRAWDOWN, HEDGE_BAND) do not run */
  deskSplitUntrusted?: boolean;
  nav: NavInputs;
  oracle: OracleReading;
  quote: QuoteObservation | null;
  /** engine books: ChainObservation.lossBudget */
  lossBudget?: EngineLossBudget | null;
  /** ChainObservation.capitalShort: the book is held reduce-only until its own capital is back above the pool's minimum */
  capitalShort?: boolean;
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

/** Subset of QuoteMsg (KEYS.agentQuote) the risk check needs, plus what its signature covers (busAuth.ts AgentQuote). */
export interface QuoteObservation {
  ts: number; // unix ms
  bid: number;
  ask: number;
  oracle: number;
  sides: { bid: boolean; ask: boolean };
  bookId?: number;
  size?: number;
  /** EIP-712 AgentQuote signature by the book's desk session key (absent: unsigned) */
  signature?: string;
  /** the oracle print the quote was priced on (QuoteMsg.ref) */
  ref?: QuoteMsg["ref"];
  /** set by risk once the quote is authenticated: the verified reference price the quote is judged against */
  refPx?: number;
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
  /** the RISK-signed KillOrder broadcast for this episode: corroborates the journal when it is restored (N-3) */
  killOrder?: KillMsg;
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
  /** Audit M-3 fail-safe hold (no fresh attested price): null freshTicks = not held. */
  quoteHold?: QuoteHoldState;
}

export const initialMonitorState = (): MonitorState => ({
  lastState: null,
  lastBreaches: [],
  band: { outOfBandSince: null, lastObservedAt: null },
  breachStreak: 0,
  episode: null,
  kill: null,
  handledKill: null,
  quoteHold: { freshTicks: null },
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
  /** verified signed oracle prints available this tick (LOW_GAS §1) */
  signedPrices?: number;
  /** asOf of the signed venue report the venue was valued with (null: none) */
  venueReportAsOf?: number | null;
  liveNavUsd: string;
  drawdownBps: number;
  oracle: { priceId: string; price: number | null; publishedAt: number; held: boolean; stale: boolean; source: OracleReading["source"] };
  quote: {
    ts: number;
    ageMs: number;
    used: boolean;
    reference: "attested" | "none";
    agentRefDevBps: number | null;
    widthBps: number;
    skewBps: number;
  } | null;
  /** Audit M-3: a live quote could not be checked against a fresh attested price (book held reduce-only). */
  quoteUnverified?: boolean;
  /** Pool audit 2026-10-23 fix round 2 (Info 4): a pool-funded book's own capital is below the pool's minimum (reduce-only). */
  capitalShort?: boolean;
  /** Task 7: the engine pool's per-period loss budget (USD strings); null for Orderly books or when unreadable. */
  lossBudget?: { budgetBps: number; period: number; anchorEquityUsd: string; lossUsd: string; budgetUsd: string; blocked: boolean } | null;
  /**
   * Who signed the agent's quote read from Redis (audit 2026-10 lead "Redis trust"): ok = an active desk key of the
   * mandate; anything else = the quote is ignored (no quote check, never a breach). null = no quote / no check.
   */
  quoteAuth?: QuoteAuth | null;
  hedgeBand: { inBand: boolean; outOfBandSince: number | null; outOfBandSec: number; graceSec: number };
  killed: boolean;
  killReason: string | null;
  killMode: "enforce" | "alert";
  monitor: MonitorState;
}

/** JSON at KEYS.riskState(bookId) and on CHANNELS.riskState(bookId): LimitsSnapshot + meta. */
export interface RiskStatePayload extends LimitsSnapshot {
  meta: RiskMeta;
  /** RISK-key signature over (book, state, tsMs) (shared busAuth.ts RiskState): the agent acts only on signed states */
  stateSig?: RiskStateSig;
  /** RISK-signed copy of the state machine (busAuth.ts RiskMonitorState): the only one risk restores at restart (N-3) */
  monitorSig?: MonitorStateSig<MonitorState>;
}
