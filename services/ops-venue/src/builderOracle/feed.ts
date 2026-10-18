// Live builder price push (ORDERLY_MODE=live, docs/VERIFY.md O18): the oracle's signed per-share price of every Orderly
// book is pushed to Orderly's Builder Oracle (feed ORACLE_<broker>, base_ccy = the venue symbol's base) at least once a
// second while the market session is open. Prices come only from the oracle's venue feed (Redis KEYS.oracleVenueFeed);
// between oracle ticks the LATEST SIGNED price is re-sent, never a new one. Nothing is pushed for a symbol the oracle
// holds (session closed: Orderly freezes the index OFF_MARKET and applies its own off-market handling), marks stale (no
// publishable price this tick) or whose price is older than maxAgeMs (held or not; never below 3 oracle ticks). Per-symbol state goes to Redis
// KEYS.builderFeedStatus; services/alerts raises builder_price_push when a symbol fails for > 30 s in session.
import { baseAssetOf, type BuilderFeedStatusMsg, type BuilderPushState, type Logger, type OracleVenueFeedMsg, type OracleVenuePrice } from "@bookrunner/shared";
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
  /** every book on it is still in Subscription: the market / feed may not be listed yet (failures are not paged) */
  preListing?: boolean;
}

export interface BuilderPriceFeedOptions {
  /** null = the push cannot run (no WebSocket domain / key): every target reports not-configured */
  socket: FeedSocket | null;
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
}

/** Book states whose builder market is (or is about to be) listed: provisioning lists every non-cancelled book. */
const FED_STATES: ReadonlySet<string> = new Set(["Subscription", "Live", "Retiring"]);

/** Push targets: tradable Orderly books (they have a builder market) in a listed state, one entry per venue symbol. */
export function builderFeedTargets(books: ReadonlyArray<Pick<TrackedBook, "bookId" | "symbol" | "state" | "venueSymbolError">>): PushTarget[] {
  const by = new Map<string, { bookIds: number[]; preListing: boolean }>();
  for (const b of books) {
    if (!tradable(b) || !FED_STATES.has(b.state)) continue;
    const cur = by.get(b.symbol) ?? { bookIds: [], preListing: true };
    cur.bookIds = [...cur.bookIds, b.bookId].sort((x, y) => x - y);
    cur.preListing &&= b.state === "Subscription";
    by.set(b.symbol, cur);
  }
  return [...by.entries()].map(([symbol, v]) => ({ symbol, bookIds: v.bookIds, preListing: v.preListing }));
}

const FAILING: ReadonlySet<BuilderPushState> = new Set(["stale", "no-price", "invalid", "disconnected", "rejected", "not-configured"]);

/** Waits at most `ms` for `p` (rejects after that; `p` keeps running but is no longer awaited). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}

export class BuilderPriceFeed {
  private readonly prices = new Map<string, OracleVenuePrice & { feedTs: number; tickMs: number | null }>();
  private readonly states = new Map<string, SymbolState>();
  /** latest reject per base_ccy ("*" = not attributable) */
  private readonly rejects = new Map<string, PublishReject>();
  private readonly now: () => number;
  private tickWarned = false;
  readonly intervalMs: number;
  readonly maxAgeMs: number;
  readonly rejectHoldMs: number;
  readonly ioTimeoutMs: number;

  constructor(private readonly o: BuilderPriceFeedOptions) {
    this.now = o.now ?? Date.now;
    this.intervalMs = o.intervalMs ?? 1_000;
    this.maxAgeMs = o.maxAgeMs ?? 10_000;
    this.rejectHoldMs = o.rejectHoldMs ?? 5_000;
    this.ioTimeoutMs = o.ioTimeoutMs ?? 500;
  }

  /**
   * An oracle venue-feed message (Redis key or channel): per symbol, the entry of the newest oracle tick wins (the key
   * re-read can return a message already seen on the channel; an older one never overrides a newer one).
   */
  onFeed(msg: OracleVenueFeedMsg): void {
    if (!msg || msg.v !== 1 || !Array.isArray(msg.prices) || typeof msg.ts !== "number") return;
    const tickMs = typeof msg.tickMs === "number" && msg.tickMs > 0 ? msg.tickMs : null;
    if (tickMs !== null && 3 * tickMs > this.maxAgeMs && !this.tickWarned) {
      this.tickWarned = true;
      this.o.log.warn({ oracleTickMs: tickMs, maxAgeMs: this.maxAgeMs, effectiveMaxAgeMs: 3 * tickMs }, "OPS_BUILDER_PRICE_MAX_AGE_MS is below 3 oracle ticks: using 3 x ORACLE_TICK_MS");
    }
    for (const p of msg.prices) {
      if (!p || typeof p.symbol !== "string" || typeof p.signedAt !== "number" || typeof p.price !== "number") continue;
      const cur = this.prices.get(p.symbol);
      if (!cur || msg.ts >= cur.feedTs) this.prices.set(p.symbol, { ...p, feedTs: msg.ts, tickMs });
    }
  }

  /** Raw JSON from Redis; malformed input is ignored. */
  onFeedJson(raw: string | null): void {
    if (!raw) return;
    try {
      this.onFeed(JSON.parse(raw) as OracleVenueFeedMsg);
    } catch {
      this.o.log.debug("builder feed: unreadable oracle venue feed ignored");
    }
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
        cur ? { symbol: t.symbol, bookIds: [...new Set([...cur.bookIds, ...t.bookIds])].sort((a, b) => a - b), preListing: !!cur.preListing && !!t.preListing } : t,
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
      let next: BuilderPushState;
      let error: string | null = null;
      if (!this.o.socket) {
        next = "not-configured";
        error = this.o.notConfigured ?? "builder oracle push not configured";
      } else if (!p) {
        next = "no-price";
        error = "no oracle price for this symbol";
      } else if (now - p.signedAt > this.maxAgeOf(p)) {
        // before `held`: the oracle re-signs held prices every tick, so an old one (held or not) means it stopped
        next = "stale";
        error = `oracle price is ${Math.round((now - p.signedAt) / 1000)} s old (max ${Math.round(this.maxAgeOf(p) / 1000)} s)${p.held ? ", last seen held" : ""}`;
      } else if (p.held) {
        next = "held";
      } else if (p.stale) {
        next = "stale";
        error = "the oracle has no publishable price in session";
      } else if (!Number.isFinite(p.price) || p.price <= 0) {
        next = "invalid";
        error = `invalid oracle price ${p.price}`;
      } else if (sentBase.has(base)) {
        next = "pushing"; // another symbol with the same base_ccy was just sent
        st.lastPushAt = now;
        st.price = p.price;
      } else if (this.o.socket.publish(base, p.price) !== null) {
        sentBase.add(base);
        st.lastPushAt = now;
        st.price = p.price;
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

  private transition(st: SymbolState, next: BuilderPushState, error: string | null, now: number): void {
    const prev = st.state;
    st.state = next;
    st.error = error;
    if (FAILING.has(next)) st.failingSince ??= now;
    else st.failingSince = null;
    if (prev === next && st.logged) return; // transitions only
    st.logged = true;
    const fields = { symbol: st.symbol, base: st.base, bookIds: st.bookIds, from: prev, to: next, preListing: st.preListing, ...(error ? { err: error } : {}) };
    if (FAILING.has(next)) this.o.log.warn(fields, st.preListing ? "builder price push not running (books in Subscription: market may not be listed yet)" : "builder price push not running");
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
