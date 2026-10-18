// OracleService: per tick collect -> aggregate (median, or primary-confirm: Chainlink signs, the DEX TWAP / Pyth confirm
// it, domain/confirm.ts) -> session hold -> sign -> publish (Redis per-price keys +
// the pull bundle, the venue feed per Orderly venue symbol; mock venue: POST to mock-orderly), and on the push policy -> oracle_prices rows (+ AttestedOracle.pushMany in
// heartbeat mode only; pull mode never pushes — consumers carry the signed bundle, docs/LOW_GAS.md §1).
// All I/O is injected so the whole pipeline runs against fakes in tests.
import { type Logger, type OracleBundleMsg, type OraclePriceMsg, type OracleVenueFeedMsg, type PriceUpdate, encodePriceData, priceUpdateFromMsg } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import type { OracleChain } from "./adapters/chain";
import type { PriceStore } from "./adapters/db";
import type { PricePublisher } from "./adapters/redis";
import type { BuilderPriceClient } from "./adapters/venue";
import { type AggregateResult, type CollectedQuote, type ConfirmResult, type ConfirmStatus, aggregate } from "./domain/aggregate";
import { type ConfirmRun, nextConfirmRun, primaryConfirm } from "./domain/confirm";
import { type Decision, type LastOpen, decide, marketOpen } from "./domain/hold";
import { type ComponentPrice, indexAsAggregate, indexLevel } from "./domain/index-level";
import { roundPrice, toPriceWad } from "./domain/price";
import { type PushedState, pushReason, publishTimestamp } from "./domain/push-policy";
import { canonicalSources, sourcesHash } from "./domain/sources-hash";
import { SourceHealth, type SourceOutcome, errorClass } from "./domain/source-health";
import { type OraclePolicy, PRIMARY_SOURCE, type PriceSource, type UniverseEntry, sourceKind, sourceRole } from "./domain/types";
import { onchainMinSourcesProblem } from "./production";
import type { PriceSigner } from "./signing";

export interface OracleSettings {
  outlierBps: number;
  minSources: number;
  maxSourceAgeMs: number;
  sourceTimeoutMs: number;
  pushIntervalMs: number;
  pushDeviationBps: number;
  sessionsMode: string | undefined;
  /** builder prices for Orderly books: the venue feed (Redis, pushed live by ops-venue) + the mock venue client */
  venuePrices: boolean;
  /** pull: never push on a timer (consumers carry the bundle); heartbeat: pushMany on the push policy */
  pushMode: PushMode;
  /** price ids whose latest signed update is older than this are left out of the bundle */
  bundleMaxAgeMs: number;
  /** per source name: oldest observation allowed to back a 2-source price (aggregate pairMaxAgeMs; median policy) */
  pairMaxAgeMs?: Readonly<Record<string, number>>;
  /** median (default) | primary-confirm (mainnet: Chainlink signs alone, every other live source only confirms) */
  policy?: OraclePolicy;
  /** primary-confirm: divergence threshold (bps of the Chainlink price), ORACLE_CONFIRM_BPS */
  confirmBps?: number;
  /** primary-confirm: an in-session ticker without any confirm source this long is logged (default 10 min) */
  confirmUnavailableWarnMs?: number;
  /** primary-confirm: per-ticker interval of the repeated divergence / unavailable warnings (default 60 s) */
  confirmWarnEveryMs?: number;
  /** primary-confirm: a confirm gap above this (bps) is tracked as a lag run (ORACLE_PRIMARY_LAG_BPS, default 100) */
  primaryLagBps?: number;
  /** a diverged / unavailable / lag run (and a source failure / unpublished run) ends only after this long (default 60 s) */
  hysteresisMs?: number;
  /**
   * Mainnet rules (production.ts): no synthetic source may be wired in (the constructor throws), and no
   * price — held or not, off-hours seeding included — is signed with fewer than the minimum sources.
   */
  production?: boolean;
}

export type PushMode = "pull" | "heartbeat";

export interface OracleServiceDeps {
  log: Logger;
  sources: PriceSource[];
  signer: PriceSigner;
  publisher: PricePublisher | null;
  store: PriceStore | null;
  /** mock venue only (POST to mock-orderly); live = null: ops-venue pushes the venue feed to Orderly */
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

/** A price as served publicly (HTTP): never carries the EIP-712 signature. */
export type PublicPriceMsg = Omit<OraclePriceMsg, "signature">;

export function publicView(m: OraclePriceMsg): PublicPriceMsg {
  const { signature: _signature, ...rest } = m;
  return rest;
}

const CHAIN_BACKOFF_BASE_MS = 5_000;
const CHAIN_BACKOFF_MAX_MS = 60_000;
const SKIP_WARN_AFTER_MS = 30_000;

export function updateFromMsg(m: OraclePriceMsg): PriceUpdate {
  return priceUpdateFromMsg(m);
}

/**
 * Pure: the pull bundle — the latest signed update of every live price id (universe order). A key whose
 * latest update is more than `maxAgeSec` older than `refSec` (its sources are failing) is left out; null
 * when nothing is live. publishedAt = the newest update in the bundle.
 */
export function buildBundle(
  latest: ReadonlyArray<OraclePriceMsg | undefined>,
  domain: { chainId: number; oracle: Address },
  refSec: number,
  maxAgeSec: number,
): OracleBundleMsg | null {
  const live = latest.filter((m): m is OraclePriceMsg => !!m && m.signature.length > 2 && refSec - m.publishedAt <= maxAgeSec);
  if (live.length === 0) return null;
  return {
    priceData: encodePriceData(live.map(priceUpdateFromMsg), live.map((m) => m.signature)),
    publishedAt: Math.max(...live.map((m) => m.publishedAt)),
    chainId: domain.chainId,
    oracle: domain.oracle,
    priceIds: live.map((m) => m.priceId),
  };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

export const DEFAULT_CONFIRM_BPS = 200;
export const DEFAULT_PRIMARY_LAG_BPS = 100;
export const DEFAULT_HYSTERESIS_MS = 60_000;

/** Per-ticker confirm state as served by /health (services/alerts oracle_confirm_*, oracle_primary_suspect_stale). */
export interface ConfirmView {
  priceId: string;
  /**
   * Run status (sticky: a diverged / unavailable run ends only after the other status held for the hysteresis).
   * closed = off-hours (not evaluated: Chainlink holds while the DEX may trade); no-primary = no fresh Chainlink.
   */
  status: ConfirmStatus | "closed";
  /** this tick's raw status */
  current: ConfirmStatus | "closed";
  diffBps: number | null;
  /** start (unix ms) of the current run of `status` */
  since: number;
  checkedAt: number;
  primaryPrice: number | null;
  /** Chainlink round updatedAt (unix ms) behind primaryPrice */
  primaryTs: number | null;
  /** start (unix ms) of the run with a confirm gap > primaryLagBps (null = none); see ConfirmRun */
  lagSince: number | null;
  confirmers: Array<{ name: string; price: number; diffBps: number }>;
}

export class OracleService {
  private readonly log: Logger;
  private readonly sourceHealth: SourceHealth;
  private readonly now: () => number;
  private ctx: DeploymentContext | null = null;
  private universe: UniverseEntry[] = [];
  private discoverySource = "none";
  private warnings: string[] = [];
  private waitingReason = "deployment not loaded";

  private readonly lastOpen = new Map<string, LastOpen>();
  private readonly latest = new Map<string, OraclePriceMsg>();
  /** wall clock (unix ms) at which `latest` was signed: the age ops-venue checks before re-sending a builder price */
  private readonly latestAt = new Map<string, number>();
  /** Last update per key confirmed on-chain (pushMany receipt success): what the public HTTP serves. */
  private readonly landed = new Map<string, OraclePriceMsg>();
  private readonly pushed = new Map<string, PushedState>();
  private readonly onchainAt = new Map<string, number>();
  private readonly skipSince = new Map<string, number>();
  /** in-session price ids without a publishable price: since (unix ms) + the latest reason */
  private readonly unpublished = new Map<string, { since: number; reason: string; lastSeenAt: number; publishedAt: number | null }>();
  /** primary-confirm: latest confirm evaluation per equity price id */
  private readonly confirmState = new Map<string, ConfirmView>();
  private readonly confirmRuns = new Map<string, ConfirmRun>();
  private readonly confirmWarnAt = new Map<string, number>();
  private readonly venueInFlight = new Set<string>();
  private bundle: OracleBundleMsg | null = null;
  /** the deployed AttestedOracle has update(bytes); false = pre-low-gas contract (pull falls back to pushes) */
  private pullSupported: boolean | null = null;

  private signerActive: boolean | null = null;
  private chainReason = "deployment not loaded";
  private onchainMinSources: number | null = null;
  private minSourcesProblem: string | null = null;
  private chainFailures = 0;
  private chainBackoffUntil = 0;
  private venueBackoffUntil = 0;
  private venueFailures = 0;
  /** latest venue feed publication (health): unix ms + symbols */
  private venueFeed: { ts: number; symbols: string[]; error: string | null } | null = null;
  private lastRedisWarn = 0;
  private lastVenueFeedWarn = 0;
  private lastStoreWarn = 0;
  private pushInFlight: Promise<void> | null = null;

  lastTickAt: number | null = null;
  lastPush: { atMs: number; txHash: Hex | null; count: number; error?: string } | null = null;

  constructor(private readonly deps: OracleServiceDeps) {
    this.log = deps.log;
    const policy = deps.settings.policy ?? "median";
    this.sourceHealth = new SourceHealth(
      deps.sources.map((src) => ({ name: src.name, kind: sourceKind(src), role: sourceRole(policy, src) })),
      (fields, msg) => this.log.warn(fields, msg),
      60_000,
      10_000,
      deps.settings.hysteresisMs ?? DEFAULT_HYSTERESIS_MS,
    );
    this.now = deps.now ?? Date.now;
    if (deps.settings.production) {
      const synthetic = deps.sources.filter((src) => sourceKind(src) === "synthetic").map((src) => src.name);
      if (synthetic.length > 0) throw new Error(`production oracle refuses synthetic sources: ${synthetic.join(", ")}`);
    }
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
      // a different AttestedOracle: forget per-contract push state and the signatures bound to the old
      // EIP-712 domain (they would never verify against the new contract)
      this.onchainAt.clear();
      this.pushed.clear();
      this.landed.clear();
      this.latest.clear();
      this.latestAt.clear();
      this.bundle = null;
      this.pullSupported = null;
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
      // startup refuses this (index.ts); a timelock change while running is logged on every change and stays
      // visible in /health (onchain.minSourcesProblem) for as long as it holds
      const problem = this.deps.settings.production ? onchainMinSourcesProblem(min, this.policy(), this.deps.sources) : null;
      if (problem && min !== this.onchainMinSources) this.log.error({ onchainMinSources: min, oracle: chain.oracle }, problem);
      this.minSourcesProblem = problem;
      this.onchainMinSources = min;
      this.chainReason = active ? "ok" : "signer not registered on AttestedOracle";
      if (this.pullSupported === null && this.deps.settings.pushMode === "pull" && chain.supportsUpdate) {
        this.pullSupported = await chain.supportsUpdate();
        if (!this.pullSupported) {
          this.log.warn(
            { oracle: chain.oracle },
            "ORACLE_PUSH_MODE=pull but the deployed AttestedOracle has no update(bytes) (pre-low-gas deployment): keeping heartbeat pushes",
          );
        }
      }
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
    const outcomes = new Map<string, Map<string, SourceOutcome>>();
    const equities = this.universe.filter((e) => e.kind === "equity");
    await Promise.all(
      equities.map(async (e) => {
        const c = await this.collect(e.priceId, nowMs);
        quotes.set(e.priceId, c.quotes);
        outcomes.set(e.priceId, c.outcomes);
      }),
    );
    // per-source health counts in-session tickers only (a closed market is no failure)
    this.sourceHealth.update(nowMs, outcomes, new Set(equities.filter((e) => marketOpen(e.sessions, at, s.sessionsMode)).map((e) => e.priceId)));

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
      const open = marketOpen(e.sessions, at, s.sessionsMode);
      const agg: AggregateResult =
        e.kind === "index"
          ? indexAsAggregate(indexLevel(e.components, componentPrices), minSources)
          : this.policy() === "primary-confirm"
            ? this.confirmed(e.priceId, quotes.get(e.priceId) ?? [], open, nowMs)
            : aggregate(quotes.get(e.priceId) ?? [], { nowMs, outlierBps: s.outlierBps, minSources, maxAgeMs: s.maxSourceAgeMs, ...(s.pairMaxAgeMs ? { pairMaxAgeMs: s.pairMaxAgeMs } : {}) });
      let d = decide({ open, agg, lastOpen: this.lastOpen.get(e.priceId) ?? null, nowMs, minSeedSources: s.production ? minSources : 1 });
      if (d.kind === "publish" && s.production && d.sourceCount < minSources) {
        // never sign below the minimum on mainnet (a held price restored from fewer sources included)
        d = { kind: "skip", reason: `refused: ${d.sourceCount} of ${minSources} required sources (production)`, lastOpen: this.lastOpen.get(e.priceId) ?? null };
      }
      if (d.kind === "skip") {
        summary.skipped.push({ priceId: e.priceId, reason: d.reason });
        // in session and nothing publishable: /health `unpublished` (services/alerts oracle_price_missing)
        if (open) {
          const u = this.unpublished.get(e.priceId);
          this.unpublished.set(e.priceId, { since: u?.since ?? nowMs, reason: d.reason, lastSeenAt: nowMs, publishedAt: null });
        } else this.unpublished.delete(e.priceId);
        this.noteSkip(e.priceId, d.reason, nowMs, agg);
        // an index may still use this component's recent publication
        const last = this.latest.get(e.priceId);
        if (last && nowMs - last.publishedAt * 1000 <= s.maxSourceAgeMs) {
          componentPrices.set(e.priceId, { price: last.price, sourceCount: last.sourceCount, ts: last.publishedAt * 1000 });
        }
        continue;
      }
      this.skipSince.delete(e.priceId);
      // the unpublished run ends only after publishing held for the hysteresis (a one-tick publish keeps its `since`)
      const u = this.unpublished.get(e.priceId);
      if (u) {
        u.publishedAt ??= nowMs;
        if (!open || nowMs - u.publishedAt >= (s.hysteresisMs ?? DEFAULT_HYSTERESIS_MS)) this.unpublished.delete(e.priceId);
      }
      if (d.seeded) this.log.warn({ priceId: e.priceId, price: d.price }, "off-hours start without history: holding at the currently observed price");
      this.lastOpen.set(e.priceId, d.lastOpen);
      const msg = await this.buildMsg(ctx, e, d, publishedAt);
      msgs.push(msg);
      this.latest.set(e.priceId, msg);
      this.latestAt.set(e.priceId, nowMs);
      summary.published.push(e.priceId);
      componentPrices.set(e.priceId, { price: msg.price, sourceCount: msg.sourceCount, ts: msg.publishedAt * 1000 });
    }

    this.bundle = buildBundle(
      this.universe.map((e) => this.latest.get(e.priceId)),
      { chainId: ctx.chainId, oracle: ctx.oracle },
      publishedAt,
      s.bundleMaxAgeMs / 1000,
    );
    await this.publishRedis(msgs, this.bundle);
    await this.publishVenueFeed(nowMs);
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

  private policy(): OraclePolicy {
    return this.deps.settings.policy ?? "median";
  }

  /**
   * primary-confirm for one equity: the Chainlink price (if fresh) is the price whatever the confirmers say; the
   * comparison is recorded for /health and logged (rate-limited) when it diverges or no confirmer is available in
   * session. Off-hours the comparison is not evaluated ("closed": Chainlink holds while the DEX may trade).
   */
  private confirmed(priceId: string, quotes: CollectedQuote[], open: boolean, nowMs: number): AggregateResult {
    const s = this.deps.settings;
    const confirmBps = s.confirmBps ?? DEFAULT_CONFIRM_BPS;
    const agg = primaryConfirm(quotes, { nowMs, primary: PRIMARY_SOURCE, confirmBps, maxAgeMs: s.maxSourceAgeMs });
    this.recordConfirm(priceId, agg.confirm, open, nowMs, confirmBps);
    return agg;
  }

  private recordConfirm(priceId: string, c: ConfirmResult, open: boolean, nowMs: number, confirmBps: number): void {
    const s = this.deps.settings;
    const prevRun = this.confirmRuns.get(priceId) ?? null;
    const run = nextConfirmRun(prevRun, c, open, nowMs, {
      hysteresisMs: s.hysteresisMs ?? DEFAULT_HYSTERESIS_MS,
      lagBps: s.primaryLagBps ?? DEFAULT_PRIMARY_LAG_BPS,
    });
    this.confirmRuns.set(priceId, run);
    const prev = this.confirmState.get(priceId);
    const { status, since } = run;
    const view: ConfirmView = {
      priceId,
      status,
      current: open ? c.status : "closed",
      diffBps: c.diffBps === null ? null : Math.round(c.diffBps * 10) / 10,
      since,
      checkedAt: nowMs,
      primaryPrice: c.primaryPrice,
      primaryTs: c.primaryTs,
      lagSince: run.lagSince,
      confirmers: c.confirmers.map((x) => ({ name: x.name, price: x.price, diffBps: Math.round(x.diffBps * 10) / 10 })),
    };
    this.confirmState.set(priceId, view);
    this.warnLag(view, nowMs);
    if (prev?.status === "diverged" && status === "ok") {
      this.log.info({ priceId, diffBps: view.diffBps, divergedForMs: nowMs - prev.since }, "confirm sources agree with Chainlink again");
    }
    if (status !== "diverged" && status !== "unavailable") {
      this.confirmWarnAt.delete(priceId);
      return;
    }
    // unavailable: only after confirmUnavailableWarnMs in session (a DEX / RPC blip stays quiet)
    if (status === "unavailable" && nowMs - since < (s.confirmUnavailableWarnMs ?? 600_000)) return;
    const last = this.confirmWarnAt.get(priceId);
    if (last !== undefined && nowMs - last < (s.confirmWarnEveryMs ?? 60_000)) return;
    this.confirmWarnAt.set(priceId, nowMs);
    if (status === "diverged") {
      this.log.warn(
        { priceId, chainlink: c.primaryPrice, confirmers: view.confirmers, confirmBps, divergedForMs: nowMs - since },
        "confirm divergence: a confirm source is further from Chainlink than ORACLE_CONFIRM_BPS; Chainlink is still published (the DEX never moves the price)",
      );
    } else {
      this.log.warn({ priceId, chainlink: c.primaryPrice, unavailableForMs: nowMs - since }, "no confirm source for an in-session ticker: Chainlink is published unconfirmed");
    }
  }

  /**
   * A confirm gap above primaryLagBps for confirmUnavailableWarnMs (10 min) with no new Chainlink round for as long:
   * the feed may have silently stopped updating (it still answers, so it stays "fresh" up to heartbeat + grace).
   * Logged (rate-limited); services/alerts raises oracle_primary_suspect_stale. The price is never changed.
   */
  private warnLag(v: ConfirmView, nowMs: number): void {
    const s = this.deps.settings;
    if (v.lagSince === null || v.primaryTs === null) return;
    // the stall clock restarts at every new round (services/alerts oracle_primary_suspect_stale does the same)
    if (nowMs - Math.max(v.lagSince, v.primaryTs) < (s.confirmUnavailableWarnMs ?? 600_000)) return;
    const key = `${v.priceId}:lag`;
    const last = this.confirmWarnAt.get(key);
    if (last !== undefined && nowMs - last < (s.confirmWarnEveryMs ?? 60_000)) return;
    this.confirmWarnAt.set(key, nowMs);
    this.log.warn(
      { priceId: v.priceId, chainlink: v.primaryPrice, chainlinkRoundAgeMs: nowMs - v.primaryTs, diffBps: v.diffBps, lagForMs: nowMs - v.lagSince },
      "Chainlink suspect stale: the confirm gap exceeds ORACLE_PRIMARY_LAG_BPS with no new round for 10 min (the price is still Chainlink)",
    );
  }

  private async collect(ticker: string, nowMs: number): Promise<{ quotes: CollectedQuote[]; outcomes: Map<string, SourceOutcome> }> {
    const timeout = this.deps.settings.sourceTimeoutMs;
    const outcomes = new Map<string, SourceOutcome>();
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
          if (!r) {
            outcomes.set(src.name, { ok: false, error: "no observation" });
            return null;
          }
          const q: CollectedQuote = { name: src.name, price: Number.isFinite(r.price) && r.price > 0 ? roundPrice(r.price) : r.price, ts: r.ts };
          const maxAge = r.maxAgeMs ?? src.maxAgeMs;
          if (maxAge !== undefined) q.maxAgeMs = maxAge;
          const usable = Number.isFinite(r.price) && r.price > 0 && Number.isFinite(r.ts);
          const fresh = nowMs - r.ts <= (maxAge ?? this.deps.settings.maxSourceAgeMs);
          outcomes.set(src.name, usable && fresh ? { ok: true } : { ok: false, error: usable ? "stale observation" : "invalid observation" });
          return q;
        } catch (e) {
          // every failure is counted per source (SourceHealth: rate-limited warn + /health); the message never
          // carries an access token (sources redact it)
          outcomes.set(src.name, { ok: false, error: errorClass(errMsg(e) ?? "") });
          this.log.debug({ source: src.name, ticker, err: errMsg(e) }, "source fetch failed");
          return null;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
    return { quotes: results.filter((q): q is CollectedQuote => q !== null), outcomes };
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

  private async publishRedis(msgs: OraclePriceMsg[], bundle: OracleBundleMsg | null): Promise<void> {
    if (!this.deps.publisher || (msgs.length === 0 && !bundle)) return;
    try {
      await this.deps.publisher.publish(msgs, bundle ? { msg: bundle, ttlMs: this.deps.settings.bundleMaxAgeMs } : null);
    } catch (e) {
      if (this.now() - this.lastRedisWarn > 30_000) {
        this.lastRedisWarn = this.now();
        this.log.warn({ err: errMsg(e) }, "redis publish failed");
      }
    }
  }

  /**
   * Pure view: the latest signed price of every Orderly venue symbol (builder-price push targets). `stale` = in session
   * and nothing publishable THIS tick (the unpublished run's hysteresis after recovery does not count); `held` comes
   * from the signed message itself. Symbols without any signed price yet are left out.
   */
  venueFeedMsg(nowMs = this.now()): OracleVenueFeedMsg {
    const prices: OracleVenueFeedMsg["prices"] = [];
    for (const e of this.universe) {
      const m = this.latest.get(e.priceId);
      if (!m) continue;
      const u = this.unpublished.get(e.priceId);
      const stale = u !== undefined && u.publishedAt === null;
      for (const symbol of e.venueSymbols) {
        prices.push({ symbol, priceId: e.priceId, price: m.price, held: m.held, stale, publishedAt: m.publishedAt, signedAt: this.latestAt.get(e.priceId) ?? m.publishedAt * 1000 });
      }
    }
    return { v: 1, ts: nowMs, prices };
  }

  private async publishVenueFeed(nowMs: number): Promise<void> {
    if (!this.deps.publisher || !this.deps.settings.venuePrices) return;
    if (!this.universe.some((e) => e.venueSymbols.length > 0)) return;
    const msg = this.venueFeedMsg(nowMs);
    try {
      await this.deps.publisher.publishVenueFeed(msg);
      this.venueFeed = { ts: nowMs, symbols: msg.prices.map((p) => p.symbol), error: null };
    } catch (e) {
      this.venueFeed = { ts: this.venueFeed?.ts ?? 0, symbols: this.venueFeed?.symbols ?? [], error: errMsg(e) ?? "publish failed" };
      if (this.now() - this.lastVenueFeedWarn > 30_000) {
        this.lastVenueFeedWarn = this.now();
        this.log.warn({ err: errMsg(e) }, "venue feed publish failed (Orderly builder prices go stale)");
      }
    }
  }

  private pushVenue(msgs: OraclePriceMsg[]): void {
    const venue = this.deps.venue;
    if (!venue || !this.deps.settings.venuePrices || this.now() < this.venueBackoffUntil) return;
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

  /**
   * The push mode in force: the configured one, except that pull mode against a pre-low-gas AttestedOracle
   * (no update(bytes): no consumer can carry the bundle) keeps the heartbeat pushes.
   */
  effectivePushMode(): PushMode {
    if (this.deps.settings.pushMode === "heartbeat") return "heartbeat";
    return this.ctx?.chain && this.pullSupported === false ? "heartbeat" : "pull";
  }

  /** Heartbeat mode only: pull mode never sends pushMany (the bundle rides in consumers' transactions). */
  private chainUsable(ctx: DeploymentContext, nowMs: number): ctx is DeploymentContext & { chain: OracleChain } {
    return this.effectivePushMode() === "heartbeat" && !!ctx.chain && this.signerActive === true && nowMs >= this.chainBackoffUntil;
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
          for (const m of batch) {
            this.onchainAt.set(m.priceId, m.publishedAt);
            this.landed.set(m.priceId, m);
          }
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

  /**
   * Public view (HTTP /prices), never with the signature. Heartbeat mode with on-chain pushes: only
   * updates that have already LANDED on-chain (there the pool trades at the stored price; a fresher signed
   * one would let a trader trade stored, relay newer and close). Pull mode: the latest price — signed
   * prices are public by design there (/prices/signed): every trade carries its own price, PoolEngine
   * bounds its age (maxTradePriceAge) and the spread covers the residual (docs/LOW_GAS.md §1).
   */
  publicPrice(priceId: string): PublicPriceMsg | null {
    const landedOnly = this.effectivePushMode() === "heartbeat" && !!this.ctx?.chain;
    const m = landedOnly ? this.landed.get(priceId) : this.latest.get(priceId);
    return m ? publicView(m) : null;
  }

  /** The latest signed bundle (GET /prices/signed, Redis KEYS.oracleBundle); null before the first live tick. */
  signedBundle(): OracleBundleMsg | null {
    return this.ctx ? this.bundle : null;
  }

  publicPrices(): PublicPriceMsg[] {
    return this.universe.map((e) => this.publicPrice(e.priceId)).filter((m): m is PublicPriceMsg => !!m);
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
      /** median | primary-confirm (Chainlink signs; role confirm sources are compared only) */
      policy: this.policy(),
      confirmBps: this.policy() === "primary-confirm" ? (this.deps.settings.confirmBps ?? DEFAULT_CONFIRM_BPS) : null,
      primaryLagBps: this.policy() === "primary-confirm" ? (this.deps.settings.primaryLagBps ?? DEFAULT_PRIMARY_LAG_BPS) : null,
      /** per live source: role, last fresh observation, current failure run (in-session tickers only), last error class */
      sources: this.sourceHealth.view(),
      /** primary-confirm: per equity, how the confirm sources compare with Chainlink */
      confirm: this.universe.map((e) => this.confirmState.get(e.priceId)).filter((c): c is ConfirmView => !!c),
      /** in-session price ids with no publishable price this tick (since = start of the run) */
      /** since = start of the run (kept for the hysteresis after recovery), lastSeenAt = latest tick without a price */
      unpublished: [...this.unpublished.entries()].map(([priceId, u]) => ({ priceId, since: u.since, lastSeenAt: u.lastSeenAt, reason: u.reason })),
      pushMode: this.deps.settings.pushMode,
      effectivePushMode: this.effectivePushMode(),
      bundle: this.bundle ? { publishedAt: this.bundle.publishedAt, priceIds: this.bundle.priceIds } : null,
      lastPush: this.lastPush,
      onchain: {
        enabled: !!ctx?.chain,
        pushes: this.effectivePushMode() === "heartbeat" && !!ctx?.chain,
        pullSupported: this.pullSupported,
        signerRegistered: this.signerActive,
        status: this.chainReason,
        minSources: Math.max(this.deps.settings.minSources, this.onchainMinSources ?? 0),
        minSourcesProblem: this.minSourcesProblem,
        backoffUntil: this.chainBackoffUntil > this.now() ? this.chainBackoffUntil : null,
      },
      /**
       * Builder prices for Orderly books. mode mock: posted to mock-orderly by the oracle; null (live): the venue feed
       * (Redis KEYS.oracleVenueFeed) is pushed to Orderly's Builder Oracle by ops-venue (bkrn:ops-venue:builder-feed).
       */
      venue: {
        mode: this.deps.venue?.mode ?? null,
        enabled: this.deps.settings.venuePrices,
        pushedBy: this.deps.venue ? "oracle" : "ops-venue",
        feed: this.venueFeed,
      },
    };
  }

  signerInfo(): { address: Address; registered: boolean | null; chainId: number | null; oracle: Address | null } {
    return { address: this.deps.signer.address, registered: this.signerActive, chainId: this.ctx?.chainId ?? null, oracle: this.ctx?.oracle ?? null };
  }
}
