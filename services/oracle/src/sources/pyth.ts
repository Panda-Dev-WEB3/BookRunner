// Pyth Pro (Pyth Lazer) price source: one of the mainnet's three live sources (Chainlink, Pyth, one more; VERIFY C6).
//
//   POST <ORACLE_PYTH_URL>  (default https://pyth-lazer.dourolabs.app/v1/latest_price)
//   Authorization: Bearer <PYTH_API_KEY>
//   {"priceFeedIds":[1314,...],"properties":["price","exponent","marketSession","feedUpdateTimestamp",
//    "publisherCount","confidence"],"formats":[],"channel":"fixed_rate@200ms","parsed":true}
//   -> {"parsed":{"timestampUs":"...","priceFeeds":[{"priceFeedId":1314,"price":"18523456","exponent":-5,
//       "marketSession":"regular","feedUpdateTimestamp":1758690761740000,"publisherCount":9,"confidence":4200}, ...]}}
//
// One batched request per poll tick serves every ticker (the service fetches all tickers of a tick
// concurrently: they share one in-flight request for `cacheMs`). Value = mantissa x 10^exponent, USD per
// SHARE (Equity.US.<TICKER>/USD). Since 2026 `price` no longer turns null when Pyth cannot aggregate: it
// repeats the last price, so freshness comes only from the feed's own `feedUpdateTimestamp` (microseconds),
// never from the receive time or the response's `timestampUs`. No observation (null) when the feed is
// missing or the session is `closed`; an in-session print that is unusable (unknown / missing session, older than
// `maxAgeMs`, too few publishers, confidence too wide: PythQuality) throws with the reason.
// The access token is never logged and never part of an error message.
import type { PriceSource, SourceObservation } from "../domain/types";

export const PYTH_PROPERTIES = ["price", "exponent", "marketSession", "feedUpdateTimestamp", "publisherCount", "confidence"] as const;

/** Sessions in which a print is used; `closed`, null or anything unknown is no observation. */
export const PYTH_TRADING_SESSIONS: ReadonlySet<string> = new Set(["regular", "preMarket", "postMarket", "overNight"]);

/**
 * Print quality floor. A thin Pyth print would move the signed median (or the midpoint of two), so it is dropped:
 * fewer publishers than Pyth's own per-session minimum for US equities (`market_sessions.*.min_pub` of
 * /v1/symbols: regular 3, pre / post / overnight 2), or a confidence interval wider than `maxConfidenceBps` of
 * the price.
 */
export interface PythQuality {
  minPublishers: number;
  minPublishersExtended: number;
  maxConfidenceBps: number;
}
export const DEFAULT_PYTH_QUALITY: PythQuality = { minPublishers: 3, minPublishersExtended: 2, maxConfidenceBps: 50 };

export type PythChannel = "real_time" | "fixed_rate@50ms" | "fixed_rate@200ms" | "fixed_rate@1000ms";

export type PythPost = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal; redirect: "error" },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface PythOptions {
  url: string;
  apiKey: string;
  /** ticker -> Pyth Pro feed id (pyth_lazer_id) */
  feeds: Readonly<Record<string, number>>;
  channel?: PythChannel;
  /** in-session max age of an observation (default 10 s) */
  maxAgeMs?: number;
  timeoutMs?: number;
  /** one request serves every fetch within this window (default 500 ms, below the 1 s tick) */
  cacheMs?: number;
  quality?: PythQuality;
  post?: PythPost;
  now?: () => number;
}

/** One feed of `parsed.priceFeeds` (only the requested properties). */
export interface PythFeedUpdate {
  priceFeedId: number;
  price?: string | number | null;
  exponent?: number | null;
  marketSession?: string | null;
  feedUpdateTimestamp?: number | string | null;
  publisherCount?: number | null;
  confidence?: number | string | null;
}

const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);

/** mantissa x 10^exponent through the decimal string (no binary rounding of the scale step). */
export function scalePythPrice(mantissa: string | number, exponent: number): number | null {
  const m = typeof mantissa === "number" ? (Number.isSafeInteger(mantissa) ? String(mantissa) : "") : mantissa.trim();
  if (!/^-?\d+$/.test(m) || !isInt(exponent)) return null;
  const v = Number(`${m}e${exponent}`);
  return Number.isFinite(v) ? v : null;
}

export type PythParse = { obs: SourceObservation } | { closed: true } | { reason: string };

/**
 * Pure parse of one feed update: an observation, `closed` (market closed: no observation, not a failure), or why the
 * print is unusable (in session: a failure the source reports).
 */
export function pythObservation(f: PythFeedUpdate, nowMs: number, maxAgeMs: number, q: PythQuality = DEFAULT_PYTH_QUALITY): PythParse {
  if (f.marketSession === "closed") return { closed: true };
  if (typeof f.marketSession !== "string" || !PYTH_TRADING_SESSIONS.has(f.marketSession)) return { reason: `market session ${String(f.marketSession)}` };
  if (f.price === null || f.price === undefined || f.exponent === null || f.exponent === undefined) return { reason: "no price" };
  const price = scalePythPrice(f.price, f.exponent);
  if (price === null || price <= 0) return { reason: "unusable price" };
  const rawTs = typeof f.feedUpdateTimestamp === "string" ? Number(f.feedUpdateTimestamp) : f.feedUpdateTimestamp;
  if (!isInt(rawTs) || rawTs <= 0) return { reason: "no feedUpdateTimestamp" };
  const ts = Math.floor(rawTs / 1000); // microseconds -> ms
  if (nowMs - ts > maxAgeMs) return { reason: `stale (${Math.round((nowMs - ts) / 1000)}s old)` };
  const minPub = f.marketSession === "regular" ? q.minPublishers : q.minPublishersExtended;
  if (!isInt(f.publisherCount) || f.publisherCount < minPub) return { reason: `publisherCount ${f.publisherCount ?? "missing"} < ${minPub} (${f.marketSession})` };
  const conf = f.confidence === null || f.confidence === undefined ? null : scalePythPrice(f.confidence, f.exponent);
  if (conf === null || conf < 0) return { reason: "no confidence" };
  const confBps = (conf / price) * 1e4;
  if (confBps > q.maxConfidenceBps) return { reason: `confidence ${confBps.toFixed(1)} bps > ${q.maxConfidenceBps}` };
  return { obs: { price, ts, maxAgeMs } };
}

export class PythProSource implements PriceSource {
  readonly name = "pyth";
  readonly kind = "pyth" as const;
  readonly maxAgeMs: number;
  private readonly ids: number[];
  private batch: { at: number; result: Promise<Map<number, PythFeedUpdate>> } | null = null;

  constructor(private readonly o: PythOptions) {
    if (!o.apiKey) throw new Error("pyth: no access token (PYTH_API_KEY)");
    this.maxAgeMs = o.maxAgeMs ?? 10_000;
    this.ids = [...new Set(Object.values(o.feeds))].sort((a, b) => a - b);
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  async fetch(ticker: string): Promise<SourceObservation | null> {
    const id = this.o.feeds[ticker];
    if (id === undefined) return null;
    const feeds = await this.latest();
    const f = feeds.get(id);
    if (!f) return null;
    const r = pythObservation(f, this.now(), this.maxAgeMs, this.o.quality);
    if ("obs" in r) return r.obs;
    if ("closed" in r) return null;
    // an unusable print in session is a failure with a reason (source health, source-check), never a silent null
    throw new Error(`pyth ${ticker}: ${r.reason}`);
  }

  /** The current batch (shared by every ticker of one tick), or a new one. A failed batch is shared too. */
  private latest(): Promise<Map<number, PythFeedUpdate>> {
    const now = this.now();
    if (this.batch && now - this.batch.at < (this.o.cacheMs ?? 500)) return this.batch.result;
    const result = this.request();
    this.batch = { at: now, result };
    return result;
  }

  private redact(msg: string): string {
    return msg.split(this.o.apiKey).join("***");
  }

  private async request(): Promise<Map<number, PythFeedUpdate>> {
    const post = this.o.post ?? (fetch as unknown as PythPost);
    const body = JSON.stringify({
      priceFeedIds: this.ids,
      properties: PYTH_PROPERTIES,
      formats: [],
      channel: this.o.channel ?? "fixed_rate@200ms",
      parsed: true,
    });
    let res: Awaited<ReturnType<PythPost>>;
    let json: unknown;
    try {
      res = await post(this.o.url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.o.apiKey}`, "content-type": "application/json", accept: "application/json" },
        body,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 2_000),
        // never re-send the Authorization header to wherever a redirect points
        redirect: "error",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (access token rejected or not entitled to these feeds)" : ""}`);
      json = await res.json();
    } catch (e) {
      throw new Error(`pyth: ${this.redact(e instanceof Error ? e.message : String(e))}`);
    }
    const feeds = (json as { parsed?: { priceFeeds?: unknown } } | null)?.parsed?.priceFeeds;
    if (!Array.isArray(feeds)) throw new Error("pyth: response has no parsed.priceFeeds");
    const out = new Map<number, PythFeedUpdate>();
    for (const f of feeds as PythFeedUpdate[]) if (f && isInt(f.priceFeedId)) out.set(f.priceFeedId, f);
    return out;
  }
}
