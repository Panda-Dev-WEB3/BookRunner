// BookAgent: the per-book quoting process. Loops (each robust: log + backoff, never crash):
//   quote  every AGENT_QUOTE_INTERVAL_MS: mode -> price freshness -> venue account -> buildQuote()
//          (A-S, clamped to the mandate, final checkQuote gate) -> replaceQuote / cancelAll ->
//          Redis agentQuote + quotes channel, sampled quotes rows + receipt leaves, heartbeat
//   state  mandate (remandates), mandate.killed(), mandate.offHours(), book state, risk state key,
//          on-chain oracle fallback
//   fills  venue.fillsSince() -> fills rows + receipts (deduped), fills channel
//   hedge  hedge planner cycle under the current hedge mode
// Kill (CHANNELS.kill message, mandate.killed(), risk "killed", book Retired) -> cancelAll, stop
// quoting, exit the loops. Risk "breach" -> reduce-only immediately (an extra quote tick runs on the
// state change). Venue calls are serialized so a cancel can never be overtaken by an in-flight replace.

import {
  AGENT_STATUS_TTL_SEC,
  type AgentStatusMsg,
  type BookState,
  type FillMsg,
  KEYS,
  type KillMsg,
  type LimitState,
  type Logger,
  type Mandate,
  type OraclePriceMsg,
  type QuoteMsg,
  type QuotingVenue,
  type Sessions,
  type VenueFill,
  isOpen,
  parseVenueMarkets,
  quoteRefOf,
  usdToNumber,
  venueMarketGate,
  venueMarketPostOnly,
} from "@bookrunner/shared";
import type { AgentBus } from "../adapters/bus";
import type { AgentStore, FillRow } from "../adapters/store";
import { isSignature } from "../chain/pull-prices";
import { resolveMode } from "../domain/mode";
import { type AgentQuote, type QuotingConfig, buildQuote, finalCheck, quoteChanged } from "../domain/quoting";
import { fillReceipt, quoteReceipt } from "../domain/receipts";
import type { SizingModel } from "../domain/sizing";
import type { EwmaVolatility } from "../domain/volatility";
import { SerialLock, backoffMs, errMsg, sleep } from "../util";
import type { HedgeCycleRunner } from "./hedger";
import type { PriceFeed } from "./price-feed";

export interface AgentChain {
  readMandate(): Promise<Mandate>;
  mandateKilled(): Promise<boolean>;
  mandateOffHours(): Promise<boolean>;
  bookState(): Promise<BookState>;
  /** AttestedOracle fallback when the Redis stream is quiet. */
  oracleFallback?(): Promise<OraclePriceMsg | null>;
  /** adapter.netExposureUsd(): the exposure MMMandate.checkHedge uses (last report on Orderly). */
  venueExposureUsd?(): Promise<bigint>;
  /** adapter.valuationAt() (unix seconds). */
  venueValuationAt?(): Promise<number>;
  /** MMMandate.isActiveKey(the agent's desk session key); absent = the agent has no desk key */
  deskKeyActive?(): Promise<boolean>;
  /** Book.capitalShort() (pool audit 2026-10-23 fix round 2 Info 4); absent = not read (treated as false) */
  capitalShort?(): Promise<boolean>;
}

export interface BookAgentConfig {
  quoting: QuotingConfig;
  quoteIntervalMs: number;
  stateRefreshMs: number;
  fillPollMs: number;
  hedgeIntervalMs: number;
  priceStaleSec: number;
  chainPriceFallbackSec: number;
  maxPriceAgeSec: number;
  requoteBps: number;
  requoteSizeFrac: number;
  requoteMaxMs: number;
  quoteSampleMs: number;
  quoteReceiptMs: number;
  receiptsIntervalSec: number;
  heartbeatTtlMs: number;
  quoteTtlMs: number;
  fillLookbackMs: number;
  /**
   * Orderly books: read ops-venue's market state (Redis KEYS.venueSymbolIssues, every state refresh) and stay
   * reduce-only while the market is not open for new risk (shared venueMarketGate). It can only restrict the agent;
   * an absent / unreadable key gates nothing. Default: on for the Orderly venue. allowPostOnly: in Orderly's POST_ONLY
   * launch phase quote both sides maker-only (POST_ONLY orders, within the mandate) instead of reduce-only — the book's
   * market maker provides the launch depth (AGENT_VENUE_POST_ONLY_QUOTE, default true with ORDERLY_MODE=live).
   * holdMs: when the book's market data disappears (key gone / TTL expired, read failed, malformed, no entry for the
   * book or phase unknown after an ops-venue restart) a restrictive state already in force (reduce-only or POST_ONLY
   * maker-only) is kept this long after the data was last seen, then lifted (AGENT_VENUE_GATE_HOLD_MS, default
   * 5 min); data that says the market is open lifts it at once. Like the risk key, missing data never widens the
   * agent before the hold expires.
   */
  venueGate?: { enabled: boolean; allowPostOnly: boolean; holdMs?: number };
  /**
   * Pull oracle: the desk carries signed prices in every price-checked tx, so the mandate evaluates
   * off-hours after the in-tx update. The on-chain `mandate.offHours()` view (stored price stale because
   * nothing landed recently) then says nothing about the next tx and is ignored while the feed price is
   * signed; held / stale / closed-session from the feed itself still apply.
   */
  pullPrices?: boolean;
  /**
   * The agent quotes new risk only with an active desk session key (Task 7b: every quote risk judges is signed by one);
   * without one it runs reduce-only and reports it (KEYS.agentStatus, alerts agent_no_desk_key). Default false
   * (tests); the service sets it.
   */
  requireDeskKey?: boolean;
  /** No verified (RISK-signed) risk state for this long: reduce-only (AGENT_RISK_STATE_TIMEOUT_MS, default 30 s). */
  riskStateTimeoutMs?: number;
}

export interface BookAgentDeps {
  bookId: number;
  venue: QuotingVenue;
  chain: AgentChain;
  price: PriceFeed;
  vol: EwmaVolatility;
  sizing: SizingModel;
  store: AgentStore;
  bus: AgentBus;
  hedger: HedgeCycleRunner | null;
  sessions: Sessions;
  initialMandate: Mandate;
  log: Logger;
  now?: () => number;
  /**
   * Signs each published quote with the desk session key (EIP-712 AgentQuote, busAuth.ts): risk checks only quotes
   * signed by an active desk key (audit 2026-10 lead "Redis trust"). Absent: published unsigned (no risk quote check).
   */
  signQuote?: (q: QuoteMsg) => Promise<`0x${string}`>;
  /**
   * Verifies a risk state read from Redis (RISK-signed, fresh, newer; AgentRiskStateGate): the state, or null when it
   * is not acted on. Absent (tests): the state is taken as read.
   */
  verifyRiskState?: (raw: unknown) => Promise<LimitState | null>;
}

/** AGENT_RISK_STATE_TIMEOUT_MS default: no verified risk state for this long = reduce-only. */
export const DEFAULT_RISK_STATE_TIMEOUT_MS = 30_000;

/** AGENT_VENUE_GATE_HOLD_MS default: how long a venue restriction outlives its market data (BookAgentConfig.venueGate). */
export const DEFAULT_VENUE_GATE_HOLD_MS = 5 * 60_000;

const LIMIT_STATES: readonly LimitState[] = ["ok", "warn", "reduce_only", "breach", "killed"];
const MAX_SEEN = 20_000;
const ACCOUNT_FAILURES_BEFORE_CANCEL = 3;

export class BookAgent {
  private mandate: Mandate;
  private mandateKilled = false;
  private chainOffHours = false;
  private bookState: BookState | null = null;
  /** Book.capitalShort() at the last refresh; a failed read keeps the previous value */
  private capitalShort = false;
  private riskState: LimitState | null = null;
  private killMsg: KillMsg | null = null;
  private venueGate: { reason: string; symbol: string } | null = null;
  /** the market is in Orderly's POST_ONLY launch phase and quoting through it is allowed: maker-only orders */
  private venuePostOnly = false;
  /** unix ms the book's market entry was last readable (a known phase); the gate hold counts from here */
  private venueDataAt = 0;
  /** the current hold (data gone while restricted) was logged */
  private venueHoldLogged = false;
  /** desk session key on the mandate (requireDeskKey) and since when it is not active */
  private deskKey: AgentStatusMsg["deskKey"] = "missing";
  private deskKeySince: number | null = null;
  private deskKeyKnown = false;
  /** agent clock of the last verified risk state (verifyRiskState) and of the start (the timeout's reference) */
  private lastVerifiedRiskAt: number | null = null;
  private readonly startedAt: number;

  private resting: AgentQuote | null = null;
  private restingSince = 0;
  private cancelled = false;
  private lastExposure = 0n;
  private accountFailures = 0;
  private lastModeReason = "";
  private lastNoQuoteReason = "";

  private sampleKey = "";
  private lastPersistMs = -Infinity;
  private lastReceiptMs = -Infinity;

  private lastFillTs: number | null = null;
  private readonly pendingFills = new Map<string, VenueFill>();
  private readonly published = new Set<string>();
  private readonly persisted = new Set<string>();

  private stopped = false;
  private haltReason: string | null = null;
  private haltDone: Promise<void> | null = null;
  private readonly stopCtl = new AbortController();
  private readonly venueLock = new SerialLock();
  private readonly tickLock = new SerialLock();
  private readonly now: () => number;

  constructor(
    private readonly d: BookAgentDeps,
    private readonly cfg: BookAgentConfig,
  ) {
    this.mandate = d.initialMandate;
    this.now = d.now ?? Date.now;
    this.startedAt = this.now();
  }

  // ---------------------------------------------------------------- external signals

  get halted(): string | null {
    return this.haltReason;
  }

  get currentMandate(): Mandate {
    return this.mandate;
  }

  get restingQuote(): AgentQuote | null {
    return this.resting;
  }

  /**
   * A VERIFIED kill order (RISK-signed, checked by AgentKillGate before it gets here): cancel-all and halt. Unsigned /
   * forged kill messages never reach this (Redis is not trusted).
   */
  onKill(msg: KillMsg): void {
    if (Number(msg.bookId) !== this.d.bookId) return;
    this.killMsg = msg;
    this.d.log.warn({ reason: msg.reason, breaches: msg.breaches }, "kill message received");
    void this.halt(`KILL_MSG:${msg.reason}`);
  }

  onRiskState(raw: string): void {
    const verify = this.d.verifyRiskState;
    if (verify) {
      // Redis is not trusted: only a RISK-signed, fresh, newer state is acted on (halting needs a signed "killed")
      void verify(raw)
        .then((s) => {
          if (s) this.acceptRiskState(s);
        })
        .catch((err) => this.d.log.debug({ err: errMsg(err) }, "risk state verification failed"));
      return;
    }
    let state: unknown;
    try {
      state = (JSON.parse(raw) as { state?: unknown }).state;
    } catch {
      return;
    }
    if (typeof state !== "string" || !LIMIT_STATES.includes(state as LimitState)) return;
    this.setRiskState(state as LimitState);
  }

  private acceptRiskState(s: LimitState): void {
    this.lastVerifiedRiskAt = this.now();
    this.setRiskState(s);
  }

  /** No verified risk state for the timeout (only with a verifier): reduce-only, never a halt. */
  private riskUnverified(now: number): boolean {
    if (!this.d.verifyRiskState) return false;
    return now - (this.lastVerifiedRiskAt ?? this.startedAt) > (this.cfg.riskStateTimeoutMs ?? DEFAULT_RISK_STATE_TIMEOUT_MS);
  }

  private deskKeyActiveForMode(): boolean | undefined {
    if (!this.cfg.requireDeskKey) return undefined;
    return this.deskKey === "active";
  }

  private setRiskState(s: LimitState): void {
    const prev = this.riskState;
    this.riskState = s;
    if (prev === s) return;
    this.d.log.info({ from: prev, to: s }, "risk state changed");
    if (s === "killed") void this.halt("RISK_KILLED");
    else if (s === "breach" || s === "reduce_only") void this.quoteTickSafe(); // stop new risk now
  }

  onPrice(msg: OraclePriceMsg | null): void {
    this.d.price.ingest(msg);
  }

  /**
   * Graceful shutdown (SIGINT/SIGTERM): stop loops; no new quote or hedge leg starts (a desk tx in
   * flight completes and is recorded); run() then cancels resting quotes.
   */
  stop(): void {
    this.stopped = true;
    this.stopCtl.abort();
  }

  // ---------------------------------------------------------------- run

  async run(): Promise<{ halted: boolean; reason: string }> {
    await this.refreshState().catch((err) => this.d.log.warn({ err: errMsg(err) }, "initial state refresh failed"));
    const loops = [
      this.loop("quote", this.cfg.quoteIntervalMs, () => this.quoteTickSafe()),
      this.loop("state", this.cfg.stateRefreshMs, () => this.refreshState()),
      this.loop("fills", this.cfg.fillPollMs, () => this.fillsTick()),
    ];
    if (this.d.hedger) loops.push(this.loop("hedge", this.cfg.hedgeIntervalMs, () => this.hedgeTick()));
    await Promise.all(loops);
    if (this.haltDone) await this.haltDone;
    else await this.cancelForShutdown();
    await this.fillsTick().catch(() => undefined); // flush what arrived meanwhile
    return { halted: this.haltReason !== null, reason: this.haltReason ?? "SHUTDOWN" };
  }

  private async loop(name: string, intervalMs: number, fn: () => Promise<unknown>): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      try {
        await fn();
        failures = 0;
      } catch (err) {
        failures++;
        this.d.log.warn({ loop: name, failures, err: errMsg(err) }, "loop iteration failed");
      }
      if (this.stopped) break;
      await sleep(Math.max(intervalMs, backoffMs(failures)), this.stopCtl.signal);
    }
  }

  private halt(reason: string): Promise<void> {
    if (this.haltDone) return this.haltDone;
    this.haltReason = reason;
    this.stopped = true;
    this.stopCtl.abort();
    this.d.log.warn({ reason }, "halting: cancel-all and stop quoting");
    this.haltDone = (async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.venueLock.run(() => this.d.venue.cancelAll());
          this.cancelled = true;
          this.resting = null;
          break;
        } catch (err) {
          this.d.log.warn({ attempt, err: errMsg(err) }, "cancel-all on halt failed");
          if (attempt < 3) await sleep(1_000);
        }
      }
      await this.d.bus.clearQuote(this.d.bookId).catch(() => undefined);
      await this.sampleNoQuote(this.now(), reason);
    })();
    return this.haltDone;
  }

  private async cancelForShutdown(): Promise<void> {
    if (this.cancelled && !this.resting) return;
    try {
      await this.venueLock.run(() => this.d.venue.cancelAll());
      this.cancelled = true;
      this.resting = null;
      this.d.log.info("shutdown: quotes cancelled");
    } catch (err) {
      this.d.log.warn({ err: errMsg(err) }, "shutdown: cancel-all failed");
    }
    await this.d.bus.clearQuote(this.d.bookId).catch(() => undefined);
  }

  // ---------------------------------------------------------------- state

  isOffHours(px: OraclePriceMsg | null, nowMs: number): boolean {
    if (!px) return true;
    const chainOff = this.chainOffHours && !(this.cfg.pullPrices && isSignature(px.signature));
    return px.held || nowMs / 1000 - px.publishedAt > this.cfg.maxPriceAgeSec || !isOpen(this.d.sessions, new Date(nowMs)) || chainOff;
  }

  async refreshState(): Promise<void> {
    const [m, killed, off, st] = await Promise.allSettled([
      this.d.chain.readMandate(),
      this.d.chain.mandateKilled(),
      this.d.chain.mandateOffHours(),
      this.d.chain.bookState(),
    ]);
    if (m.status === "fulfilled") this.mandate = m.value;
    if (off.status === "fulfilled") this.chainOffHours = off.value;
    if (st.status === "fulfilled") {
      if (st.value !== this.bookState) this.d.log.info({ from: this.bookState, to: st.value }, "book state");
      this.bookState = st.value;
    }
    if (killed.status === "fulfilled") {
      this.mandateKilled = killed.value;
      if (killed.value) void this.halt("MANDATE_KILLED");
    }
    if (this.d.chain.capitalShort) {
      const short = await this.d.chain.capitalShort().catch(() => this.capitalShort);
      if (short !== this.capitalShort) this.d.log.warn({ capitalShort: short }, short ? "pool-funded book's own capital below the pool's minimum: reduce-only" : "book capital back above the pool's minimum");
      this.capitalShort = short;
    }
    const failed = [m, killed, off, st].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    if (failed.length > 0 && failed.length < 4) this.d.log.debug({ failed: failed.length, err: errMsg(failed[0]?.reason) }, "partial chain state refresh");

    const risk = await this.d.bus.getJson<{ state?: string }>(KEYS.riskState(this.d.bookId)).catch(() => null);
    if (this.d.verifyRiskState) {
      const s = risk ? await this.d.verifyRiskState(risk).catch(() => null) : null;
      if (s) this.acceptRiskState(s);
    } else if (risk && typeof risk.state === "string" && LIMIT_STATES.includes(risk.state as LimitState)) this.setRiskState(risk.state as LimitState);
    await this.refreshDeskKey();
    await this.refreshVenueGate();
    await this.publishStatus();

    if (this.d.chain.oracleFallback && this.d.price.ageSec(this.now()) > this.cfg.chainPriceFallbackSec) {
      const p = await this.d.chain.oracleFallback().catch(() => null);
      if (this.d.price.ingest(p)) this.d.log.debug({ price: p?.price }, "price from AttestedOracle fallback");
    }
    if (failed.length === 4) throw new Error(`chain state unavailable: ${errMsg(failed[0]?.reason)}`);
  }

  /** MMMandate.isActiveKey of the agent's desk key (requireDeskKey): an inactive / missing key = reduce-only. */
  private async refreshDeskKey(): Promise<void> {
    if (!this.cfg.requireDeskKey) return;
    let next: AgentStatusMsg["deskKey"] = "missing";
    if (this.d.chain.deskKeyActive) {
      try {
        next = (await this.d.chain.deskKeyActive()) ? "active" : "inactive";
      } catch (err) {
        if (this.deskKeyKnown) return; // RPC blip: keep the last known status
        this.d.log.debug({ err: errMsg(err) }, "desk key status unreadable");
        next = "inactive";
      }
    }
    this.deskKeyKnown = true;
    if (next !== this.deskKey) {
      this.d.log[next === "active" ? "info" : "warn"]({ from: this.deskKey, to: next }, next === "active" ? "desk session key active: quoting allowed" : "no active desk session key on the mandate: reduce-only (register / re-register the key)");
      this.deskKeySince = next === "active" ? null : this.now();
      if (next !== "active") void this.quoteTickSafe(); // stop new risk now
    } else if (next !== "active" && this.deskKeySince === null) this.deskKeySince = this.now();
    this.deskKey = next;
  }

  /** The agent's status for services/alerts (agent_no_desk_key, risk_state_unverified): KEYS.agentStatus. */
  private async publishStatus(): Promise<void> {
    if (!this.cfg.requireDeskKey && !this.d.verifyRiskState) return;
    const now = this.now();
    const msg: AgentStatusMsg = {
      v: 1,
      bookId: this.d.bookId,
      ts: now,
      deskKey: this.cfg.requireDeskKey ? this.deskKey : "active",
      deskKeySince: this.cfg.requireDeskKey && this.deskKey !== "active" ? (this.deskKeySince ?? now) : null,
      riskStateUnverifiedSince: this.riskUnverified(now) ? (this.lastVerifiedRiskAt ?? this.startedAt) : null,
    };
    await this.d.bus.setJson(KEYS.agentStatus(this.d.bookId), msg, AGENT_STATUS_TTL_SEC * 1000).catch((err) => this.d.log.debug({ err: errMsg(err) }, "agent status publish failed"));
  }

  /** ops-venue's Orderly market state for this book (Redis, written by ops-venue): restricts only. */
  private async refreshVenueGate(): Promise<void> {
    const g = this.cfg.venueGate;
    if (this.d.venue.kind !== "orderly" || (g && !g.enabled)) return;
    const raw = await this.d.bus.getJson<unknown>(KEYS.venueSymbolIssues).catch(() => null);
    const markets = parseVenueMarkets(raw);
    const now = this.now();
    const entry = markets.find((m) => m.bookIds.includes(this.d.bookId) && m.phase !== "unknown");
    if (!entry && (this.venueGate || this.venuePostOnly)) {
      // no usable data for the book: keep the restriction in force until the hold expires (never widen on missing data)
      const holdMs = g?.holdMs ?? DEFAULT_VENUE_GATE_HOLD_MS;
      if (now - this.venueDataAt < holdMs) {
        if (!this.venueHoldLogged) {
          this.venueHoldLogged = true;
          this.d.log.warn({ reason: this.venueGate?.reason ?? "VENUE_POST_ONLY", holdMs }, "Orderly market state unavailable: keeping the venue restriction until the hold expires");
        }
        return;
      }
      this.d.log.warn({ reason: this.venueGate?.reason ?? "VENUE_POST_ONLY", heldMs: now - this.venueDataAt }, "Orderly market state unavailable past the hold: venue restriction lifted");
    }
    if (entry) this.venueDataAt = now;
    this.venueHoldLogged = false;
    const allowPostOnly = g?.allowPostOnly ?? false;
    const next = venueMarketGate(markets, this.d.bookId, { allowPostOnly });
    const postOnly = allowPostOnly && venueMarketPostOnly(markets, this.d.bookId);
    if (postOnly !== this.venuePostOnly) this.d.log.info({ postOnly }, postOnly ? "Orderly market in POST_ONLY: quoting maker-only (launch depth)" : "Orderly market left POST_ONLY");
    this.venuePostOnly = postOnly;
    const prev = this.venueGate;
    this.venueGate = next;
    if ((prev?.reason ?? null) === (next?.reason ?? null)) return;
    if (next) {
      this.d.log.warn({ reason: next.reason, symbol: next.symbol }, "Orderly market not open for new risk: reduce-only quoting and hedging");
      void this.quoteTickSafe(); // stop new risk now
    } else {
      this.d.log.info({ from: prev?.reason }, "Orderly market open again");
    }
  }

  // ---------------------------------------------------------------- quoting

  private quoteTickSafe(): Promise<void> {
    return this.tickLock.run(() => (this.stopped ? Promise.resolve() : this.quoteTick()));
  }

  async quoteTick(): Promise<void> {
    const now = this.now();
    void this.d.bus.heartbeat(this.d.bookId, this.cfg.heartbeatTtlMs).catch((err) => this.d.log.debug({ err: errMsg(err) }, "heartbeat failed"));

    const md = this.mode(now);
    if (md.reason !== this.lastModeReason) {
      this.d.log.info({ mode: md.mode, hedgeMode: md.hedgeMode, reason: md.reason }, "agent mode");
      this.lastModeReason = md.reason;
    }
    if (md.mode === "halt") return this.halt(md.reason);
    if (md.mode === "idle") return this.ensureCancelled(md.reason, true);

    const px = this.d.price.latest();
    if (!px || this.d.price.ageSec(now) > this.cfg.priceStaleSec) return this.ensureCancelled("STALE_PRICE", false);

    let account: Awaited<ReturnType<QuotingVenue["account"]>>;
    try {
      account = await this.d.venue.account();
      this.accountFailures = 0;
    } catch (err) {
      // without inventory the quote cannot be sized safely: pull it after a few failures
      if (++this.accountFailures >= ACCOUNT_FAILURES_BEFORE_CANCEL) await this.ensureCancelled("ACCOUNT_UNAVAILABLE", false).catch(() => undefined);
      throw err;
    }
    const exposure = account.position?.netExposureUsd ?? 0n;
    this.lastExposure = exposure;
    const offHours = this.isOffHours(px, now);

    const decision = buildQuote(
      { mandate: this.mandate, oraclePx: px.price, sigma: this.d.vol.sigmaPerSqrtSec(), netExposureUsd: exposure, offHours, reduceOnly: md.mode === "reduce_only" },
      this.cfg.quoting,
      this.d.sizing,
    );
    if (!decision.quote) {
      if (decision.reason !== this.lastNoQuoteReason) {
        this.d.log.info({ reason: decision.reason, sides: decision.sides, diag: decision.diagnostics, offHours }, "no quote");
        this.lastNoQuoteReason = decision.reason;
      }
      return this.ensureCancelled(decision.reason, false);
    }
    this.lastNoQuoteReason = "";
    const q = this.venuePostOnly ? { ...decision.quote, postOnly: true } : decision.quote;
    const fc = finalCheck(this.mandate, q);
    if (!fc.ok) {
      this.d.log.error({ violations: fc.violations, widthBps: fc.widthBps, skewBps: fc.skewBps }, "final mandate check failed: not quoting");
      return this.ensureCancelled("FINAL_CHECK", false);
    }

    let placed = false;
    await this.venueLock.run(async () => {
      if (this.stopped) return;
      if (!this.needsRequote(q, px.price, now)) return;
      await this.d.venue.replaceQuote(q);
      this.resting = q;
      this.restingSince = now;
      this.cancelled = false;
      placed = true;
    });
    if (this.stopped) return;
    if (placed || this.resting) await this.sample(this.resting ?? q, exposure, now);
  }

  private mode(now: number) {
    return resolveMode({
      killMessage: this.killMsg,
      mandateKilled: this.mandateKilled,
      riskState: this.riskState,
      bookState: this.bookState,
      venueGate: this.venueGate,
      riskUnverified: this.riskUnverified(now),
      capitalShort: this.capitalShort,
      ...(this.cfg.requireDeskKey ? { deskKeyActive: this.deskKeyActiveForMode() } : {}),
    });
  }

  private needsRequote(q: AgentQuote, oraclePx: number, now: number): boolean {
    if (this.d.venue.kind === "engine") return true; // EngineVenue applies its own change thresholds
    if (!this.resting || this.cancelled) return true;
    if (!!this.resting.postOnly !== !!q.postOnly) return true; // order type changed (POST_ONLY phase entered / left)
    if (!finalCheck(this.mandate, { ...this.resting, oraclePx }).ok) return true; // drifted vs oracle
    if (now - this.restingSince >= this.cfg.requoteMaxMs) return true;
    return quoteChanged(this.resting, q, this.cfg.requoteBps, this.cfg.requoteSizeFrac);
  }

  private async ensureCancelled(reason: string, onlyIfResting: boolean): Promise<void> {
    if (onlyIfResting && !this.resting) return;
    await this.venueLock.run(async () => {
      if (this.cancelled && !this.resting) return;
      await this.d.venue.cancelAll();
      this.cancelled = true;
      this.resting = null;
      this.d.log.info({ reason }, "quotes cancelled");
    });
    void this.d.bus.clearQuote(this.d.bookId).catch(() => undefined);
    await this.sampleNoQuote(this.now(), reason);
  }

  toQuoteMsg(q: AgentQuote, exposure: bigint, now: number): QuoteMsg {
    const px = this.d.price.latest();
    return {
      ...(px ? { ref: quoteRefOf(px) } : {}),
      bookId: this.d.bookId,
      ts: now,
      bid: q.theoretical.bidPx,
      ask: q.theoretical.askPx,
      size: Math.max(q.bid?.qty ?? 0, q.ask?.qty ?? 0),
      mid: (q.theoretical.bidPx + q.theoretical.askPx) / 2,
      oracle: q.oraclePx,
      inventoryUsd: usdToNumber(exposure),
      skewBps: q.skewBps,
      widthBps: q.widthBps,
      sides: { bid: !!q.bid, ask: !!q.ask },
    };
  }

  private async sample(q: AgentQuote, exposure: bigint, now: number): Promise<void> {
    const key = `${q.bid ? "B" : "-"}${q.ask ? "A" : "-"}${q.reduceOnly ? "R" : ""}`;
    const changed = key !== this.sampleKey;
    this.sampleKey = key;
    const msg = this.toQuoteMsg(q, exposure, now);
    // signed only with an active desk key (risk accepts only those); the signature covers the reference print
    const sign = this.deskKey === "active" || !this.cfg.requireDeskKey ? this.d.signQuote : undefined;
    void (async () => {
      const signature = sign ? await sign(msg).catch((err) => (this.d.log.debug({ err: errMsg(err) }, "quote signing failed"), undefined)) : undefined;
      await this.d.bus.publishQuote(signature ? { ...msg, signature } : msg, this.cfg.quoteTtlMs);
    })().catch((err) => this.d.log.debug({ err: errMsg(err) }, "quote publish failed"));
    if (!changed && now - this.lastPersistMs < this.cfg.quoteSampleMs) return;
    const withReceipt = changed || now - this.lastReceiptMs >= this.cfg.quoteReceiptMs;
    try {
      await this.d.store.insertQuote(
        {
          bookId: this.d.bookId,
          ts: new Date(now),
          bid: q.bid?.px ?? null,
          ask: q.ask?.px ?? null,
          size: msg.size,
          inventoryUsd: msg.inventoryUsd,
          skewBps: msg.skewBps,
          mid: msg.mid,
          oracle: msg.oracle,
          widthBps: msg.widthBps,
        },
        withReceipt ? quoteReceipt(msg, this.cfg.receiptsIntervalSec) : null,
      );
      this.lastPersistMs = now;
      if (withReceipt) this.lastReceiptMs = now;
    } catch (err) {
      this.d.log.warn({ err: errMsg(err) }, "persisting quote failed");
    }
  }

  private async sampleNoQuote(now: number, reason: string): Promise<void> {
    if (this.sampleKey === "none") return;
    this.sampleKey = "none";
    const px = this.d.price.latest();
    try {
      await this.d.store.insertQuote(
        { bookId: this.d.bookId, ts: new Date(now), bid: null, ask: null, size: 0, inventoryUsd: usdToNumber(this.lastExposure), skewBps: 0, mid: null, oracle: px?.price ?? null, widthBps: null },
        null,
      );
      this.lastPersistMs = now;
    } catch (err) {
      this.d.log.warn({ err: errMsg(err), reason }, "persisting no-quote sample failed");
    }
  }

  // ---------------------------------------------------------------- fills

  private remember(set: Set<string>, id: string): void {
    set.add(id);
    if (set.size > MAX_SEEN) {
      const first = set.values().next().value;
      if (first !== undefined) set.delete(first);
    }
  }

  toFillMsg(f: VenueFill): FillMsg {
    return { bookId: this.d.bookId, ts: f.ts, side: f.side, qty: f.qty, px: f.px, feeUsd: f.feeUsd, venueTradeId: f.tradeId, maker: f.maker };
  }

  async fillsTick(): Promise<void> {
    if (this.lastFillTs === null) {
      const fromDb = await this.d.store.lastFillTs(this.d.bookId).catch(() => null);
      this.lastFillTs = fromDb ?? this.now() - this.cfg.fillLookbackMs;
    }
    const fresh = await this.d.venue.fillsSince(this.lastFillTs);
    let maxTs = this.lastFillTs;
    for (const f of fresh) {
      if (!this.published.has(f.tradeId)) {
        this.remember(this.published, f.tradeId);
        void this.d.bus.publishFill(this.toFillMsg(f)).catch((err) => this.d.log.debug({ err: errMsg(err) }, "fill publish failed"));
      }
      if (!this.persisted.has(f.tradeId)) this.pendingFills.set(f.tradeId, f);
      if (f.ts > maxTs) maxTs = f.ts;
    }
    if (this.pendingFills.size === 0) {
      this.lastFillTs = maxTs;
      return;
    }
    const pending = [...this.pendingFills.values()];
    const msgs = new Map(pending.map((f) => [f.tradeId, this.toFillMsg(f)]));
    const rows: FillRow[] = pending.map((f) => ({
      bookId: this.d.bookId,
      ts: new Date(f.ts),
      side: f.side,
      qty: f.qty,
      px: f.px,
      feeUsd: f.feeUsd,
      venueTradeId: f.tradeId,
      maker: f.maker,
      trader: traderOf(f),
    }));
    try {
      const inserted = await this.d.store.insertFills(rows, (ins) =>
        ins.flatMap((r) => {
          const m = msgs.get(r.venueTradeId);
          return m ? [fillReceipt(m, this.cfg.receiptsIntervalSec)] : [];
        }),
      );
      for (const f of pending) this.remember(this.persisted, f.tradeId);
      this.pendingFills.clear();
      this.lastFillTs = maxTs;
      if (inserted.length) this.d.log.info({ count: inserted.length }, "fills recorded");
    } catch (err) {
      this.d.log.warn({ pending: pending.length, err: errMsg(err) }, "persisting fills failed; will retry");
      while (this.pendingFills.size > MAX_SEEN) {
        const first = this.pendingFills.keys().next().value;
        if (first === undefined) break;
        this.pendingFills.delete(first);
      }
    }
  }

  // ---------------------------------------------------------------- hedging

  async hedgeTick(): Promise<void> {
    if (!this.d.hedger) return;
    const md = this.mode(this.now());
    if (md.hedgeMode === "off" || this.stopped) return;
    // plan against the exposure the on-chain hedge check uses; the venue view is the fallback
    const exposure = this.d.chain.venueExposureUsd
      ? await this.d.chain.venueExposureUsd()
      : ((await this.d.venue.account()).position?.netExposureUsd ?? 0n);
    let allowAddHedge = true;
    if (this.d.chain.venueValuationAt) {
      const at = await this.d.chain.venueValuationAt().catch(() => 0);
      allowAddHedge = this.now() / 1000 - at <= this.cfg.maxPriceAgeSec * 4;
    }
    await this.d.hedger.cycle({
      mandate: this.mandate,
      mode: md.hedgeMode,
      offHours: this.isOffHours(this.d.price.latest(), this.now()),
      netExposureUsd: exposure,
      allowAddHedge,
      signal: this.stopCtl.signal,
    });
  }
}

/** Engine fills carry the taker address; Orderly fills do not. */
function traderOf(f: VenueFill): string | null {
  const t = (f as VenueFill & { trader?: unknown }).trader;
  return typeof t === "string" ? t : null;
}
