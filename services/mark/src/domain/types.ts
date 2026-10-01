import type { BookState, Mandate } from "@bookrunner/shared";
import type { Address, Hex } from "viem";

/** One Stock Token held by the desk, valued by StockTokenRegistry (multiplier applied there, once). */
export interface DeskPosition {
  token: Address;
  ticker: string;
  qtyRaw: bigint;
  priceWad: bigint; // per share of the equity (oracle)
  multiplierWad: bigint; // shares per whole token (informational; never re-applied)
  decimals: number;
  valueUsd: bigint; // registry.valueUsd(token, qtyRaw)
  /** registry.valueUsd reverted (stale price): valued with valueUsdAt at the last attested price. */
  priceStale: boolean;
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
    perfIndex: bigint;
    highWater: bigint;
    seniorSupply: bigint;
    juniorSupply: bigint;
    lastMarkPeriodEnd: number;
  };
  backstopBalance: bigint;
  mandate: Mandate;
  killed: boolean;
  underlyingPrice: { priceId: Hex; priceWad: bigint; publishedAt: number; held: boolean } | null;
}
