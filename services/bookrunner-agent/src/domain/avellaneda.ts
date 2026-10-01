// Inventory-aware Avellaneda-Stoikov (2008) quoting, computed in return space.
//
//   reservation  r = s - q * gamma * sigma^2 * tau
//   spread       delta = gamma * sigma^2 * tau + (2 / gamma) * ln(1 + gamma / k)
//
// Here sigma is the volatility of log returns per sqrt(second) and tau the horizon in seconds, so
// sigma^2 * tau is dimensionless; gamma (risk aversion) and k (order-arrival decay per unit of
// relative distance) are dimensionless too and both terms are fractions of s. This equals the
// classic price-space model with sigma_abs = s * sigma, gamma_abs = gamma / s, k_abs = k / s, which
// keeps parameters comparable across underlyings priced at 20 or 2,000 USD.
// q is the normalised inventory netExposureUsd / maxInventoryUsd (positive = book long).

export interface AsParams {
  gamma: number;
  k: number;
  horizonSec: number;
}

export const DEFAULT_AS_PARAMS: AsParams = { gamma: 50, k: 2000, horizonSec: 3600 };

export interface AsInput {
  mid: number; // reference price s (oracle)
  sigma: number; // per sqrt(second), log returns
  q: number; // normalised inventory
}

export interface AsOutput {
  reservation: number;
  spread: number; // full spread, price units
  bid: number;
  ask: number;
  /** (r - s) / s in bps (negative when long: quotes lean down to sell inventory). */
  reservationOffsetBps: number;
  /** delta / r in bps. */
  spreadBps: number;
  /** gamma * sigma^2 * tau (dimensionless). */
  riskTerm: number;
  /** (2 / gamma) ln(1 + gamma / k) (dimensionless). */
  liquidityTerm: number;
}

export function validateAsParams(p: AsParams): void {
  if (!(p.gamma > 0) || !Number.isFinite(p.gamma)) throw new Error(`A-S: gamma must be > 0 (got ${p.gamma})`);
  if (!(p.k > 0) || !Number.isFinite(p.k)) throw new Error(`A-S: k must be > 0 (got ${p.k})`);
  if (!(p.horizonSec > 0) || !Number.isFinite(p.horizonSec)) throw new Error(`A-S: horizon must be > 0 (got ${p.horizonSec})`);
}

export function avellanedaStoikov(input: AsInput, p: AsParams): AsOutput {
  validateAsParams(p);
  const s = input.mid;
  const riskTerm = p.gamma * input.sigma * input.sigma * p.horizonSec;
  const liquidityTerm = (2 / p.gamma) * Math.log1p(p.gamma / p.k);
  const reservation = s * (1 - input.q * riskTerm);
  const spread = s * (riskTerm + liquidityTerm);
  return {
    reservation,
    spread,
    bid: reservation - spread / 2,
    ask: reservation + spread / 2,
    reservationOffsetBps: s > 0 ? ((reservation - s) / s) * 10_000 : 0,
    spreadBps: reservation > 0 ? (spread / reservation) * 10_000 : Number.POSITIVE_INFINITY,
    riskTerm,
    liquidityTerm,
  };
}
