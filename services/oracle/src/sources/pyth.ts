// Pyth Pro (Pyth Lazer) price source: the mainnet's second live source next to Chainlink (VERIFY C6).
//
//   POST <ORACLE_PYTH_URL>  (default https://pyth-lazer.dourolabs.app/v1/latest_price)
//   Authorization: Bearer <PYTH_API_KEY>
//   {"priceFeedIds":[1314,...],"properties":["price","exponent","marketSession","feedUpdateTimestamp"],
//    "formats":[],"channel":"fixed_rate@200ms","parsed":true}
//   -> {"parsed":{"timestampUs":"...","priceFeeds":[{"priceFeedId":1314,"price":"18523456","exponent":-5,
//       "marketSession":"regular","feedUpdateTimestamp":1758690761740000}, ...]}}
//
// One batched request per poll tick serves every ticker (the service fetches all tickers of a tick
// concurrently: they share one in-flight request for `cacheMs`). Value = mantissa x 10^exponent, USD per
// SHARE (Equity.US.<TICKER>/USD). Since 2026 `price` no longer turns null when Pyth cannot aggregate: it
// repeats the last price, so freshness comes only from the feed's own `feedUpdateTimestamp` (microseconds),
// never from the receive time or the response's `timestampUs`. No observation (null) when the feed is
// missing, the session is `closed`, a field is unusable, or the price is older than `maxAgeMs`.
// The access token is never logged and never part of an error message.
import type { PriceSource, SourceObservation } from "../domain/types";

export const PYTH_PROPERTIES = ["price", "exponent", "marketSession", "feedUpdateTimestamp"] as const;

export type PythChannel = "real_time" | "fixed_rate@50ms" | "fixed_rate@200ms" | "fixed_rate@1000ms";

export type PythPost = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
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
}

const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);

/** mantissa x 10^exponent through the decimal string (no binary rounding of the scale step). */
export function scalePythPrice(mantissa: string | number, exponent: number): number | null {
  const m = typeof mantissa === "number" ? (Number.isSafeInteger(mantissa) ? String(mantissa) : "") : mantissa.trim();
  if (!/^-?\d+$/.test(m) || !isInt(exponent)) return null;
  const v = Number(`${m}e${exponent}`);
  return Number.isFinite(v) ? v : null;
}

/** Pure parse of one feed update -> observation (null = no usable fresh price). */
export function pythObservation(f: PythFeedUpdate, nowMs: number, maxAgeMs: number): SourceObservation | null {
  if (f.marketSession === "closed") return null;
  if (f.price === null || f.price === undefined || f.exponent === null || f.exponent === undefined) return null;
  const price = scalePythPrice(f.price, f.exponent);
  if (price === null || price <= 0) return null;
  const rawTs = typeof f.feedUpdateTimestamp === "string" ? Number(f.feedUpdateTimestamp) : f.feedUpdateTimestamp;
  if (!isInt(rawTs) || rawTs <= 0) return null;
  const ts = Math.floor(rawTs / 1000); // microseconds -> ms
  if (nowMs - ts > maxAgeMs) return null;
  return { price, ts, maxAgeMs };
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
    return f ? pythObservation(f, this.now(), this.maxAgeMs) : null;
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
