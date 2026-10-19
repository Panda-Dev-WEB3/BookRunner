// Live builder price push (ORDERLY_MODE=live, docs/VERIFY.md O18): the oracle's signed per-share price of every Orderly
// book is pushed to Orderly's Builder Oracle (feed ORACLE_<broker>, base_ccy = the venue symbol's base) at least once a
// second while the market session is open. Prices come only from the oracle's venue feed (Redis KEYS.oracleVenueFeed);
// between oracle ticks the LATEST SIGNED price is re-sent, never a new one. Nothing is pushed for a symbol the oracle
// holds (session closed: Orderly freezes the index OFF_MARKET and applies its own off-market handling), marks stale (no
// publishable price this tick) or whose price is older than maxAgeMs (held or not; never below 3 oracle ticks). Per-symbol state goes to Redis
// KEYS.builderFeedStatus; services/alerts raises builder_price_push when a symbol fails for > 30 s in session.
// Trust: Redis is NOT trusted for the price. Every entry must carry the oracle's EIP-712 signed PriceUpdate; it is pushed
// only when the signature recovers, under the configured domain (CHAIN_ID + the deployment's AttestedOracle), to an
// oracle signer (AttestedOracle.isSigner on-chain, or the pinned OPS_BUILDER_ORACLE_SIGNERS). The pushed price, its age
// (publishedAt) and held come from the SIGNED fields only. An unsigned / wrongly signed entry is never pushed (state
// invalid -> alert), and a signed price more than maxDeviationBps away from the last pushed one is held back (invalid ->
// alert) unless it persists for deviationAcceptMs (a real gap open, re-signed every tick), then accepted with a warning.
// The entry's symbol is NOT signed: each push target carries the signed underlying its books expect (the stock token's
// price id from the deployment record, never from Redis) and an entry signed for another underlying is refused (a valid
// NVDA price can never be pushed as TSLA). A signed publishedAt older than the last pushed one for the symbol is refused
// (no replay / reorder inside the age window); re-sending the same latest signed price between ticks stays the norm.
import { baseAssetOf, type BuilderFeedStatusMsg, type BuilderPushState, type Deployment, isTokenUnderlying, type Logger, type OracleVenueFeedMsg, type OracleVenuePrice, type PriceUpdate, recoverPriceSigner, underlyingToToken } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import { type TrackedBook, tradable } from "../worker/context";
import type { PublishReject } from "./socket";

/** What the feed needs of the WebSocket client (BuilderOracleSocket; tests fake it). */
export interface FeedSocket {
  readonly ready: boolean;
  readonly state: string;
  readonly lastError: string | null;
  readonly host: string | null;
  publish(base: string, price: number): string | null;
}

/** One builder market to keep fed: the venue symbol of tradable Orderly books (ops-venue book registry). */
export interface PushTarget {
  symbol: string;
  bookIds: number[];
  /**
   * the market is not listed on Orderly yet (TrackedBook.listing: not on /v1/public/info, or NEW / PENDING; before the
   * first listing check: every book on it is in Subscription); failures are logged, not paged
   */
  preListing?: boolean;
  /**
   * the signed PriceUpdate.underlying the books of this market expect (lowercase), from the deployment record; null =
   * unknown or inconsistent across the books (nothing is pushed, underlyingError says why)
   */
  underlying?: Hex | null;
  underlyingError?: string;
}

/**
 * The signed underlying an Orderly book's price must carry: the oracle signs an equity book's price under its Stock
 * Token's price id (deployment record stockTokens[].priceId, as the oracle's universe does), never the book's token
 * address. null when the book's underlying is not a registered Stock Token (nothing pushed for it).
 */
export function expectedUnderlyingResolver(stockTokens: Deployment["stockTokens"]): (b: Pick<TrackedBook, "underlying">) => Hex | null {
  const byToken = new Map(Object.values(stockTokens ?? {}).map((st) => [st.token.toLowerCase(), st.priceId.toLowerCase() as Hex]));
  return (b) => (b.underlying && isTokenUnderlying(b.underlying) ? (byToken.get(underlyingToToken(b.underlying).toLowerCase()) ?? null) : null);
}

/** Who may sign a pushed price: the oracle's EIP-712 domain and its signer set. */
export interface PriceSignerCheck {
  chainId: number;
  /** the deployment's AttestedOracle (EIP-712 verifying contract) */
  oracle: Address;
  /** true / false = a signer or not; THROWS when the check is unavailable (RPC): never a cached "no" */
  isOracleSigner(addr: Address): Promise<boolean>;
}

export interface BuilderPriceFeedOptions {
  /** null = the push cannot run (no WebSocket domain / key): every target reports not-configured */
  socket: FeedSocket | null;
  /** signature check of every price (required: an unsigned Redis value is never pushed) */
  verifier: PriceSignerCheck;
  /** max move vs the last pushed price per push (bps, default 1000 = 10 %): beyond it the price is held back (alert) */
  maxDeviationBps?: number;
  /** a capped price that persists this long (signed every tick) is accepted (default 120 s) */
  deviationAcceptMs?: number;
  /** why socket is null */
  notConfigured?: string;
  targets: () => PushTarget[];
  log: Logger;
  now?: () => number;
  /** push cadence; Orderly requires >= 1 publish/s while the session is open */
  intervalMs?: number;
  /**
   * a signed price older than this (oracle wall clock) is not re-sent, held or not (the oracle re-signs held prices
   * every tick, so an old held price means the oracle stopped). Never below 3 oracle ticks (OracleVenueFeedMsg.tickMs).
   */
  maxAgeMs?: number;
  /** a rejected publish keeps the symbol "rejected" this long (reject latency jitter must not reset the failing run) */
  rejectHoldMs?: number;
  /** Redis reads / writes of the push loop run off the hot path and are abandoned after this long */
  ioTimeoutMs?: number;
}

interface SymbolState {
  symbol: string;
  base: string;
  bookIds: number[];
  preListing: boolean;
  state: BuilderPushState;
  lastPushAt: number | null;
  price: number | null;
  failingSince: number | null;
  error: string | null;
  logged?: boolean;
  /** since when the signed price has been beyond the deviation cap (null = within) */
  capSince?: number | null;
  /** signed publishedAt (ms) of the last pushed price: an older one is never pushed */
  lastPushedPublishedAtMs?: number | null;
}

/** A verified entry: price, age and held from the SIGNED PriceUpdate; stale (can only stop a push) from the feed. */
interface VerifiedPrice {
  symbol: string;
  /** the signed underlying (lowercase) */
  underlying: Hex;
  price: number;
  held: boolean;
  stale: boolean;
  publishedAtMs: number;
  feedTs: number;
  tickMs: number | null;
}

/** Book states whose builder market is (or is about to be) listed: provisioning lists every non-cancelled book. */
const FED_STATES: ReadonlySet<string> = new Set(["Subscription", "Live", "Retiring"]);

/**
 * A book's market was never seen listed: the listing check's phase awaiting (worker/listing.ts); without a successful
 * check, the book is still in Subscription (the market is listed during the subscription, by hand in manual mode,
 * VERIFY O20). A listed market that went missing or restricted is NOT preListing: its push failures page.
 */
function preListingOf(b: Pick<TrackedBook, "state" | "listing">): boolean {
  const p = b.listing?.phase;
  if (p === "awaiting") return true;
  if (p === "listed" || p === "missing") return false;
  return b.state === "Subscription";
}

/** Push targets: tradable Orderly books (they have a builder market) in a listed state, one entry per venue symbol. */
export function builderFeedTargets(
  books: ReadonlyArray<Pick<TrackedBook, "bookId" | "symbol" | "state" | "venueSymbolError" | "listing"> & Partial<Pick<TrackedBook, "underlying">>>,
  expected?: (b: Pick<TrackedBook, "underlying">) => Hex | null,
): PushTarget[] {
  const by = new Map<string, { bookIds: number[]; preListing: boolean; underlyings: Set<string> }>();
  for (const b of books) {
    if (!tradable(b) || !FED_STATES.has(b.state)) continue;
    const cur = by.get(b.symbol) ?? { bookIds: [], preListing: true, underlyings: new Set<string>() };
    cur.bookIds = [...cur.bookIds, b.bookId].sort((x, y) => x - y);
    cur.preListing &&= preListingOf(b);
    if (expected) cur.underlyings.add(String(expected({ underlying: b.underlying as Hex }) ?? "unknown"));
    by.set(b.symbol, cur);
  }
  return [...by.entries()].map(([symbol, v]) => {
    const t: PushTarget = { symbol, bookIds: v.bookIds, preListing: v.preListing };
    if (!expected) return t;
    const u = [...v.underlyings];
    if (u.length === 1 && u[0] !== "unknown") return { ...t, underlying: u[0] as Hex };
    return { ...t, underlying: null, underlyingError: u.includes("unknown") ? "a book of this market has no registered Stock Token price id (deployment record)" : `the books of this market expect different underlyings (${u.join(", ")})` };
  });
}

const FAILING: ReadonlySet<BuilderPushState> = new Set(["stale", "no-price", "invalid", "disconnected", "rejected", "not-configured"]);

/** Waits at most `ms` for `p` (rejects after that; `p` keeps running but is no longer awaited). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}

export class BuilderPriceFeed {
  private readonly prices = new Map<string, VerifiedPrice>();
  /** the newest entry per symbol that FAILED verification (newer than the verified one: nothing is pushed) */
  private readonly invalid = new Map<string, { feedTs: number; error: string }>();
  private readonly invalidWarned = new Map<string, string>();
  /** signature verdicts (signer or the reason), keyed by the signed fields + signature */
  private readonly verdicts = new Map<string, Address | string>();
  private readonly states = new Map<string, SymbolState>();
  /** latest reject per base_ccy ("*" = not attributable) */
  private readonly rejects = new Map<string, PublishReject>();
  private readonly now: () => number;
  private tickWarned = false;
  readonly intervalMs: number;
  readonly maxAgeMs: number;
  readonly rejectHoldMs: number;
  readonly ioTimeoutMs: number;
  readonly maxDeviationBps: number;
  readonly deviationAcceptMs: number;

  constructor(private readonly o: BuilderPriceFeedOptions) {
    this.now = o.now ?? Date.now;
    this.maxDeviationBps = o.maxDeviationBps ?? 1_000;
    this.deviationAcceptMs = o.deviationAcceptMs ?? 120_000;
    this.intervalMs = o.intervalMs ?? 1_000;
    this.maxAgeMs = o.maxAgeMs ?? 10_000;
    this.rejectHoldMs = o.rejectHoldMs ?? 5_000;
    this.ioTimeoutMs = o.ioTimeoutMs ?? 500;
  }

  /**
   * An oracle venue-feed message (Redis key or channel): per symbol, the entry of the newest oracle tick wins (the key
   * re-read can return a message already seen on the channel; an older one never overrides a newer one).
   */
  async onFeed(msg: OracleVenueFeedMsg): Promise<void> {
    if (!msg || msg.v !== 1 || !Array.isArray(msg.prices) || typeof msg.ts !== "number") return;
    const tickMs = typeof msg.tickMs === "number" && msg.tickMs > 0 ? msg.tickMs : null;
    if (tickMs !== null && 3 * tickMs > this.maxAgeMs && !this.tickWarned) {
      this.tickWarned = true;
      this.o.log.warn({ oracleTickMs: tickMs, maxAgeMs: this.maxAgeMs, effectiveMaxAgeMs: 3 * tickMs }, "OPS_BUILDER_PRICE_MAX_AGE_MS is below 3 oracle ticks: using 3 x ORACLE_TICK_MS");
    }
    const v = this.o.verifier;
    const domainOk = msg.chainId === v.chainId && typeof msg.oracle === "string" && msg.oracle.toLowerCase() === v.oracle.toLowerCase();
    for (const p of msg.prices) {
      if (!p || typeof p.symbol !== "string") continue;
      if (msg.ts < Math.max(this.prices.get(p.symbol)?.feedTs ?? -Infinity, this.invalid.get(p.symbol)?.feedTs ?? -Infinity)) continue;
      const verdict = domainOk ? await this.verify(p) : `signature domain ${msg.chainId ?? "?"} / ${msg.oracle ?? "?"} is not this deployment's (${v.chainId} / ${v.oracle})`;
      // re-check after the await: a newer message may have landed meanwhile (never let an older one win)
      if (msg.ts < Math.max(this.prices.get(p.symbol)?.feedTs ?? -Infinity, this.invalid.get(p.symbol)?.feedTs ?? -Infinity)) continue;
      // a signed price older than the one held for this symbol never replaces it (no replay / reorder by a Redis writer)
      if (typeof verdict !== "string" && verdict.publishedAtMs < (this.prices.get(p.symbol)?.publishedAtMs ?? -Infinity)) continue;
      if (typeof verdict === "string") {
        this.invalid.set(p.symbol, { feedTs: msg.ts, error: verdict });
        if (this.invalidWarned.get(p.symbol) !== verdict) {
          this.invalidWarned.set(p.symbol, verdict);
          this.o.log.warn({ symbol: p.symbol, err: verdict }, "builder feed: oracle price REJECTED (not pushed)");
        }
        continue;
      }
      this.invalid.delete(p.symbol);
      this.invalidWarned.delete(p.symbol);
      this.prices.set(p.symbol, { ...verdict, feedTs: msg.ts, tickMs });
    }
  }

  /** The signed fields of an entry, verified; a string = why it is refused. */
  private async verify(p: OracleVenuePrice): Promise<Omit<VerifiedPrice, "feedTs" | "tickMs"> | string> {
    if (typeof p.signature !== "string" || typeof p.underlying !== "string" || typeof p.priceWad !== "string" || typeof p.sourcesHash !== "string" || typeof p.sourceCount !== "number" || typeof p.publishedAt !== "number" || typeof p.held !== "boolean") {
      return "unsigned oracle price (no EIP-712 signature / signed fields)";
    }
    let wad: bigint;
    try {
      wad = BigInt(p.priceWad);
    } catch {
      return "malformed priceWad";
    }
    const u: PriceUpdate = { underlying: p.underlying as Hex, priceWad: wad, publishedAt: BigInt(Math.trunc(p.publishedAt)), held: p.held, sourceCount: p.sourceCount, sourcesHash: p.sourcesHash as Hex };
    const key = `${p.underlying}|${p.priceWad}|${p.publishedAt}|${p.held}|${p.sourceCount}|${p.sourcesHash}|${p.signature}`;
    let verdict = this.verdicts.get(key);
    if (verdict === undefined) {
      const signer = await recoverPriceSigner(this.o.verifier.chainId, this.o.verifier.oracle, u, p.signature as Hex);
      if (!signer) {
        verdict = "malformed signature";
      } else {
        let ok: boolean;
        try {
          ok = await this.o.verifier.isOracleSigner(signer);
        } catch (err) {
          // the check could not run (RPC): not a "no", never cached; the next feed message asks again
          return `signer check unavailable for ${signer}: ${err instanceof Error ? err.message : String(err)}`;
        }
        verdict = ok ? signer : `signed by ${signer}, which is not an oracle signer`;
      }
      if (this.verdicts.size >= 1_024) this.verdicts.clear();
      this.verdicts.set(key, verdict);
    }
    if (verdict.startsWith("0x") && !verdict.includes(" ")) {
      return { symbol: p.symbol, underlying: p.underlying.toLowerCase() as Hex, price: Number(wad) / 1e18, held: p.held, stale: p.stale === true, publishedAtMs: Number(u.publishedAt) * 1_000 };
    }
    return verdict;
  }

  /** Raw JSON from Redis; malformed input is ignored. */
  async onFeedJson(raw: string | null): Promise<void> {
    if (!raw) return;
    let msg: OracleVenueFeedMsg;
    try {
      msg = JSON.parse(raw) as OracleVenueFeedMsg;
    } catch {
      this.o.log.debug("builder feed: unreadable oracle venue feed ignored");
      return;
    }
    await this.onFeed(msg);
  }

  onReject(r: PublishReject): void {
    this.rejects.set(r.base ?? "*", r);
  }

  /** Effective staleness limit of one entry: maxAgeMs, never below 3 oracle ticks. */
  private maxAgeOf(p: { tickMs: number | null }): number {
    return Math.max(this.maxAgeMs, 3 * (p.tickMs ?? 0));
  }

  /** The latest reject for this base (or an unattributable one) within rejectHoldMs, if any. */
  private rejectFor(base: string, now: number): PublishReject | null {
    let best: PublishReject | null = null;
    for (const k of [base, "*"]) {
      const r = this.rejects.get(k);
      if (r && now - r.at < this.rejectHoldMs && (!best || r.at > best.at)) best = r;
    }
    return best;
  }

  /** One push round: every target, at most one publish per base_ccy. */
  tick(): void {
    const now = this.now();
    const targets = new Map<string, PushTarget>();
    for (const t of this.o.targets()) {
      const cur = targets.get(t.symbol);
      targets.set(
        t.symbol,
        cur
          ? {
              ...cur,
              bookIds: [...new Set([...cur.bookIds, ...t.bookIds])].sort((a, b) => a - b),
              preListing: !!cur.preListing && !!t.preListing,
              ...(cur.underlying?.toLowerCase() === t.underlying?.toLowerCase() ? {} : { underlying: null, underlyingError: "the sources of this market disagree on its expected underlying" }),
            }
          : t,
      );
    }
    for (const s of [...this.states.keys()]) if (!targets.has(s)) this.states.delete(s);
    const sentBase = new Set<string>();
    for (const t of targets.values()) {
      const base = baseAssetOf(t.symbol) ?? t.symbol;
      const st = this.states.get(t.symbol) ?? { symbol: t.symbol, base, bookIds: t.bookIds, preListing: false, state: "no-price" as BuilderPushState, lastPushAt: null, price: null, failingSince: null, error: null };
      st.bookIds = t.bookIds;
      st.preListing = !!t.preListing;
      this.states.set(t.symbol, st);
      const p = this.prices.get(t.symbol);
      const bad = this.invalid.get(t.symbol);
      let next: BuilderPushState;
      let error: string | null = null;
      if (!this.o.socket) {
        next = "not-configured";
        error = this.o.notConfigured ?? "builder oracle push not configured";
      } else if (bad && bad.feedTs >= (p?.feedTs ?? -Infinity)) {
        // the newest entry failed verification: nothing is pushed (not even the older verified price)
        next = "invalid";
        error = bad.error;
      } else if (!t.underlying) {
        // the signed underlying this market's books expect is unknown: no price can be bound to it
        next = "invalid";
        error = t.underlyingError ?? "no expected underlying for this market (deployment record)";
      } else if (p && p.underlying !== t.underlying.toLowerCase()) {
        // the symbol is unsigned: a price signed for another underlying (e.g. NVDA under TSLA) is never pushed
        next = "invalid";
        error = `signed price is for underlying ${p.underlying}, this market's books expect ${t.underlying.toLowerCase()}`;
      } else if (p && st.lastPushedPublishedAtMs != null && (p.publishedAtMs < st.lastPushedPublishedAtMs || (p.publishedAtMs === st.lastPushedPublishedAtMs && p.price !== st.price))) {
        // only a strictly newer signed price, or the same latest one re-sent (the >= 1/s resend), is pushed
        next = "invalid";
        error = `signed price published at ${p.publishedAtMs} is not newer than the last pushed (${st.lastPushedPublishedAtMs})`;
      } else if (!p) {
        next = "no-price";
        error = "no oracle price for this symbol";
      } else if (now - p.publishedAtMs > this.maxAgeOf(p)) {
        // before `held`: the oracle re-signs held prices every tick, so an old one (held or not) means it stopped
        next = "stale";
        error = `oracle price is ${Math.round((now - p.publishedAtMs) / 1000)} s old (max ${Math.round(this.maxAgeOf(p) / 1000)} s)${p.held ? ", last seen held" : ""}`;
      } else if (p.held) {
        next = "held";
      } else if (p.stale) {
        next = "stale";
        error = "the oracle has no publishable price in session";
      } else if (!Number.isFinite(p.price) || p.price <= 0) {
        next = "invalid";
        error = `invalid oracle price ${p.price}`;
      } else if (this.capped(st, p.price, now)) {
        next = "invalid";
        error = `signed price ${p.price} is ${Math.round((Math.abs(p.price - (st.price as number)) / (st.price as number)) * 10_000)} bps from the last pushed ${st.price} (cap ${this.maxDeviationBps} bps): held back, accepted if it persists ${Math.round(this.deviationAcceptMs / 1000)} s`;
      } else if (sentBase.has(base)) {
        next = "pushing"; // another symbol with the same base_ccy was just sent
        st.lastPushAt = now;
        st.price = p.price;
        st.lastPushedPublishedAtMs = p.publishedAtMs;
      } else if (this.o.socket.publish(base, p.price) !== null) {
        sentBase.add(base);
        st.lastPushAt = now;
        st.price = p.price;
        st.lastPushedPublishedAtMs = p.publishedAtMs;
        const reject = this.rejectFor(base, now);
        next = reject ? "rejected" : "pushing";
        if (reject) error = reject.error;
      } else {
        next = "disconnected";
        error = `builder oracle websocket ${this.o.socket.state}${this.o.socket.lastError ? `: ${this.o.socket.lastError}` : ""}`;
      }
      this.transition(st, next, error, now);
    }
  }

  /** Deviation cap vs the last pushed price; a jump that persists deviationAcceptMs is accepted (warned once). */
  private capped(st: SymbolState, price: number, now: number): boolean {
    const last = st.price;
    if (last === null || !(last > 0) || (Math.abs(price - last) / last) * 10_000 <= this.maxDeviationBps) {
      st.capSince = null;
      return false;
    }
    st.capSince ??= now;
    if (now - st.capSince < this.deviationAcceptMs) return true;
    this.o.log.warn({ symbol: st.symbol, last, price, sinceMs: now - st.capSince }, "builder feed: a capped price persisted, accepted as the new level");
    st.capSince = null;
    return false;
  }

  private transition(st: SymbolState, next: BuilderPushState, error: string | null, now: number): void {
    const prev = st.state;
    st.state = next;
    st.error = error;
    if (FAILING.has(next)) st.failingSince ??= now;
    else st.failingSince = null;
    if (prev === next && st.logged) return; // transitions only
    st.logged = true;
    const fields = { symbol: st.symbol, base: st.base, bookIds: st.bookIds, from: prev, to: next, preListing: st.preListing, ...(error ? { err: error } : {}) };
    if (FAILING.has(next)) this.o.log.warn(fields, st.preListing ? "builder price push not running (market not listed on Orderly yet)" : "builder price push not running");
    else this.o.log.info(fields, next === "held" ? "builder price push paused: session closed (oracle holds)" : "builder price push running");
  }

  status(): BuilderFeedStatusMsg {
    const s = this.o.socket;
    return {
      v: 1,
      ts: this.now(),
      intervalMs: this.intervalMs,
      maxAgeMs: this.maxAgeMs,
      socket: s ? { state: s.state, lastError: s.lastError, host: s.host } : { state: "not-configured", lastError: this.o.notConfigured ?? null, host: null },
      symbols: [...this.states.values()].map((x) => ({
        symbol: x.symbol,
        base: x.base,
        bookIds: x.bookIds,
        state: x.state,
        lastPushAt: x.lastPushAt,
        price: x.price,
        failingSince: x.failingSince,
        error: x.error,
        preListing: x.preListing,
      })),
    };
  }

  /**
   * Push loop: tick every intervalMs (scheduled from the previous start, so the cadence holds). Redis I/O never blocks
   * a tick: refresh() (re-read of the oracle feed key, covers missed pub/sub messages) every refreshEvery ticks and the
   * status write every statusEvery ticks run in the background, one at a time, abandoned after ioTimeoutMs.
   */
  async run(signal: AbortSignal, io: { refresh?: () => Promise<void>; publishStatus?: (s: BuilderFeedStatusMsg) => Promise<void>; refreshEvery?: number; statusEvery?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
    const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let refreshing: Promise<void> | null = null;
    let publishing: Promise<void> | null = null;
    let n = 0;
    while (!signal.aborted) {
      const start = this.now();
      if (io.refresh && !refreshing && n % (io.refreshEvery ?? 5) === 0) {
        refreshing = withTimeout(io.refresh(), this.ioTimeoutMs, "oracle feed read")
          .catch((err) => this.o.log.debug({ err: String(err) }, "builder feed: oracle feed read failed"))
          .finally(() => {
            refreshing = null;
          });
      }
      try {
        this.tick();
      } catch (err) {
        this.o.log.error({ err: err instanceof Error ? err.message : String(err) }, "builder feed tick failed");
      }
      if (io.publishStatus && !publishing && n % (io.statusEvery ?? 5) === 0) {
        publishing = withTimeout(io.publishStatus(this.status()), this.ioTimeoutMs, "builder feed status write")
          .catch((err) => this.o.log.debug({ err: String(err) }, "builder feed status publish failed"))
          .finally(() => {
            publishing = null;
          });
      }
      n++;
      await sleep(Math.max(0, this.intervalMs - (this.now() - start)));
    }
    await Promise.all([refreshing, publishing]);
  }
}
