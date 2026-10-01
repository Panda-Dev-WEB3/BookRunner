// OracleService: per tick collect -> aggregate -> session hold -> sign -> publish (Redis, venue),
// and on the push policy -> AttestedOracle.pushMany + oracle_prices rows. All I/O is injected so the
// whole pipeline runs against fakes in tests.
import type { Logger, OraclePriceMsg, PriceUpdate } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import type { OracleChain } from "./adapters/chain";
import type { PriceStore } from "./adapters/db";
import type { PricePublisher } from "./adapters/redis";
import { type BuilderPriceClient, NotConfiguredError } from "./adapters/venue";
import { type AggregateResult, type CollectedQuote, aggregate } from "./domain/aggregate";
import { type Decision, type LastOpen, decide, marketOpen } from "./domain/hold";
import { type ComponentPrice, indexAsAggregate, indexLevel } from "./domain/index-level";
import { roundPrice, toPriceWad } from "./domain/price";
import { type PushedState, pushReason, publishTimestamp } from "./domain/push-policy";
import { canonicalSources, sourcesHash } from "./domain/sources-hash";
import type { PriceSource, UniverseEntry } from "./domain/types";
import type { PriceSigner } from "./signing";

export interface OracleSettings {
  outlierBps: number;
  minSources: number;
  maxSourceAgeMs: number;
  sourceTimeoutMs: number;
  pushIntervalMs: number;
  pushDeviationBps: number;
  sessionsMode: string | undefined;
  venuePrices: boolean;
}

export interface OracleServiceDeps {
  log: Logger;
  sources: PriceSource[];
  signer: PriceSigner;
  publisher: PricePublisher | null;
  store: PriceStore | null;
  venue: BuilderPriceClient | null;
  settings: OracleSettings;
  now?: () => number;
}

export interface DeploymentContext {
  chainId: number;
  oracle: Address;
  /** null = on-chain pushes disabled (ORACLE_PUSH_ONCHAIN=0) */
  chain: OracleChain | null;
}

export interface TickSummary {
  published: string[];
  skipped: Array<{ priceId: string; reason: string }>;
  due: string[];
}

export type OracleStatus = "waiting-deployment" | "waiting-universe" | "running";

const CHAIN_BACKOFF_BASE_MS = 5_000;
const CHAIN_BACKOFF_MAX_MS = 60_000;
const SKIP_WARN_AFTER_MS = 30_000;

export function updateFromMsg(m: OraclePriceMsg): PriceUpdate {
  return {
    underlying: m.underlying,
    priceWad: BigInt(m.priceWad),
    publishedAt: BigInt(m.publishedAt),
    held: m.held,
    sourceCount: m.sourceCount,
    sourcesHash: m.sourcesHash,
  };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

export class OracleService {
  private readonly log: Logger;
  private readonly now: () => number;
  private ctx: DeploymentContext | null = null;
  private universe: UniverseEntry[] = [];
  private discoverySource = "none";
  private warnings: string[] = [];
  private waitingReason = "deployment not loaded";

  private readonly lastOpen = new Map<string, LastOpen>();
  private readonly latest = new Map<string, OraclePriceMsg>();
  private readonly pushed = new Map<string, PushedState>();
  private readonly onchainAt = new Map<string, number>();
  private readonly skipSince = new Map<string, number>();
  private readonly venueInFlight = new Set<string>();

  private signerActive: boolean | null = null;
  private chainReason = "deployment not loaded";
  private onchainMinSources: number | null = null;
  private chainFailures = 0;
  private chainBackoffUntil = 0;
  private venueDisabled: string | null = null;
  private venueBackoffUntil = 0;
  private venueFailures = 0;
  private lastRedisWarn = 0;
  private lastStoreWarn = 0;
  private pushInFlight: Promise<void> | null = null;

  lastTickAt: number | null = null;
  lastPush: { atMs: number; txHash: Hex | null; count: number; error?: string } | null = null;

  constructor(private readonly deps: OracleServiceDeps) {
    this.log = deps.log;
    this.now = deps.now ?? Date.now;
  }

  // ------------------------------------------------------------------ lifecycle

  setWaiting(reason: string): void {
    this.ctx = null;
    this.waitingReason = reason;
    this.chainReason = reason;
  }

  async setDeployment(ctx: DeploymentContext): Promise<void> {
    const changed = !this.ctx || this.ctx.oracle.toLowerCase() !== ctx.oracle.toLowerCase() || this.ctx.chainId !== ctx.chainId;
    this.ctx = ctx;
    if (changed) {
      // a different AttestedOracle: forget per-contract push state
      this.onchainAt.clear();
      this.pushed.clear();
      this.chainFailures = 0;
      this.chainBackoffUntil = 0;
    }
    await this.refreshChainState();
  }

  /** Re-reads signer registration + minSources; pushes pause while the signer is not registered. */
  async refreshChainState(): Promise<void> {
    const chain = this.ctx?.chain;
    if (!this.ctx) return;
    if (!chain) {
      this.signerActive = null;
      this.chainReason = "on-chain pushes disabled (ORACLE_PUSH_ONCHAIN=0)";
      return;
    }
    try {
      const [active, min] = await Promise.all([chain.isSigner(this.deps.signer.address), chain.minSources()]);
      if (active !== this.signerActive) {
        if (active) this.log.info({ signer: this.deps.signer.address, oracle: chain.oracle }, "oracle signer registered; on-chain pushes enabled");
        else this.log.warn({ signer: this.deps.signer.address, oracle: chain.oracle }, "oracle signer is not registered on AttestedOracle; on-chain pushes paused");
      }
      this.signerActive = active;
      this.onchainMinSources = min;
      this.chainReason = active ? "ok" : "signer not registered on AttestedOracle";
    } catch (e) {
      if (this.signerActive !== false || this.chainReason === "ok") this.log.warn({ err: errMsg(e) }, "AttestedOracle not readable; on-chain pushes paused");
      this.signerActive = false;
      this.chainReason = `AttestedOracle not readable: ${errMsg(e)}`;
    }
  }

  async setUniverse(entries: UniverseEntry[], source = "chain", warnings: string[] = []): Promise<void> {
    const before = new Set(this.universe.map((e) => e.priceId));
    this.universe = entries;
    this.discoverySource = source;
    this.warnings = warnings;
    const added = entries.filter((e) => !before.has(e.priceId));
    if (added.length === 0) return;
    this.log.info(
      { added: added.map((e) => ({ priceId: e.priceId, kind: e.kind, books: e.bookIds, venueSymbols: e.venueSymbols, sessions: e.sessions.length })), source },
      "universe updated",
    );
    await Promise.all(added.map((e) => this.restore(e)));
  }

  /** Restores the last held/open price (Redis) and the stored on-chain publishedAt for a new key. */
  private async restore(e: UniverseEntry): Promise<void> {
    if (!this.lastOpen.has(e.priceId) && this.deps.publisher) {
      try {
        const m = await this.deps.publisher.loadLast(e.priceId);
        if (m && m.underlying.toLowerCase() === e.underlying.toLowerCase()) {
          this.lastOpen.set(e.priceId, { price: m.price, sources: m.sources, sourceCount: m.sourceCount, ts: m.publishedAt * 1000 });
        }
      } catch (err) {
        this.log.debug({ priceId: e.priceId, err: errMsg(err) }, "no last price restored");
      }
    }
    const chain = this.ctx?.chain;
    if (chain && !this.onchainAt.has(e.priceId)) {
      try {
        this.onchainAt.set(e.priceId, await chain.latestPublishedAt(e.underlying));
      } catch {
        // contract unreachable; push filtering falls back to 0 and the chain rejects stale updates
      }
    }
  }

  /** Resolves when no push cycle is in flight. */
  async idle(): Promise<void> {
    while (this.pushInFlight) await this.pushInFlight;
  }

  // ------------------------------------------------------------------ tick

  async tick(nowMs = this.now()): Promise<TickSummary> {
    const summary: TickSummary = { published: [], skipped: [], due: [] };
    const ctx = this.ctx;
    if (!ctx || this.universe.length === 0) return summary;
    const s = this.deps.settings;
    const minSources = Math.max(s.minSources, this.onchainMinSources ?? 0);
    const at = new Date(nowMs);

    const quotes = new Map<string, CollectedQuote[]>();
    await Promise.all(
      this.universe.filter((e) => e.kind === "equity").map(async (e) => quotes.set(e.priceId, await this.collect(e.priceId))),
    );

    let head: number | null = null;
    if (ctx.chain) {
      try {
        head = await ctx.chain.headTimestamp();
      } catch {
        head = null; // wall clock fallback
      }
    }
    const publishedAt = publishTimestamp(nowMs / 1000, head);

    const componentPrices = new Map<string, ComponentPrice>();
    const msgs: OraclePriceMsg[] = [];
    for (const e of this.universe) {
      const agg: AggregateResult =
        e.kind === "equity"
          ? aggregate(quotes.get(e.priceId) ?? [], { nowMs, outlierBps: s.outlierBps, minSources, maxAgeMs: s.maxSourceAgeMs })
          : indexAsAggregate(indexLevel(e.components, componentPrices), minSources);
      const open = marketOpen(e.sessions, at, s.sessionsMode);
      const d = decide({ open, agg, lastOpen: this.lastOpen.get(e.priceId) ?? null, nowMs });
      if (d.kind === "skip") {
        summary.skipped.push({ priceId: e.priceId, reason: d.reason });
        this.noteSkip(e.priceId, d.reason, nowMs, agg);
        // an index may still use this component's recent publication
        const last = this.latest.get(e.priceId);
        if (last && nowMs - last.publishedAt * 1000 <= s.maxSourceAgeMs) {
          componentPrices.set(e.priceId, { price: last.price, sourceCount: last.sourceCount, ts: last.publishedAt * 1000 });
        }
        continue;
      }
      this.skipSince.delete(e.priceId);
      if (d.seeded) this.log.warn({ priceId: e.priceId, price: d.price }, "off-hours start without history: holding at the currently observed price");
      this.lastOpen.set(e.priceId, d.lastOpen);
      const msg = await this.buildMsg(ctx, e, d, publishedAt);
      msgs.push(msg);
      this.latest.set(e.priceId, msg);
      summary.published.push(e.priceId);
      componentPrices.set(e.priceId, { price: msg.price, sourceCount: msg.sourceCount, ts: msg.publishedAt * 1000 });
    }

    await this.publishRedis(msgs);
    this.pushVenue(msgs);

    const due = msgs.filter((m) => pushReason(this.pushed.get(m.priceId), m, nowMs, { intervalMs: s.pushIntervalMs, deviationBps: s.pushDeviationBps }) !== null);
    summary.due = due.map((m) => m.priceId);
    if (due.length > 0 && !this.pushInFlight) {
      this.pushInFlight = this.pushCycle(ctx, due, nowMs).finally(() => {
        this.pushInFlight = null;
      });
    }
    this.lastTickAt = nowMs;
    return summary;
  }

  private async collect(ticker: string): Promise<CollectedQuote[]> {
    const timeout = this.deps.settings.sourceTimeoutMs;
    const results = await Promise.all(
      this.deps.sources.map(async (src): Promise<CollectedQuote | null> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const r = await Promise.race([
            src.fetch(ticker),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`timeout after ${timeout}ms`)), timeout);
            }),
          ]);
          if (!r) return null;
          const q: CollectedQuote = { name: src.name, price: Number.isFinite(r.price) && r.price > 0 ? roundPrice(r.price) : r.price, ts: r.ts };
          if (src.maxAgeMs !== undefined) q.maxAgeMs = src.maxAgeMs;
          return q;
        } catch (e) {
          this.log.debug({ source: src.name, ticker, err: errMsg(e) }, "source fetch failed");
          return null;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
    return results.filter((q): q is CollectedQuote => q !== null);
  }

  private async buildMsg(ctx: DeploymentContext, e: UniverseEntry, d: Extract<Decision, { kind: "publish" }>, publishedAt: number): Promise<OraclePriceMsg> {
    const price = roundPrice(d.price);
    const sources = canonicalSources(d.sources);
    const update: PriceUpdate = {
      underlying: e.underlying,
      priceWad: toPriceWad(price),
      publishedAt: BigInt(publishedAt),
      held: d.held,
      sourceCount: d.sourceCount,
      sourcesHash: sourcesHash(sources),
    };
    const signature = await this.deps.signer.sign(ctx.chainId, ctx.oracle, update);
    return {
      priceId: e.priceId,
      underlying: e.underlying,
      priceWad: update.priceWad.toString(),
      price,
      publishedAt,
      held: d.held,
      sourceCount: d.sourceCount,
      sources,
      sourcesHash: update.sourcesHash,
      signature,
    };
  }

  private noteSkip(priceId: string, reason: string, nowMs: number, agg: AggregateResult): void {
    const since = this.skipSince.get(priceId);
    if (since === undefined) {
      this.skipSince.set(priceId, nowMs);
      this.log.debug({ priceId, reason, rejected: agg.rejected.map((r) => `${r.name}:${r.reason}`) }, "price not published this tick");
    } else if (nowMs - since >= SKIP_WARN_AFTER_MS) {
      this.skipSince.set(priceId, nowMs);
      this.log.warn({ priceId, reason, forMs: nowMs - since }, "no publishable price");
    }
  }

  private async publishRedis(msgs: OraclePriceMsg[]): Promise<void> {
    if (!this.deps.publisher || msgs.length === 0) return;
    try {
      await this.deps.publisher.publish(msgs);
    } catch (e) {
      if (this.now() - this.lastRedisWarn > 30_000) {
        this.lastRedisWarn = this.now();
        this.log.warn({ err: errMsg(e) }, "redis publish failed");
      }
    }
  }

  private pushVenue(msgs: OraclePriceMsg[]): void {
    const venue = this.deps.venue;
    if (!venue || !this.deps.settings.venuePrices || this.venueDisabled || this.now() < this.venueBackoffUntil) return;
    const byId = new Map(this.universe.map((e) => [e.priceId, e]));
    for (const m of msgs) {
      for (const symbol of byId.get(m.priceId)?.venueSymbols ?? []) {
        if (this.venueInFlight.has(symbol)) continue;
        this.venueInFlight.add(symbol);
        venue
          .setBuilderPrice({ symbol, price: m.price, held: m.held, ts: m.publishedAt })
          .then(() => {
            if (this.venueFailures > 0) this.log.info({ symbol }, "venue builder price push recovered");
            this.venueFailures = 0;
          })
          .catch((e: unknown) => {
            if (e instanceof NotConfiguredError) {
              if (!this.venueDisabled) this.log.error({ err: e.message }, "venue builder prices disabled");
              this.venueDisabled = e.message;
              return;
            }
            this.venueFailures++;
            const wait = Math.min(1_000 * 2 ** Math.min(this.venueFailures, 5), 30_000);
            this.venueBackoffUntil = this.now() + wait;
            if (this.venueFailures === 1 || this.venueFailures % 10 === 0) this.log.warn({ symbol, err: errMsg(e), retryInMs: wait }, "venue builder price push failed");
          })
          .finally(() => this.venueInFlight.delete(symbol));
      }
    }
  }

  // ------------------------------------------------------------------ on-chain push

  private chainUsable(ctx: DeploymentContext, nowMs: number): ctx is DeploymentContext & { chain: OracleChain } {
    return !!ctx.chain && this.signerActive === true && nowMs >= this.chainBackoffUntil;
  }

  private async pushCycle(ctx: DeploymentContext, due: OraclePriceMsg[], nowMs: number): Promise<void> {
    const onchain = this.chainUsable(ctx, nowMs);
    const batch = onchain ? due.filter((m) => m.publishedAt > (this.onchainAt.get(m.priceId) ?? 0)) : due;
    if (batch.length === 0) return; // same-second re-publication; retried next tick
    for (const m of batch) this.pushed.set(m.priceId, { price: m.price, held: m.held, atMs: nowMs });

    let txHash: Hex | null = null;
    let error: string | undefined;
    if (onchain) {
      try {
        const r = await ctx.chain.pushMany(batch.map(updateFromMsg), batch.map((m) => m.signature));
        if (r.status === "success") {
          txHash = r.txHash;
          for (const m of batch) this.onchainAt.set(m.priceId, m.publishedAt);
          this.chainFailures = 0;
          this.chainBackoffUntil = 0;
        } else {
          error = `pushMany reverted in tx ${r.txHash}`;
        }
      } catch (e) {
        error = errMsg(e);
      }
      if (error) {
        this.chainFailures++;
        const wait = Math.min(CHAIN_BACKOFF_BASE_MS * 2 ** (this.chainFailures - 1), CHAIN_BACKOFF_MAX_MS);
        this.chainBackoffUntil = this.now() + wait;
        this.log.warn({ err: error, priceIds: batch.map((m) => m.priceId), retryInMs: wait }, "pushMany failed");
        await Promise.all(
          batch.map(async (m) => {
            try {
              this.onchainAt.set(m.priceId, await ctx.chain.latestPublishedAt(m.underlying));
            } catch {
              // keep the cached value
            }
          }),
        );
      } else {
        this.log.debug({ txHash, priceIds: batch.map((m) => m.priceId) }, "prices pushed");
      }
    }
    this.lastPush = error === undefined ? { atMs: nowMs, txHash, count: batch.length } : { atMs: nowMs, txHash, count: batch.length, error };

    if (this.deps.store) {
      try {
        await this.deps.store.insertPrices(batch.map((msg) => ({ msg, pushedTx: txHash })));
      } catch (e) {
        if (this.now() - this.lastStoreWarn > 30_000) {
          this.lastStoreWarn = this.now();
          this.log.warn({ err: errMsg(e) }, "oracle_prices insert failed");
        }
      }
    }
  }

  // ------------------------------------------------------------------ views

  status(): OracleStatus {
    if (!this.ctx) return "waiting-deployment";
    return this.universe.length === 0 ? "waiting-universe" : "running";
  }

  prices(): OraclePriceMsg[] {
    return this.universe.map((e) => this.latest.get(e.priceId)).filter((m): m is OraclePriceMsg => !!m);
  }

  price(priceId: string): OraclePriceMsg | null {
    return this.latest.get(priceId) ?? null;
  }

  health() {
    const ctx = this.ctx;
    return {
      status: this.status(),
      waitingReason: ctx ? null : this.waitingReason,
      chainId: ctx?.chainId ?? null,
      oracle: ctx?.oracle ?? null,
      signer: this.deps.signer.address,
      discovery: this.discoverySource,
      warnings: this.warnings,
      universe: this.universe.map((e) => ({ priceId: e.priceId, kind: e.kind, bookIds: e.bookIds, venueSymbols: e.venueSymbols, components: e.components })),
      lastTickAt: this.lastTickAt,
      lastPush: this.lastPush,
      onchain: {
        enabled: !!ctx?.chain,
        signerRegistered: this.signerActive,
        status: this.chainReason,
        minSources: Math.max(this.deps.settings.minSources, this.onchainMinSources ?? 0),
        backoffUntil: this.chainBackoffUntil > this.now() ? this.chainBackoffUntil : null,
      },
      venue: { mode: this.deps.venue?.mode ?? null, enabled: this.deps.settings.venuePrices && !this.venueDisabled, disabledReason: this.venueDisabled },
    };
  }

  signerInfo(): { address: Address; registered: boolean | null; chainId: number | null; oracle: Address | null } {
    return { address: this.deps.signer.address, registered: this.signerActive, chainId: this.ctx?.chainId ?? null, oracle: this.ctx?.oracle ?? null };
  }
}
