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
  usdToNumber,
} from "@bookrunner/shared";
import type { AgentBus } from "../adapters/bus";
import type { AgentStore, FillRow } from "../adapters/store";
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
}

const LIMIT_STATES: readonly LimitState[] = ["ok", "warn", "reduce_only", "breach", "killed"];
const MAX_SEEN = 20_000;
const ACCOUNT_FAILURES_BEFORE_CANCEL = 3;

export class BookAgent {
  private mandate: Mandate;
  private mandateKilled = false;
  private chainOffHours = false;
  private bookState: BookState | null = null;
  private riskState: LimitState | null = null;
  private killMsg: KillMsg | null = null;

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

  onKill(raw: string): void {
    let msg: KillMsg | null = null;
    try {
      msg = JSON.parse(raw) as KillMsg;
    } catch {
      msg = { bookId: this.d.bookId, ts: this.now(), reason: "KILL", breaches: [] };
    }
    if (msg.bookId !== undefined && Number(msg.bookId) !== this.d.bookId) return;
    this.killMsg = msg;
    this.d.log.warn({ reason: msg.reason, breaches: msg.breaches }, "kill message received");
    void this.halt(`KILL_MSG:${msg.reason}`);
  }

  onRiskState(raw: string): void {
    let state: unknown;
    try {
      state = (JSON.parse(raw) as { state?: unknown }).state;
    } catch {
      return;
    }
    if (typeof state !== "string" || !LIMIT_STATES.includes(state as LimitState)) return;
    this.setRiskState(state as LimitState);
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

  /** Graceful shutdown (SIGINT/SIGTERM): stop loops; run() then cancels resting quotes. */
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
    return px.held || nowMs / 1000 - px.publishedAt > this.cfg.maxPriceAgeSec || !isOpen(this.d.sessions, new Date(nowMs)) || this.chainOffHours;
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
    const failed = [m, killed, off, st].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    if (failed.length > 0 && failed.length < 4) this.d.log.debug({ failed: failed.length, err: errMsg(failed[0]?.reason) }, "partial chain state refresh");

    const risk = await this.d.bus.getJson<{ state?: string }>(KEYS.riskState(this.d.bookId)).catch(() => null);
    if (risk && typeof risk.state === "string" && LIMIT_STATES.includes(risk.state as LimitState)) this.setRiskState(risk.state as LimitState);

    if (this.d.chain.oracleFallback && this.d.price.ageSec(this.now()) > this.cfg.chainPriceFallbackSec) {
      const p = await this.d.chain.oracleFallback().catch(() => null);
      if (this.d.price.ingest(p)) this.d.log.debug({ price: p?.price }, "price from AttestedOracle fallback");
    }
    if (failed.length === 4) throw new Error(`chain state unavailable: ${errMsg(failed[0]?.reason)}`);
  }

  // ---------------------------------------------------------------- quoting

  private quoteTickSafe(): Promise<void> {
    return this.tickLock.run(() => (this.stopped ? Promise.resolve() : this.quoteTick()));
  }

  async quoteTick(): Promise<void> {
    const now = this.now();
    void this.d.bus.heartbeat(this.d.bookId, this.cfg.heartbeatTtlMs).catch((err) => this.d.log.debug({ err: errMsg(err) }, "heartbeat failed"));

    const md = resolveMode({ killMessage: this.killMsg, mandateKilled: this.mandateKilled, riskState: this.riskState, bookState: this.bookState });
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
    const q = decision.quote;
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

  private needsRequote(q: AgentQuote, oraclePx: number, now: number): boolean {
    if (this.d.venue.kind === "engine") return true; // EngineVenue applies its own change thresholds
    if (!this.resting || this.cancelled) return true;
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
    return {
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
    void this.d.bus.publishQuote(msg, this.cfg.quoteTtlMs).catch((err) => this.d.log.debug({ err: errMsg(err) }, "quote publish failed"));
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
    const md = resolveMode({ killMessage: this.killMsg, mandateKilled: this.mandateKilled, riskState: this.riskState, bookState: this.bookState });
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
    });
  }
}

/** Engine fills carry the taker address; Orderly fills do not. */
function traderOf(f: VenueFill): string | null {
  const t = (f as VenueFill & { trader?: unknown }).trader;
  return typeof t === "string" ? t : null;
}
