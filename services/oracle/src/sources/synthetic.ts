// Devnet sources: one seeded GBM path per ticker, observed by N synthetic sources that each add
// small independent noise, occasional dropouts and rare spikes (to exercise outlier rejection).
// Without `entropy` (devnet) everything is a pure function of (seed, ticker, source index, step) ->
// reproducible runs. With it (every other chain) each path step and each observation mixes in a fresh
// CSPRNG draw, so future prints cannot be computed from the seed or anything else public.
import { GbmPath } from "../domain/gbm";
import { type NormalSource, hashString, normal, uniform } from "../domain/rng";
import type { PriceSource } from "../domain/types";

export interface SyntheticTicker {
  s0: number;
  vol: number; // annualised
}

export interface SyntheticMarketOptions {
  seed: string;
  stepMs: number;
  /** step 0 of every path is at this unix ms */
  epochMs: number;
  tickers: Record<string, SyntheticTicker>;
  /** Per-step entropy (csprngNormal off devnet): the path is then not reproducible. */
  entropy?: NormalSource;
  volScale?: number;
  noiseBps?: number;
  dropoutProb?: number;
  spikeProb?: number;
  spikeBps?: number;
}

export class SyntheticMarket {
  private readonly paths = new Map<string, GbmPath>();
  readonly noiseBps: number;
  readonly dropoutProb: number;
  readonly spikeProb: number;
  readonly spikeBps: number;

  constructor(readonly opts: SyntheticMarketOptions) {
    this.noiseBps = opts.noiseBps ?? 3;
    this.dropoutProb = opts.dropoutProb ?? 0.01;
    this.spikeProb = opts.spikeProb ?? 0.002;
    this.spikeBps = opts.spikeBps ?? 400;
    for (const [ticker, t] of Object.entries(opts.tickers)) this.addTicker(ticker, t);
  }

  addTicker(ticker: string, t: SyntheticTicker): void {
    if (this.paths.has(ticker)) return;
    this.paths.set(
      ticker,
      new GbmPath(this.opts.seed, ticker, { s0: t.s0, volAnnual: t.vol * (this.opts.volScale ?? 1), stepMs: this.opts.stepMs }, this.opts.entropy),
    );
  }

  has(ticker: string): boolean {
    return this.paths.has(ticker);
  }

  stepAt(ms: number): number {
    return Math.max(0, Math.floor((ms - this.opts.epochMs) / this.opts.stepMs));
  }

  /** The underlying (unobserved) GBM price at `ms`. */
  basePrice(ticker: string, ms: number): number | null {
    const p = this.paths.get(ticker);
    return p ? p.priceAt(this.stepAt(ms)) : null;
  }

  /** What synthetic source `index` reports for `ticker` at `ms` (null = dropout / unknown). */
  observe(ticker: string, index: number, ms: number): { price: number; ts: number } | null {
    const path = this.paths.get(ticker);
    if (!path) return null;
    const step = this.stepAt(ms);
    const key = hashString(`src:${this.opts.seed}:${ticker}:${index}`);
    if (uniform(key, step, 1) < this.dropoutProb) return null;
    const z = this.opts.entropy ? (normal(key, step, 2) + this.opts.entropy()) / Math.SQRT2 : normal(key, step, 2);
    let bps = z * this.noiseBps;
    if (uniform(key, step, 3) < this.spikeProb) bps += (uniform(key, step, 4) < 0.5 ? -1 : 1) * this.spikeBps;
    return { price: path.priceAt(step) * Math.exp(bps / 1e4), ts: this.opts.epochMs + step * this.opts.stepMs };
  }
}

export class SyntheticSource implements PriceSource {
  constructor(
    readonly name: string,
    private readonly market: SyntheticMarket,
    private readonly index: number,
    private readonly now: () => number = Date.now,
  ) {}

  async fetch(ticker: string): Promise<{ price: number; ts: number } | null> {
    return this.market.observe(ticker, this.index, this.now());
  }
}

/** The three devnet sources: synthetic-a, synthetic-b, synthetic-c. */
export function syntheticSources(market: SyntheticMarket, now: () => number = Date.now, count = 3): SyntheticSource[] {
  return Array.from({ length: count }, (_, i) => new SyntheticSource(`synthetic-${String.fromCharCode(97 + i)}`, market, i, now));
}
