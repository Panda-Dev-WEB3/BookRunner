// Optional HTTP price sources (disabled by default). VERIFY each provider's endpoint, symbols,
// timestamps, rate limits and licensing before enabling outside devnet. They must quote USD per SHARE of
// the equity (the oracle's unit; Robinhood per-token prices are converted in sources/chainlink.ts only).
//   - GenericHttpSource: ORACLE_HTTP_SOURCES='[{"name":"x","url":"https://.../{ticker}","pricePath":"data.price","tsPath":"data.ts","tsUnit":"ms"}]'
//   - Finnhub preset:    ORACLE_HTTP_FINNHUB=1 + ORACLE_FINNHUB_API_KEY (GET /api/v1/quote -> {c, t}) — VERIFY
import type { HttpSourceSpec } from "../config";
import type { PriceSource } from "../domain/types";

export type HttpGet = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Reads "a.b.0.c" from a JSON value. */
export function getPath(v: unknown, path: string): unknown {
  let cur: unknown = v;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[key];
    else return undefined;
  }
  return cur;
}

const toNumber = (x: unknown): number | null => {
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

export class GenericHttpSource implements PriceSource {
  readonly name: string;
  readonly kind = "http" as const;
  readonly maxAgeMs?: number;

  constructor(
    private readonly spec: HttpSourceSpec,
    private readonly timeoutMs = 2_000,
    private readonly get: HttpGet = fetch as unknown as HttpGet,
    private readonly now: () => number = Date.now,
  ) {
    this.name = spec.name;
    if (spec.maxAgeMs !== undefined) this.maxAgeMs = spec.maxAgeMs;
  }

  async fetch(ticker: string): Promise<{ price: number; ts: number } | null> {
    const symbol = this.spec.symbols[ticker] ?? ticker;
    const url = this.spec.url.replaceAll("{ticker}", encodeURIComponent(symbol));
    const res = await this.get(url, { headers: { accept: "application/json", ...this.spec.headers }, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`${this.name} ${symbol}: HTTP ${res.status}`);
    const body = await res.json();
    const price = toNumber(getPath(body, this.spec.pricePath));
    if (price === null || price <= 0) return null;
    let ts = this.now();
    if (this.spec.tsPath) {
      const raw = toNumber(getPath(body, this.spec.tsPath));
      if (raw === null || raw <= 0) return null;
      ts = this.spec.tsUnit === "ms" ? raw : raw * 1000;
    }
    return { price, ts };
  }
}

/** Finnhub quote endpoint (VERIFY): GET https://finnhub.io/api/v1/quote?symbol=NVDA, header X-Finnhub-Token. */
export function finnhubSpec(apiKey: string): HttpSourceSpec {
  return {
    name: "finnhub",
    url: "https://finnhub.io/api/v1/quote?symbol={ticker}",
    pricePath: "c",
    tsPath: "t",
    tsUnit: "s",
    headers: { "X-Finnhub-Token": apiKey },
    symbols: {},
    maxAgeMs: 120_000,
  };
}
