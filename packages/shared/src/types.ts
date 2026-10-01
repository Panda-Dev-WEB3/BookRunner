import type { Address, Hex } from "viem";

// TS mirrors of contracts/src/interfaces/BRTypes.sol. All amounts bigint in protocol units (see units.ts).

export const VENUE = { ORDERLY: 0, POOL_ENGINE: 1 } as const;
export type VenueId = (typeof VENUE)[keyof typeof VENUE];

export const ORACLE = { CHAINLINK: 0, ATTESTED: 1 } as const;
export type OracleKindId = (typeof ORACLE)[keyof typeof ORACLE];

export const TRANCHE = { SENIOR: 0, JUNIOR: 1 } as const;
export type TrancheId = (typeof TRANCHE)[keyof typeof TRANCHE];
export type TrancheName = "senior" | "junior";
export const trancheName = (k: number): TrancheName => (k === TRANCHE.SENIOR ? "senior" : "junior");

export const ACCOUNT = { IF: 0, MM: 1 } as const;

export const REVENUE_SOURCE = {
  VENUE_TAKER_SHARE: 0,
  ENGINE_FEES: 1,
  FUNDING: 2,
  LIQUIDATION: 3,
  OTHER: 4,
} as const;

export const CHARTER_STATUS = ["None", "Filed", "Approved", "Rejected", "Expired", "Retired"] as const;
export type CharterStatus = (typeof CHARTER_STATUS)[number];

export const BOOK_STATE = ["Subscription", "Cancelled", "Live", "Retiring", "Retired"] as const;
export type BookState = (typeof BOOK_STATE)[number];

export interface Mandate {
  maxInventoryUsd: bigint;
  maxSkewBps: number;
  minQuoteWidthBps: number;
  maxHedgeLeverage: number; // 0.01x units, 100 = 1.00x
  hedgeRatioMinBps: number;
  hedgeRatioMaxBps: number;
  noNewRiskOffHours: boolean;
  killAtDrawdownBps: number; // negative
  hedgeAllowRoot: Hex;
}

export interface Charter {
  underlying: Hex;
  venue: VenueId;
  oracle: OracleKindId;
  sessions: Hex;
  ifTargetUsd: bigint;
  mmInventoryUsd: bigint;
  mandate: Mandate;
  seniorHurdleBps: number;
  seniorCapBps: number;
  subscriptionWindow: number;
  juniorNoticeSeconds: bigint;
  sponsor: Address;
  perWalletCapUsd: bigint;
  symbol: Hex;
  takerFeeBps: number;
  makerFeeBps: number;
}

export interface BookComponents {
  book: Address;
  senior: Address;
  junior: Address;
  vault: Address;
  mandate: Address;
  router: Address;
  desk: Address;
  adapter: Address;
}

export interface MarkInput {
  bookId: bigint;
  periodEnd: bigint;
  navUsd: bigint;
  deployedValueUsd: bigint;
  flowNonce: bigint;
  inventoryRoot: Hex;
  pnlJsonHash: Hex;
  receiptsRoot: Hex;
}

/** Off-chain mark statement; keccak256(canonicalJson(pnl)) == MarkInput.pnlJsonHash. */
export interface MarkPnl {
  bookId: string;
  periodEnd: number;
  navUsd: string; // decimal strings, 6dp
  deployedValueUsd: string;
  vaultIdleUsd: string;
  venue: { insuranceUsd: string; marginUsd: string; netExposureUsd: string; inTransitUsd: string; valuationAt: number };
  desk: { usdc: string; hedgeValueUsd: string; positions: Array<{ token: Address; qtyRaw: string; priceWad: string; multiplierWad: string; valueUsd: string }> };
  pnl: { realizedUsd: string; unrealizedUsd: string; feeFlowUsd: string; fundingUsd: string; markPnlUsd: string };
  tranches: { seniorNav: string; juniorNav: string; seniorPrice: string; juniorPrice: string };
  limits: { inventoryUtil: number; skewUtil: number; hedgeRatioBps: number; drawdownBps: number };
}

/** Deployment file written by contracts/script/Deploy.s.sol + LaunchBooks.s.sol. */
export interface Deployment {
  chainId: number;
  startBlock: number;
  contracts: {
    config: Address;
    timelock: Address;
    usdc: Address;
    usdg?: Address;
    bkrn: Address;
    staking: Address;
    feeRouter: Address;
    backstop: Address;
    markRegistry: Address;
    oracle: Address;
    stockRegistry: Address;
    charter: Address;
    committee: Address;
    factory: Address;
    poolEngine: Address;
    hedgeExecutor: Address;
    orderlyVault: Address; // MockOrderlyVault on devnet; VERIFY on RHC
    entryPoint?: Address;
    swapRouter?: Address; // MockSwapRouter on devnet; VERIFY on RHC
  };
  stockTokens: Record<string, { token: Address; priceId: Hex; multiplierWad: string }>;
  books: Array<{ bookId: number; name: string; symbol: string; venue: VenueId; components: BookComponents }>;
}
