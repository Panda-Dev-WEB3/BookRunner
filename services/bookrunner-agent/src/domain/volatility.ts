// Time-aware EWMA volatility of oracle log returns.
//
// Each new price observation contributes a per-second variance sample r^2 / dt (r = ln(p / p_prev)).
// Samples are blended with weight alpha = 1 - 2^(-dt / halfLife), so irregular update intervals are
// handled consistently. Held (off-hours) prices and gaps longer than `maxGapSec` do not produce
// samples: a frozen feed is not "zero volatility" and an overnight jump is not intraday volatility.

export const SECONDS_PER_YEAR = 365 * 24 * 3600;

export interface EwmaVolConfig {
  halfLifeSec: number;
  /** Prior used before enough samples exist (annualised, e.g. 0.6 = 60%). */
  priorAnnualVol: number;
  minAnnualVol: number;
  maxAnnualVol: number;
  /** Gaps longer than this reset the reference price without producing a sample. */
  maxGapSec: number;
  /** Number of samples after which the estimate fully replaces the prior. */
  minSamples: number;
}

export const DEFAULT_VOL_CONFIG: EwmaVolConfig = {
  halfLifeSec: 600,
  priorAnnualVol: 0.6,
  minAnnualVol: 0.05,
  maxAnnualVol: 5,
  maxGapSec: 600,
  minSamples: 20,
};

export const annualToPerSecond = (annual: number): number => annual / Math.sqrt(SECONDS_PER_YEAR);
export const perSecondToAnnual = (perSec: number): number => perSec * Math.sqrt(SECONDS_PER_YEAR);

/** One EWMA step on per-second variance. Returns the previous variance when the sample is invalid. */
export function ewmaStep(prevVarPerSec: number, logReturn: number, dtSec: number, halfLifeSec: number): number {
  if (!(dtSec > 0) || !Number.isFinite(logReturn) || !(halfLifeSec > 0)) return prevVarPerSec;
  const sample = (logReturn * logReturn) / dtSec;
  const alpha = 1 - Math.pow(2, -dtSec / halfLifeSec);
  return prevVarPerSec + alpha * (sample - prevVarPerSec);
}

export class EwmaVolatility {
  private varPerSec: number;
  private lastPx: number | null = null;
  private lastTs: number | null = null;
  private n = 0;

  constructor(private readonly cfg: EwmaVolConfig = DEFAULT_VOL_CONFIG) {
    const prior = annualToPerSecond(cfg.priorAnnualVol);
    this.varPerSec = prior * prior;
  }

  get samples(): number {
    return this.n;
  }

  /** Feed one oracle observation (price in USD, publishedAt in unix seconds). */
  update(px: number, tsSec: number, held = false): void {
    if (!(px > 0) || !Number.isFinite(px) || !Number.isFinite(tsSec)) return;
    if (held) {
      // frozen feed: keep the reference so the first live print after re-open is measured from
      // the held price only if the gap is short; otherwise the gap rule below resets.
      this.lastPx = px;
      this.lastTs = tsSec;
      return;
    }
    if (this.lastPx === null || this.lastTs === null) {
      this.lastPx = px;
      this.lastTs = tsSec;
      return;
    }
    const dt = tsSec - this.lastTs;
    if (dt <= 0) return; // duplicate / out of order
    if (dt > this.cfg.maxGapSec) {
      this.lastPx = px;
      this.lastTs = tsSec;
      return;
    }
    this.varPerSec = ewmaStep(this.varPerSec, Math.log(px / this.lastPx), dt, this.cfg.halfLifeSec);
    this.lastPx = px;
    this.lastTs = tsSec;
    this.n++;
  }

  /** Volatility of log returns per sqrt(second), prior-blended and clamped. */
  sigmaPerSqrtSec(): number {
    const prior = annualToPerSecond(this.cfg.priorAnnualVol);
    const w = this.cfg.minSamples > 0 ? Math.min(1, this.n / this.cfg.minSamples) : 1;
    const v = w * this.varPerSec + (1 - w) * prior * prior;
    const sigma = Math.sqrt(Math.max(v, 0));
    const lo = annualToPerSecond(this.cfg.minAnnualVol);
    const hi = annualToPerSecond(this.cfg.maxAnnualVol);
    return Math.min(hi, Math.max(lo, Number.isFinite(sigma) ? sigma : prior));
  }

  annualized(): number {
    return perSecondToAnnual(this.sigmaPerSqrtSec());
  }
}
