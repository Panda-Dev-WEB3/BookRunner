// Quote sizing. "Model-assisted sizing behind the same limits": any SizingModel (rule-based by
// default, a learned model later) only PROPOSES sizes; clampSizes() then enforces the hard limits
// (side gating, inventory headroom under maxInventoryUsd, minimum size) so a model can never size a
// quote past the mandate.

export interface Sides {
  bid: boolean;
  ask: boolean;
}

export interface SizingInput {
  oraclePx: number;
  /** Signed venue exposure, USD (positive = book long). */
  netExposureUsd: number;
  maxInventoryUsd: number;
  sides: Sides;
  /** Volatility of log returns per sqrt(second). */
  sigma: number;
  /** |exposure| / maxInventory. */
  util: number;
  widthBps: number;
  skewBps: number;
}

export interface SizeProposal {
  bidQty: number; // units of underlying
  askQty: number;
}

export interface SizingModel {
  readonly name: string;
  propose(input: SizingInput): SizeProposal;
}

export interface SizeLimits {
  /** Minimum notional per side; smaller sides are dropped. */
  minSizeUsd: number;
  /** Optional lot size (units); sizes are floored to it. */
  lotSize?: number;
}

/**
 * Inventory headroom (USD) per side under |exposure| <= cap:
 *   a bid fill (book buys) moves exposure up:   buy  <= cap - exposure
 *   an ask fill (book sells) moves exposure down: sell <= cap + exposure
 */
export function headroomUsd(netExposureUsd: number, capUsd: number): { buy: number; sell: number } {
  return {
    buy: Math.max(0, capUsd - netExposureUsd),
    sell: Math.max(0, capUsd + netExposureUsd),
  };
}

function floorTo(x: number, lot: number | undefined): number {
  if (!lot || lot <= 0) return x;
  return Math.floor(x / lot + 1e-9) * lot;
}

/** Hard limits applied to any model's proposal. Never returns a size that breaches headroom. */
export function clampSizes(p: SizeProposal, input: SizingInput, limits: SizeLimits): SizeProposal {
  const px = input.oraclePx;
  if (!(px > 0)) return { bidQty: 0, askQty: 0 };
  const room = headroomUsd(input.netExposureUsd, input.maxInventoryUsd);
  const sane = (q: number) => (Number.isFinite(q) && q > 0 ? q : 0);
  let bidQty = input.sides.bid ? Math.min(sane(p.bidQty), room.buy / px) : 0;
  let askQty = input.sides.ask ? Math.min(sane(p.askQty), room.sell / px) : 0;
  bidQty = floorTo(bidQty, limits.lotSize);
  askQty = floorTo(askQty, limits.lotSize);
  if (bidQty * px < limits.minSizeUsd) bidQty = 0;
  if (askQty * px < limits.minSizeUsd) askQty = 0;
  return { bidQty, askQty };
}

export interface RuleBasedSizingConfig {
  /** Base notional per side at flat inventory. */
  baseSizeUsd: number;
  /** Max share of the side's inventory headroom a single quote may use. */
  maxHeadroomFraction: number;
  /** How strongly inventory tilts sizes: growth side * (1 - f*|q|), reducing side * (1 + f*|q|). */
  inventoryTilt: number;
  /** Annualised vol above which sizes shrink proportionally (vol / ref). */
  volRefAnnual: number;
}

export const DEFAULT_RULE_SIZING: RuleBasedSizingConfig = {
  baseSizeUsd: 2_500,
  maxHeadroomFraction: 0.25,
  inventoryTilt: 0.75,
  volRefAnnual: 1.0,
};

/** Default rule-based sizing: base size tilted by inventory, shrunk in high vol, capped by headroom. */
export class RuleBasedSizing implements SizingModel {
  readonly name = "rule-based-v1";
  constructor(private readonly cfg: RuleBasedSizingConfig = DEFAULT_RULE_SIZING) {}

  propose(input: SizingInput): SizeProposal {
    const px = input.oraclePx;
    if (!(px > 0) || !(input.maxInventoryUsd > 0)) return { bidQty: 0, askQty: 0 };
    const q = Math.max(-1, Math.min(1, input.netExposureUsd / input.maxInventoryUsd));
    const annualVol = input.sigma * Math.sqrt(365 * 24 * 3600);
    const volScale = annualVol > this.cfg.volRefAnnual ? this.cfg.volRefAnnual / annualVol : 1;
    const base = this.cfg.baseSizeUsd * volScale;
    // long (q > 0): shrink bids (growth), grow asks (reducing); short: the mirror image
    const bidUsd = base * Math.max(0, 1 - this.cfg.inventoryTilt * q);
    const askUsd = base * Math.max(0, 1 + this.cfg.inventoryTilt * q);
    const room = headroomUsd(input.netExposureUsd, input.maxInventoryUsd);
    return {
      bidQty: Math.min(bidUsd, room.buy * this.cfg.maxHeadroomFraction) / px,
      askQty: Math.min(askUsd, room.sell * this.cfg.maxHeadroomFraction) / px,
    };
  }
}
