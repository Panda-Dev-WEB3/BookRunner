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

/** InsurancePool (2026-10, ARCHITECTURE §2.10) protocol-wide state. Amounts USDC 6dp, shares raw (12 dp). */
export interface PoolChainState {
  address: Address;
  /** latest block timestamp (unix s) the state was read at */
  nowSec: number;
  poolAssets: bigint;
  depositorAssets: bigint;
  totalSupply: bigint;
  /** convertToAssets(1e12): USDC per whole share */
  sharePrice: bigint;
  firstLoss: bigint;
  firstLossBps: number;
  freeLiquidity: bigint;
  claims: bigint;
  utilisationBps: number;
  premiumsTotal: bigint;
  lossesTotal: bigint;
  depositsPending: bigint;
  params: {
    premiumFloorBps: number;
    marketCapBps: number;
    bufferBps: number;
    firstLossTargetBps: number;
    cooldown: number;
    epochLength: number;
    processGrace: number;
    pendingEpochLength: number;
  };
  paused: { deposits: boolean; allocations: boolean };
  queue: { procEpoch: number; procEndsAt: number; fillEpoch: number; pendingShares: bigint; reserved: bigint };
  /** the oldest unprocessed epoch's queued deposits / escrowed withdrawal shares */
  openEpoch: { depositAssets: bigint; withdrawShares: bigint };
  /** active books not marked since the oldest unprocessed epoch's end */
  staleBooks: number;
  activeBooks: number[];
}

/** One wallet in the pool; `epochs` / `claimable` / `deposits` for the ids asked for. */
export interface PoolWalletState {
  shares: bigint;
  /** convertToAssets(shares) */
  value: bigint;
  /** unix s: end of the last deposit epoch + cooldown (shares locked before; withdraw requests queue after it) */
  cooldownEnds: number;
  usdcBalance: bigint;
  usdcAllowance: bigint;
  /** requestId -> assets claimable now */
  claimable: Map<number, bigint>;
  /** depositId -> on-chain request */
  deposits: Map<number, { owner: Address; epoch: number; done: boolean; assets: bigint }>;
  /** epoch -> on-chain epoch */
  epochs: Map<number, { shares: bigint; filledShares: bigint; assets: bigint; depositAssets: bigint; depositShares: bigint; endsAt: number; processed: boolean }>;
}

/** PoolEngine market of an in-house book (2026-10 trading page). Sizes 1e18, prices WAD, USD 6dp. */
export interface EngineMarketChainState {
  engine: Address;
  adapter: Address;
  marketId: number;
  /** block timestamp (unix s) the state was read at */
  nowSec: number;
  config: {
    underlying: Hex;
    symbol: Hex;
    takerFeeBps: number;
    makerFeeBps: number;
    initialMarginBps: number;
    maintenanceMarginBps: number;
    liquidationFeeBps: number;
    fundingVelocityBps: number;
    /** the live quote cap on |pool net exposure| (setQuote, clamped to the inventory cap) */
    maxNetExposureUsd: bigint;
  };
  state: { spreadBps: number; skewBps: number; reduceOnly: boolean; longSize: bigint; shortSize: bigint; poolCashUsd: bigint; insuranceUsd: bigint; fundingIndex: bigint };
  /** per-side open-interest cap (mandate maxInventoryUsd) */
  inventoryCapUsd: bigint;
  /** wind-down close-out time (0: none) */
  closeOutAfter: number;
  /** signed WAD fraction of notional per day (positive: longs pay) */
  fundingRatePerDayWad: bigint;
  /** audit M-3 loss budget spent this period: new risk reverts LossBudgetExceeded */
  lossBudgetBlocked: boolean;
  /** AttestedOracle.latest(underlying): the STORED price (old by design on a quiet pull-oracle market); null when never priced */
  stored: { priceWad: bigint; publishedAt: number; held: boolean } | null;
  maxPriceAge: number;
  maxTradePriceAge: number;
}

export interface EngineTraderChainState {
  position: { size: bigint; entryPriceWad: bigint; marginUsd: bigint; fundingIndexAtEntry: bigint };
  usdcBalance: bigint;
  /** settlement-token allowance to the engine */
  usdcAllowance: bigint;
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
  /** InsurancePool state (short-TTL cached); null when the deployment has no pool. */
  poolState(): Promise<PoolChainState | null>;
  /** A wallet's pool position (uncached: read right after the wallet's own transactions). */
  poolWallet(wallet: Address, q: { requestIds: number[]; depositIds: number[]; epochs: number[] }): Promise<PoolWalletState | null>;
  /** The PoolEngine market an engine book adapter owns (short-TTL cached); null when the adapter has none. */
  engineMarket(adapter: Address): Promise<EngineMarketChainState | null>;
  /** A wallet in a market (uncached: read right after the wallet's own transactions). */
  engineTrader(marketId: number, wallet: Address): Promise<EngineTraderChainState>;
  /** StockTokenRegistry.splitGate(priceId, basisAt) (audit N-1); no registry: no gate. */
  splitGate(priceId: Hex, basisAt: number): Promise<{ pending: boolean; window: boolean }>;
}

/** Provides the gateway when the deployment file is present; null while it is missing. */
export type ChainProvider = () => ChainGateway | null;
