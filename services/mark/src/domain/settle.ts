// Governance settle price (pure; Task 7, audit 2026-10 lead "no settle path for a delisted / permanently held
// market"). AttestedOracle.settlePrice(priceId): the timelock proposes a final price for a market whose oracle price is
// held or stale (within 50% of the stored price), in force 3 days later (SETTLE_PRICE_DELAY), void once a live print
// published at or after the proposal is stored. In force, the engine prices the market at it (as held: no trading,
// anyone closes positions at it) and the mark service values the price id at it as a LIVE price: the mark is not
// held, so Book settles redemptions at the governance valuation. While it is pending or in force, Book keeps deferring
// HELD marks past the 30-day bound (BookLogic._governanceSettlePrice, pending or in force, capped at 60 days of hold).
//
// A read failure is never "no settle price": adapters/settleRead.ts retries and then refuses the mark attempt
// (RetryableMarkError), so no held mark is signed from a failed read (review I-2).
//
// The valuation would otherwise use the newer signed print when there is one (domain/prices.ts): a LIVE print
// published at or after the proposal voids the settle price as soon as it lands, so it wins here too; a held print
// does not (the market is still not trading).

import { priceBasisAt } from "@bookrunner/shared";
import type { Hex } from "viem";
import { priceIsStale } from "./held";
import type { SignedPrice } from "./prices";

/** AttestedOracle.settlePrice(priceId) at the snapshot block (null: the oracle has no settle path). */
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

/** The underlying's valuation price (MarkSnapshot.underlyingPrice shape). */
export interface UnderlyingPrice {
  priceId: Hex;
  priceWad: bigint;
  publishedAt: number;
  held: boolean;
  stale: boolean;
  settled?: boolean;
}

/**
 * The underlying's price after the settle rule: the settle price in force (not voided by `signed`, the newer signed
 * print the valuation uses, if any) replaces it as a live, fresh, final price at `refTs`; otherwise unchanged.
 */
export function underlyingAtSettle(u: UnderlyingPrice | null, priceId: Hex | null, settle: SettleState | null, signed: { held: boolean; publishedAt: bigint } | null, refTs: bigint): UnderlyingPrice | null {
  const sp = priceId ? settlePriceInForce(settle, signed) : null;
  if (sp === null || !priceId) return u;
  return { priceId, priceWad: sp, publishedAt: Number(refTs), held: false, stale: false, settled: true };
}

/** A desk token's valuation price: the stored on-chain one, the newer signed print, or the settle price in force. */
export interface DeskPriceChoice {
  priceWad: bigint;
  publishedAt: bigint;
  held: boolean;
  stale: boolean;
  /** share basis (audit M-2): the proposal for a settle price, else priceBasisAt */
  basis: bigint;
  /** the signed print the valuation used (rides in the mark tx), null when the stored price or a settle price is used */
  signed: SignedPrice | null;
  settled: boolean;
}

export function deskPriceChoice(i: {
  stored: { priceWad: bigint; publishedAt: bigint; held: boolean };
  lastLiveAt: bigint;
  signed: SignedPrice | null;
  settle: SettleState | null;
  refTs: bigint;
  maxPriceAgeSec: bigint;
}): DeskPriceChoice {
  const sp = settlePriceInForce(i.settle, i.signed);
  if (sp !== null && i.settle) return { priceWad: sp, publishedAt: i.refTs, held: false, stale: false, basis: i.settle.proposedAt, signed: null, settled: true };
  const s = i.signed;
  const priceWad = s ? s.priceWad : i.stored.priceWad;
  const publishedAt = s ? s.publishedAt : i.stored.publishedAt;
  const held = s ? s.held : i.stored.held;
  return { priceWad, publishedAt, held, stale: priceIsStale(publishedAt, i.refTs, i.maxPriceAgeSec), basis: priceBasisAt({ held, publishedAt, lastLiveAt: i.lastLiveAt }), signed: s, settled: false };
}
