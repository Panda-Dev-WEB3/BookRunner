// Chainlink AggregatorV3 source (VERIFY C1-C4). Feeds come from config/chains/<chainId>.json and/or
// ORACLE_CHAINLINK_FEEDS (config.ts). Per observation:
//   - optional L2 sequencer uptime feed: down, or up for less than the grace period -> no observation;
//   - decimals() read on-chain (cached); a mismatch with the configured decimals refuses the feed;
//   - latestRoundData(): answer > 0, updatedAt > 0, not in the future; the observation carries the feed's
//     own in-session max age (heartbeat + grace) and the aggregator rejects it beyond that. Staleness is
//     only a per-observation filter: the `held` flag comes from the session calendar (domain/hold.ts),
//     never from the feed (C3: off-hours the feed holds its last price and stays callable);
//   - per-token feeds (Robinhood tokenized equities: answer = share price x uiMultiplier) are divided by
//     the token's uiMultiplier() read in the same pass, so every published price is PER SHARE and the
//     registry applies the multiplier exactly once (C2, packages/shared/src/stockTokens.ts). No observation
//     while the token's advisory oraclePaused() is set (corporate action). When the active multiplier
//     became effective after the feed's last round, the answer still embeds the previous multiplier: the
//     source divides by the multiplier it saw with that same round (cached), or drops the observation
//     when it never saw the round before the change (e.g. right after a restart) or when the change is a
//     split (a step beyond the band: the share unit changed, audit M-2; the registry independently refuses
//     a price whose basis predates the change).
// RPC budget (deploy/server/MAINNET.md "RPC budget"): every read of one pass — the sequencer feed, every feed's
// latestRoundData, the decimals not cached yet and the Stock Token states that are due — goes into ONE Multicall3
// aggregate3 eth_call at one block (viemAggregatorReader.read, allowFailure: an optional token view that reverts is
// null), shared by every ticker of the tick. `readIntervalMs` (ORACLE_CHAINLINK_READ_MS) reuses a pass that recent;
// `tokenStateIntervalMs` (ORACLE_TOKEN_STATE_READ_MS) re-reads a token's state on that cadence, but at every pass while
// its effectiveAt is within SPLIT_WINDOW_REREAD_MS or its cached oraclePaused is set, and at once when a staged change
// became active after the cached read (split windows fail closed: no per-share price from a pre-change token state).
import { type FeedConfig, feedAnswerToWad, perSharePriceWad } from "@bookrunner/shared";
import type { Address, PublicClient } from "viem";
import type { PriceSource, SourceObservation } from "../domain/types";

export const aggregatorV3Abi = [
  { type: "function", name: "decimals", inputs: [], outputs: [{ name: "", type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "description", inputs: [], outputs: [{ name: "", type: "string" }], stateMutability: "view" },
  {
    type: "function",
    name: "latestRoundData",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
  },
] as const;

/** ERC-8056 + Robinhood Stock Token views (contracts/src/interfaces/external/IScaledUIAmount.sol). */
export const stockTokenAbi = [
  { type: "function", name: "uiMultiplier", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "newUIMultiplier", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "effectiveAt", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "oraclePaused", inputs: [], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ name: "", type: "uint8" }], stateMutability: "view" },
] as const;

export interface RoundData {
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
}

export interface TokenState {
  uiMultiplier: bigint;
  /** null when the view is not implemented */
  newUIMultiplier: bigint | null;
  effectiveAt: bigint | null;
  oraclePaused: boolean | null;
}

/** A read that may have failed on its own (Multicall3 allowFailure). */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: Error };

export const settledOk = <T>(value: T): Settled<T> => ({ ok: true, value });
export const settledErr = <T>(e: unknown): Settled<T> => ({ ok: false, error: e instanceof Error ? e : new Error(String(e)) });
const settle = <T>(p: Promise<T>): Promise<Settled<T>> => p.then(settledOk<T>, settledErr<T>);

/** Everything one Chainlink pass reads. */
export interface ChainlinkReadRequest {
  sequencer: Address | null;
  /** latestRoundData of each */
  feeds: readonly Address[];
  /** decimals() of each (feeds whose decimals are not cached yet) */
  decimals: readonly Address[];
  /** Stock Token states due this pass */
  tokens: readonly Address[];
}

export interface ChainlinkRead {
  /** timestamp (unix s) of the block the pass was read at; null when unknown (per-call reads) */
  blockTimestamp: number | null;
  sequencer: Settled<RoundData> | null;
  rounds: ReadonlyMap<Address, Settled<RoundData>>;
  decimals: ReadonlyMap<Address, Settled<number>>;
  tokens: ReadonlyMap<Address, Settled<TokenState>>;
}

export interface AggregatorReader {
  decimals(feed: Address): Promise<number>;
  latestRoundData(feed: Address): Promise<RoundData>;
  /** `blockNumber`: read at that block (the DEX source pins every read of a tick to one block); default latest */
  tokenState(token: Address, blockNumber?: bigint): Promise<TokenState>;
  /** One pass in one batched call at one block (Multicall3 aggregate3). Absent: per-call reads (readPerCall). */
  read?(req: ChainlinkReadRequest): Promise<ChainlinkRead>;
}

/** A pass through the per-call reads (readers without a batched read: tests, chains without Multicall3). */
export async function readPerCall(r: Pick<AggregatorReader, "decimals" | "latestRoundData" | "tokenState">, req: ChainlinkReadRequest): Promise<ChainlinkRead> {
  const [sequencer, rounds, decimals, tokens] = await Promise.all([
    req.sequencer ? settle(r.latestRoundData(req.sequencer)) : Promise.resolve(null),
    Promise.all(req.feeds.map(async (f) => [f, await settle(r.latestRoundData(f))] as const)),
    Promise.all(req.decimals.map(async (f) => [f, await settle(r.decimals(f))] as const)),
    Promise.all(req.tokens.map(async (t) => [t, await settle(r.tokenState(t))] as const)),
  ]);
  return { blockTimestamp: null, sequencer, rounds: new Map(rounds), decimals: new Map(decimals), tokens: new Map(tokens) };
}

/** Multicall3: aggregate3 + the block-timestamp view (the rest of its ABI is not used). */
export const multicall3Abi = [
  { type: "function", name: "getCurrentBlockTimestamp", inputs: [], outputs: [{ name: "timestamp", type: "uint256" }], stateMutability: "view" },
] as const;

/** A Stock Token's four views as one result row (uiMultiplier required, the other three optional). */
export function tokenStateFromViews(views: readonly Settled<unknown>[]): Settled<TokenState> {
  const [ui, next, eff, paused] = views;
  if (!ui?.ok) return settledErr(ui?.error ?? new Error("uiMultiplier() not read"));
  const opt = <T>(s: Settled<unknown> | undefined): T | null => (s?.ok ? (s.value as T) : null);
  return settledOk({ uiMultiplier: ui.value as bigint, newUIMultiplier: opt<bigint>(next), effectiveAt: opt<bigint>(eff), oraclePaused: opt<boolean>(paused) });
}

/** Stock Token views in the order tokenStateFromViews expects. */
export const TOKEN_STATE_VIEWS = ["uiMultiplier", "newUIMultiplier", "effectiveAt", "oraclePaused"] as const;

/**
 * Why a Stock Token's state forbids converting its per-token price to per share (null = usable). Shared by every
 * per-token source (Chainlink per-token feeds, the DEX TWAP): no multiplier, or a corporate action in progress.
 */
export function tokenStateProblem(token: TokenState): string | null {
  if (token.uiMultiplier <= 0n) return "uiMultiplier() = 0";
  if (token.oraclePaused === true) return "token oraclePaused() (corporate action in progress)";
  return null;
}

/** A multiplier change announced for the future (newUIMultiplier != uiMultiplier, effectiveAt ahead), else null. */
export function pendingMultiplierOf(token: TokenState, nowMs: number): { value: bigint; effectiveAt: number } | null {
  const eff = token.effectiveAt ?? 0n;
  if (token.newUIMultiplier !== null && token.newUIMultiplier !== token.uiMultiplier && Number(eff) * 1000 > nowMs) {
    return { value: token.newUIMultiplier, effectiveAt: Number(eff) };
  }
  return null;
}

const optional = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

/**
 * viem reader. `multicall` (Multicall3 address, shared multicall3For): every pass is ONE aggregate3 eth_call at one
 * block (latest), with the block's timestamp; null: per-call reads (devnet / testnet, unchanged).
 */
export function viemAggregatorReader(pub: PublicClient, multicall: Address | null = null): AggregatorReader {
  const self: AggregatorReader = {
    async read(req) {
      if (!multicall) return readPerCall(self, req);
      const contracts = [
        { address: multicall, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" as const },
        ...(req.sequencer ? [{ address: req.sequencer, abi: aggregatorV3Abi, functionName: "latestRoundData" as const }] : []),
        ...req.feeds.map((address) => ({ address, abi: aggregatorV3Abi, functionName: "latestRoundData" as const })),
        ...req.decimals.map((address) => ({ address, abi: aggregatorV3Abi, functionName: "decimals" as const })),
        ...req.tokens.flatMap((address) => TOKEN_STATE_VIEWS.map((functionName) => ({ address, abi: stockTokenAbi, functionName }))),
      ];
      // batchSize 0: never chunked, one aggregate3 whatever the size
      const res = await pub.multicall({ contracts, allowFailure: true, multicallAddress: multicall, batchSize: 0 });
      const rows: Settled<unknown>[] = res.map((r) => (r.status === "success" ? settledOk(r.result as unknown) : settledErr(r.error)));
      let i = 0;
      const next = () => rows[i++] ?? settledErr(new Error("multicall result missing"));
      const ts = next();
      const round = (s: Settled<unknown>): Settled<RoundData> => {
        if (!s.ok) return s;
        const [, answer, startedAt, updatedAt] = s.value as readonly [bigint, bigint, bigint, bigint, bigint];
        return settledOk({ answer, startedAt, updatedAt });
      };
      const sequencer = req.sequencer ? round(next()) : null;
      const rounds = new Map(req.feeds.map((f) => [f, round(next())] as const));
      const decimals = new Map(
        req.decimals.map((f) => {
          const s = next();
          return [f, s.ok ? settledOk(Number(s.value)) : s] as const;
        }),
      );
      const tokens = new Map(req.tokens.map((t) => [t, tokenStateFromViews(TOKEN_STATE_VIEWS.map(() => next()))] as const));
      return { blockTimestamp: ts.ok ? Number(ts.value) : null, sequencer, rounds, decimals, tokens };
    },
    async decimals(feed) {
      return Number(await pub.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "decimals" }));
    },
    async latestRoundData(feed) {
      const [, answer, startedAt, updatedAt] = await pub.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData" });
      return { answer, startedAt, updatedAt };
    },
    async tokenState(token, blockNumber) {
      const at = blockNumber === undefined ? {} : { blockNumber };
      const [uiMultiplier, newUIMultiplier, effectiveAt, oraclePaused] = await Promise.all([
        pub.readContract({ address: token, abi: stockTokenAbi, functionName: "uiMultiplier", ...at }),
        optional(pub.readContract({ address: token, abi: stockTokenAbi, functionName: "newUIMultiplier", ...at })),
        optional(pub.readContract({ address: token, abi: stockTokenAbi, functionName: "effectiveAt", ...at })),
        optional(pub.readContract({ address: token, abi: stockTokenAbi, functionName: "oraclePaused", ...at })),
      ]);
      return { uiMultiplier, newUIMultiplier, effectiveAt, oraclePaused };
    },
  };
  return self;
}

/** A configured feed, resolved (token address + in-session max age). */
export interface ResolvedFeed {
  proxy: Address;
  /** configured Chainlink heartbeat (s), when known: bounds maxAgeMs on mainnet (production.ts) */
  heartbeatSec?: number;
  basis: FeedConfig["basis"];
  token: Address | null;
  decimals?: number;
  /** in-session staleness bound for this feed's observations */
  maxAgeMs: number;
  description?: string;
}

export interface ChainlinkOptions {
  /** Chainlink L2 sequencer uptime feed (answer 0 = up). */
  sequencerFeed?: Address | null;
  /** Sequencer must have been up this long (Chainlink's recommended grace: 3600 s). */
  sequencerGraceMs?: number;
  /** Tolerated lead of updatedAt over the local clock. */
  maxFutureMs?: number;
  /** Initial split band (bps of the round's multiplier; default 500): the registry's governance band once {@link ChainlinkSource.setSplitBandBps} reads it. */
  splitBandBps?: number;
  /** A pass started less than this ago is reused by every ticker (ORACLE_CHAINLINK_READ_MS; 0 = a pass per tick). */
  readIntervalMs?: number;
  /** A Stock Token's state is re-read on this cadence (ORACLE_TOKEN_STATE_READ_MS; 0 = every pass); see tokenStateDue. */
  tokenStateIntervalMs?: number;
  /** Every pass that knows its block timestamp reports it here (the oracle's HeadClock). */
  onBlockTimestamp?: (tsSec: number) => void;
  now?: () => number;
}

/** A token whose effectiveAt is this close (either side) has its state read at every pass (audit M-2 split window). */
export const SPLIT_WINDOW_REREAD_MS = 600_000;
/** A failed pass is retried after at most this long (never later than the read interval). */
export const READ_RETRY_MS = 2_000;

/** A Stock Token's state as cached by the Chainlink source. */
export interface CachedTokenState {
  state: TokenState;
  /** wall clock (ms) of the pass that read it */
  readAtMs: number;
  /** block timestamp (unix s) of that pass; null when unknown (per-call reads: the wall clock stands in) */
  blockTs: number | null;
}

/** Chain time (ms) a cached token state describes. */
const describedAtMs = (c: CachedTokenState): number => (c.blockTs !== null ? c.blockTs * 1000 : c.readAtMs);

/**
 * Whether a cached token state must be re-read at this pass (pure). Due when: never read; read `intervalMs` ago or
 * more; its oraclePaused is set (resume as soon as the issuer clears it); its effectiveAt is within
 * SPLIT_WINDOW_REREAD_MS of now on either side (the change and its aftermath are read at every pass); or a staged
 * change became active after the cached read (tokenStatePredatesChange).
 */
export function tokenStateDue(c: CachedTokenState | undefined, nowMs: number, intervalMs: number): boolean {
  if (!c) return true;
  if (nowMs - c.readAtMs >= intervalMs) return true;
  if (c.state.oraclePaused === true) return true;
  const eff = c.state.effectiveAt;
  if (eff !== null && eff > 0n && Math.abs(Number(eff) * 1000 - nowMs) <= SPLIT_WINDOW_REREAD_MS) return true;
  return tokenStatePredatesChange(c, nowMs);
}

/** A multiplier change (effectiveAt) took effect after the cached state was read and by `nowMs`: that state no longer describes the active multiplier. */
export function tokenStatePredatesChange(c: CachedTokenState, nowMs: number): boolean {
  const eff = c.state.effectiveAt;
  if (eff === null || eff <= 0n) return false;
  const effMs = Number(eff) * 1000;
  return effMs > describedAtMs(c) && effMs <= nowMs;
}

/**
 * Multiplier step above which a change after the feed's last round is a split (the share unit changed) rather
 * than in-band drift. Initial value: StockTokenRegistry.DEFAULT_MULTIPLIER_BAND_BPS; the service reads the live
 * governance band (multiplierBandBps) at startup and every 10 min (setSplitBandBps).
 */
export const MULTIPLIER_SPLIT_BAND_BPS = 500;

function withinBand(live: bigint, ref: bigint, bandBps: number): boolean {
  const diff = live > ref ? live - ref : ref - live;
  return diff * 10_000n <= ref * BigInt(bandBps);
}

export type ChainlinkObservation =
  | {
      ok: true;
      /** price per SHARE (per-token feeds already divided by uiMultiplier) */
      price: number;
      ts: number;
      maxAgeMs: number;
      ageMs: number;
      stale: boolean;
      decimals: number;
      answer: bigint;
      /** multiplier the per-token answer was divided by (null for per-share feeds) */
      uiMultiplier: bigint | null;
      pendingMultiplier: { value: bigint; effectiveAt: number } | null;
    }
  | { ok: false; reason: string };

export class ChainlinkSource implements PriceSource {
  readonly name = "chainlink";
  readonly kind = "chainlink" as const;
  private readonly decimalsCache = new Map<Address, number>();
  /** Multiplier in force when a feed round was first observed (the one the answer embeds). */
  private readonly roundMultiplier = new Map<Address, { updatedAt: bigint; multiplier: bigint }>();
  private readonly now: () => number;
  /** audit M-2: StockTokenRegistry.multiplierBandBps (governance-settable), refreshed by the service */
  private splitBandBps: number;
  private readonly tokenStates = new Map<Address, CachedTokenState>();
  /** the current pass, shared by every ticker while in flight or younger than readIntervalMs */
  private pass: { startedAt: number; promise: Promise<ChainlinkRead>; done: boolean; failed: boolean } | null = null;
  private readonly readIntervalMs: number;
  private readonly tokenStateIntervalMs: number;
  /** completed passes (tests, /health diagnostics) */
  passes = 0;

  constructor(
    private readonly feeds: Record<string, ResolvedFeed>,
    private readonly reader: AggregatorReader,
    private readonly opts: ChainlinkOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.splitBandBps = opts.splitBandBps ?? MULTIPLIER_SPLIT_BAND_BPS;
    this.readIntervalMs = Math.max(0, opts.readIntervalMs ?? 0);
    this.tokenStateIntervalMs = Math.max(0, opts.tokenStateIntervalMs ?? 0);
  }

  /** The cached state of a Stock Token (null = never read). */
  tokenState(token: Address): CachedTokenState | null {
    return this.tokenStates.get(token) ?? null;
  }

  private perTokenFeeds(): Array<ResolvedFeed & { token: Address }> {
    return Object.values(this.feeds).filter((f): f is ResolvedFeed & { token: Address } => f.basis === "per-token" && f.token !== null);
  }

  /** The pass this observation uses: the current one when in flight or fresh, else a new one (one batched read for every feed). */
  private currentPass(nowMs: number): Promise<ChainlinkRead> {
    const p = this.pass;
    if (p && !p.done) return p.promise;
    const reuseMs = p?.failed ? Math.min(this.readIntervalMs, READ_RETRY_MS) : this.readIntervalMs;
    const stale = this.perTokenFeeds().some((f) => {
      const c = this.tokenStates.get(f.token);
      return !!c && tokenStatePredatesChange(c, nowMs);
    });
    if (p && nowMs - p.startedAt < reuseMs && !stale) return p.promise;

    const feeds = Object.values(this.feeds);
    const tokens = [...new Set(this.perTokenFeeds().map((f) => f.token))].filter((t) => tokenStateDue(this.tokenStates.get(t), nowMs, this.tokenStateIntervalMs));
    const req: ChainlinkReadRequest = {
      sequencer: this.opts.sequencerFeed ?? null,
      feeds: [...new Set(feeds.map((f) => f.proxy))],
      decimals: [...new Set(feeds.map((f) => f.proxy))].filter((a) => !this.decimalsCache.has(a)),
      tokens,
    };
    const startedAt = nowMs;
    const entry = { startedAt, promise: null as unknown as Promise<ChainlinkRead>, done: false, failed: false };
    entry.promise = (this.reader.read ? this.reader.read(req) : readPerCall(this.reader, req)).then(
      (r) => {
        entry.done = true;
        this.passes++;
        for (const [a, d] of r.decimals) if (d.ok) this.decimalsCache.set(a, d.value);
        for (const [t, s] of r.tokens) {
          if (s.ok) this.tokenStates.set(t, { state: s.value, readAtMs: startedAt, blockTs: r.blockTimestamp });
          else this.tokenStates.delete(t); // a failed read is never served from the cache
        }
        if (r.blockTimestamp !== null) this.opts.onBlockTimestamp?.(r.blockTimestamp);
        return r;
      },
      (e: unknown) => {
        entry.done = true;
        entry.failed = true;
        throw e;
      },
    );
    this.pass = entry;
    return entry.promise;
  }

  /** The registry's live-multiplier band (StockTokenRegistry.multiplierBandBps): a step beyond it is a split. */
  setSplitBandBps(bps: number): void {
    if (Number.isInteger(bps) && bps > 0 && bps <= 10_000) this.splitBandBps = bps;
  }

  get splitBand(): number {
    return this.splitBandBps;
  }

  tickers(): string[] {
    return Object.keys(this.feeds);
  }

  feed(ticker: string): ResolvedFeed | undefined {
    return this.feeds[ticker];
  }

  async fetch(ticker: string): Promise<SourceObservation | null> {
    const o = await this.observe(ticker);
    return o.ok ? { price: o.price, ts: o.ts, maxAgeMs: o.maxAgeMs } : null;
  }

  /** Full observation with the reason when unusable (fetch, and the source-check CLI). */
  async observe(ticker: string): Promise<ChainlinkObservation> {
    const f = this.feeds[ticker];
    if (!f) return { ok: false, reason: "no feed configured" };
    const nowMs = this.now();
    const pass = await this.currentPass(nowMs);
    const value = <T>(s: Settled<T> | null | undefined, what: string): T => {
      if (!s) throw new Error(`${what} not read`);
      if (!s.ok) throw s.error;
      return s.value;
    };

    const seq = this.opts.sequencerFeed;
    if (seq) {
      const s = value(pass.sequencer, "sequencer uptime feed");
      if (s.answer !== 0n) return { ok: false, reason: "L2 sequencer down" };
      const upForMs = nowMs - Number(s.startedAt) * 1000;
      if (upForMs < (this.opts.sequencerGraceMs ?? 3_600_000)) return { ok: false, reason: `L2 sequencer up for ${Math.round(upForMs / 1000)}s (< grace)` };
    }

    const dec = this.decimalsCache.get(f.proxy) ?? value(pass.decimals.get(f.proxy), `decimals() of ${f.proxy}`);
    if (f.decimals !== undefined && dec !== f.decimals) return { ok: false, reason: `decimals() = ${dec}, configured ${f.decimals}` };

    const round = value(pass.rounds.get(f.proxy), `latestRoundData() of ${f.proxy}`);
    let token: TokenState | null = null;
    if (f.basis === "per-token" && f.token) {
      const read = pass.tokens.get(f.token);
      if (read && !read.ok) throw read.error;
      const cached = this.tokenStates.get(f.token);
      if (!cached) throw new Error(`Stock Token ${f.token} state not read`);
      // audit M-2: a staged change that became active after this state was read: the state no longer describes the
      // active multiplier (split windows fail closed; the next pass re-reads it)
      if (tokenStatePredatesChange(cached, nowMs)) {
        return { ok: false, reason: `multiplier change at ${cached.state.effectiveAt} after the token state was read: no per-share price until it is read again` };
      }
      token = cached.state;
    }
    if (round.answer <= 0n) return { ok: false, reason: `answer ${round.answer} <= 0` };
    if (round.updatedAt === 0n) return { ok: false, reason: "round not complete (updatedAt 0)" };
    const ts = Number(round.updatedAt) * 1000;
    if (ts > nowMs + (this.opts.maxFutureMs ?? 5_000)) return { ok: false, reason: "updatedAt in the future" };

    const answerWad = feedAnswerToWad(round.answer, dec);
    let priceWad = answerWad;
    let pendingMultiplier: { value: bigint; effectiveAt: number } | null = null;
    let multiplierUsed: bigint | null = null;
    if (f.basis === "per-token") {
      if (!f.token || !token) return { ok: false, reason: "per-token feed without a Stock Token (cannot divide by uiMultiplier)" };
      const problem = tokenStateProblem(token);
      if (problem) return { ok: false, reason: problem };
      const eff = token.effectiveAt ?? 0n;
      let multiplier = token.uiMultiplier;
      if (eff > round.updatedAt && Number(eff) * 1000 <= nowMs) {
        // the active multiplier changed after this round: the answer embeds the previous one. Known
        // exactly if this very round was observed before the change; otherwise drop the observation.
        const seen = this.roundMultiplier.get(f.proxy);
        if (!seen || seen.updatedAt !== round.updatedAt) {
          return { ok: false, reason: `multiplier became effective at ${eff} after the feed's last round (${round.updatedAt})` };
        }
        // audit M-2: a step beyond the band is a split / reverse split: the share unit itself changed, so the
        // round's per-share price is in OLD shares and the registry would value it at the new multiplier
        // (10x for a 10:1 split). No observation until the feed's first round after the change. In-band drift
        // (dividend reinvestment) keeps the share unit, so the round's per-share price is still a valid share price,
        // but it is the PRE-change one (before the ex-dividend move) under a fresh publishedAt the registry guard
        // cannot see: the registry values it at the new multiplier, an error of at most the band (residual, D-M2-4).
        if (!withinBand(token.uiMultiplier, seen.multiplier, this.splitBandBps)) {
          return {
            ok: false,
            reason: `multiplier ${seen.multiplier} -> ${token.uiMultiplier} at ${eff}, after the feed's last round (${round.updatedAt}): a split changes the share unit, no per-share price until the next round`,
          };
        }
        multiplier = seen.multiplier;
      } else {
        this.roundMultiplier.set(f.proxy, { updatedAt: round.updatedAt, multiplier });
      }
      pendingMultiplier = pendingMultiplierOf(token, nowMs);
      multiplierUsed = multiplier;
      priceWad = perSharePriceWad(answerWad, multiplier);
    }
    const ageMs = nowMs - ts;
    return {
      ok: true,
      price: Number(priceWad) / 1e18,
      ts,
      maxAgeMs: f.maxAgeMs,
      ageMs,
      stale: ageMs > f.maxAgeMs,
      decimals: dec,
      answer: round.answer,
      uiMultiplier: multiplierUsed,
      pendingMultiplier,
    };
  }
}
