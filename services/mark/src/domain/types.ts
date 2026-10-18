import type { BookState, Mandate } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import type { SignedPrice } from "./prices";

/** One Stock Token held by the desk, valued by StockTokenRegistry (multiplier applied there, once). */
export interface DeskPosition {
  token: Address;
  ticker: string;
  qtyRaw: bigint;
  priceWad: bigint; // per share of the equity (oracle)
  multiplierWad: bigint; // shares per whole token (informational; never re-applied)
  decimals: number;
  valueUsd: bigint; // registry.valueUsd(token, qtyRaw) / valueUsdAt(token, qtyRaw, priceWad)
  /** valued at an old price (older than config.maxPriceAge at the snapshot block, or the strict view reverted). */
  priceStale: boolean;
  /** priceWad comes from the oracle's signed bundle (newer than the stored on-chain price; rides in the mark tx). */
  signedPrice?: boolean;
  /** the oracle signed priceWad as held (session closed / feed held): the mark is then held (audit M-1). */
  priceHeld?: boolean;
  /** share basis of priceWad: its publishedAt when live, AttestedOracle.lastLiveAt when held (audit M-2). */
  priceBasisAt?: bigint;
  /** StockTokenRegistry.multiplierChangedAt(token) at the snapshot block (0 = never). */
  multiplierChangedAt?: bigint;
  /** in the split window: the multiplier in force at priceBasisAt (token events), null = unknown */
  basisMultiplierWad?: bigint | null;
  /** in the split window: when the first change after the basis took effect (the window's start) */
  splitWindowSince?: bigint;
  /** set by resolveSplitWindow: valued at the basis multiplier (or 0), the mark is held */
  splitWindow?: boolean;
}

/** Everything a mark needs, read at ONE block. */
export interface MarkSnapshot {
  bookId: number;
  blockNumber: bigint;
  blockTimestamp: number;
  usdc: Address;
  vaultIdle: bigint; // USDC.balanceOf(vault)
  vaultIdleView: bigint | null; // vault.idle() (cross-check)
  unfundedClaims: bigint;
  flowNonce: bigint;
  venue: {
    insuranceUsd: bigint;
    marginUsd: bigint; // signed
    netExposureUsd: bigint; // signed, + = book long
    inTransitUsd: bigint;
    deployedValueUsd: bigint; // adapter.deployedValueUsd()
    valuationAt: number;
    /** In-house engine only: pool cash + equity (open-position MTM = equity - cash). */
    poolCashUsd: bigint | null;
    poolEquityUsd: bigint | null;
    /** Orderly: adapter.lastFlowAt() at the snapshot block (0 when unknown / engine). */
    lastFlowAt?: number;
    /** Orderly: requested-but-unconfirmed withdrawals (IF + MM) at the snapshot block. */
    pendingWithdrawUsd?: bigint;
    /**
     * Where the venue figures come from: the adapter's stored report / live engine views at the stored
     * oracle price ("adapter"), ops-venue's signed report ("signed_report", domain/venue.ts) or the engine
     * views re-evaluated after applying the signed bundle price in an eth_call ("engine_signed_price").
     */
    source?: "adapter" | "signed_report" | "engine_signed_price";
  };
  desk: {
    usdc: bigint;
    positions: DeskPosition[];
    /** desk.valueUsd() / desk.hedgeNotionalUsd() (cross-checks; null if the call failed). */
    onchainValueUsd: bigint | null;
    hedgeNotionalUsd: bigint | null;
  };
  book: {
    state: BookState;
    seniorNav: bigint;
    juniorNav: bigint;
    seniorImpairment: bigint;
    /** Book.backstopDebt() debt: backstop cover not yet repaid from gains (absent on pre-upgrade books = 0). */
    backstopDebt?: bigint;
    perfIndex: bigint;
    highWater: bigint;
    seniorSupply: bigint;
    juniorSupply: bigint;
    lastMarkPeriodEnd: number;
  };
  backstopBalance: bigint;
  mandate: Mandate;
  killed: boolean;
  /**
   * The underlying's price the valuation used (the signed bundle print when newer than the stored one), null
   * when unreadable. `stale`: older than config.maxPriceAge at the valuation time (domain/held.ts: held).
   */
  underlyingPrice: { priceId: Hex; priceWad: bigint; publishedAt: number; held: boolean; stale: boolean } | null;
  /**
   * Signed oracle prices this valuation used that are newer than the chain's stored ones (desk tokens,
   * engine underlying). They form the mark tx's priceData so the chain ends up on the prices the NAV used.
   */
  signedPrices?: SignedPrice[];
}
