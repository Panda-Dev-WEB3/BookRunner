// Seeded geometric Brownian motion: S_{n+1} = S_n * exp((mu - sigma^2/2) dt + sigma sqrt(dt) Z_n),
// Z_n = normal(hash(seed:ticker), n). Deterministic given (seed, ticker, params).
import { hashString, normal } from "./rng";

export const SECONDS_PER_YEAR = 365 * 24 * 3600;

export interface GbmParams {
  s0: number;
  /** annualised volatility, e.g. 0.45 */
  volAnnual: number;
  /** annualised drift (default 0) */
  driftAnnual?: number;
  /** step length in ms */
  stepMs: number;
}

export class GbmPath {
  private readonly key: number;
  private readonly driftPerStep: number;
  private readonly volPerStep: number;
  private readonly logS0: number;
  private step = 0;
  private logS: number;

  constructor(
    readonly seed: string,
    readonly ticker: string,
    readonly params: GbmParams,
  ) {
    if (!(params.s0 > 0)) throw new Error(`gbm ${ticker}: s0 must be > 0`);
    if (!(params.volAnnual >= 0)) throw new Error(`gbm ${ticker}: vol must be >= 0`);
    if (!(params.stepMs > 0)) throw new Error(`gbm ${ticker}: stepMs must be > 0`);
    const dt = params.stepMs / 1000 / SECONDS_PER_YEAR;
    const mu = params.driftAnnual ?? 0;
    this.key = hashString(`gbm:${seed}:${ticker}`);
    this.driftPerStep = (mu - (params.volAnnual * params.volAnnual) / 2) * dt;
    this.volPerStep = params.volAnnual * Math.sqrt(dt);
    this.logS0 = Math.log(params.s0);
    this.logS = this.logS0;
  }

  /** Price at step n (n = 0 -> s0). Forward access is incremental; going back recomputes from 0. */
  priceAt(n: number): number {
    if (!Number.isInteger(n) || n < 0) throw new Error(`gbm ${this.ticker}: bad step ${n}`);
    if (n < this.step) {
      this.step = 0;
      this.logS = this.logS0;
    }
    while (this.step < n) {
      this.logS += this.driftPerStep + this.volPerStep * normal(this.key, this.step);
      this.step++;
    }
    return n === 0 ? this.params.s0 : Math.exp(this.logS);
  }

  /** Convenience: the first `count` prices (steps 0..count-1). */
  series(count: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(this.priceAt(i));
    return out;
  }
}
