// Governance settle price (pure; Task 7, audit 2026-10 lead "no settle path for a delisted / permanently held
// market"). AttestedOracle.settlePrice(priceId): the timelock proposes a final price for a market whose oracle price is
// held or stale (within 50% of the stored price), in force 3 days later (SETTLE_PRICE_DELAY), void once a live print
// published at or after the proposal is stored. In force, the engine prices the market at it (as held: no trading,
// anyone closes positions at it) and the mark service values the price id at it as a LIVE price: the mark is not
// held, so Book settles redemptions at the governance valuation. While it is only pending, Book keeps deferring held
// marks past the 30-day bound (BookLogic._governanceSettlePending, capped at 60 days of hold).
//
// The valuation would otherwise use the newer signed print when there is one (domain/prices.ts): a LIVE print
// published at or after the proposal voids the settle price as soon as it lands, so it wins here too; a held print
// does not (the market is still not trading).

/** AttestedOracle.settlePrice(priceId) at the snapshot block (null: none readable, e.g. an oracle without it). */
export interface SettleState {
  priceWad: bigint;
  proposedAt: bigint;
  effectiveAt: bigint;
  pending: boolean;
  effective: boolean;
}

/** The settle price to value a price id at, or null (not in force, or voided by the newer signed live print). */
export function settlePriceInForce(s: SettleState | null, signed: { held: boolean; publishedAt: bigint } | null): bigint | null {
  if (!s || !s.effective || s.priceWad === 0n) return null;
  if (signed && !signed.held && signed.publishedAt >= s.proposedAt) return null;
  return s.priceWad;
}
