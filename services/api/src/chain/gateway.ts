// Chain read port. Only views the DB does not hold (live wallet positions, protocol params, committee
// tallies, authoritative charter validation). Implemented with viem in `viem.ts`; faked in tests.
import type { Charter, Deployment, Mandate } from "@bookrunner/shared/types";
import type { Address, Hex } from "viem";

export interface ProtocolParams {
  charterFeeUsd: bigint;
  sponsorBondBkrn: bigint;
  committeeBondBkrn: bigint;
  markInterval: number;
  maxPriceAge: number;
  newBooksPaused: boolean;
  venueMinIfUsd: [bigint, bigint]; // [Orderly, PoolEngine]
}

export interface CommitteeState {
  members: Address[];
  juryVerdict: { cid: Hex; recommendApprove: boolean; posted: boolean };
  approvals: number;
  rejections: number;
  /** Per seated member: bonded + voted on this charter. */
  memberStatus: Array<{ member: Address; bonded: boolean; voted: boolean }>;
}

export interface CharterChainRecord {
  status: number; // CharterStatus index
  filedAt: number;
  decidedAt: number;
  juryCid: Hex;
  book: Address;
}

export interface BookChainState {
  state: number; // BookState index
  subscriptionEnds: number;
  seniorPriceWad: bigint;
  juniorPriceWad: bigint;
  seniorNav: bigint;
  juniorNav: bigint;
  lastMarkId: number;
  /** Book.topUp(): the top-up round (open until it settles at a mark); null when the read failed. */
  topUp?: { open: boolean; endsAt: number } | null;
}

export interface TrancheWalletState {
  shares: bigint;
  totalSupply: bigint;
  committed: bigint; // current round
  totalCommitted: bigint;
  depositsOpen: boolean;
  paused: boolean;
  claimableShares: bigint;
  claimableRefund: bigint;
  claimableAssets: bigint; // settled redemptions
  navValue: bigint; // convertToAssets(shares)
  buckets: Array<{ requestId: bigint; pendingShares: bigint; claimableShares: bigint }>;
}

export interface MandateChainState {
  mandate: Mandate;
  killed: boolean;
  killReason: Hex;
  activeKeys: Address[];
}

export interface ChainGateway {
  readonly chainId: number;
  readonly deployment: Deployment;
  params(): Promise<ProtocolParams>;
  /** MarketCharter.validate(c): bytes32 reason (zero hash when valid). */
  validateCharter(c: Charter): Promise<Hex>;
  /** registry.isCanonical(token) for token underlyings, registry.isIndex(id) for indices. */
  underlyingKnown(underlying: Hex): Promise<boolean>;
  charterRecord(charterId: number): Promise<CharterChainRecord | null>;
  committeeState(charterId: number): Promise<CommitteeState>;
  stakeAvailable(account: Address): Promise<bigint>;
  agentTierBond(inventoryUsd: bigint): Promise<bigint>;
  usdcState(wallet: Address, spender: Address): Promise<{ balance: bigint; allowance: bigint }>;
  bookState(book: Address): Promise<BookChainState>;
  trancheWallet(tranche: Address, wallet: Address, requestIds: bigint[]): Promise<TrancheWalletState>;
  /**
   * USDC a redemption claim can draw on now (uncached): Tranche.redemptionLiquidity() plus the
   * vault's idle USDC that Book.fundClaims() can move in. Tranche._claim reverts
   * InsufficientLiquidity above it, while the book's cash is still deployed on the venue.
   */
  claimLiquidity(tranche: Address, vault: Address): Promise<bigint>;
  mandateState(mandate: Address): Promise<MandateChainState>;
  /** MMMandate.operatorConsent(operator, key) (uncached: the operator may have just consented). */
  operatorConsent(mandate: Address, operator: Address, key: Address): Promise<boolean>;
}

/** Provides the gateway when the deployment file is present; null while it is missing. */
export type ChainProvider = () => ChainGateway | null;
