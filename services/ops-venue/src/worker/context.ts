import type { BookState, ListingMode, Logger, VenueAccount, VenueSymbolIssuesMsg } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import type { ChainPort, OrderlyBook } from "../chain";
import type { FeeSettlement, OrderlyBuilderClient } from "../client";
import type { IfBinding, IfMode } from "../domain/ifAccount";
import type { KeyStore } from "../keys";
import type { Ed25519Key } from "../orderly/auth";
import type { SignedVenueReportJson, VenueReportValues } from "../report712";
import type { OpsStore, SagaStore } from "../store";
import type { KeyedMutex } from "../util";
import type { ListingInfo, ListingSchedule } from "./listing";
import type { NativeFeeSettings } from "./native";

/** Builder/ops venue operations the workers use (OrderlyBuilderClient satisfies it; tests fake it). */
export type BuilderPort = Pick<
  OrderlyBuilderClient,
  "createSymbol" | "listingStatus" | "setSymbolStatus" | "insuranceFund" | "addKey" | "getOrderlyKey" | "removeKeyWith" | "keyInfo" | "revokeTradeKey" | "requestWithdraw" | "withdrawal" | "withdrawals" | "mockCompleteWithdraw" | "mockRegisterAccount" | "registerDelegateSigner"
> & { feeSettlements(sinceMs: number): Promise<FeeSettlement[]> };

/** Venue account read for (accountId, symbol) authenticated with `key` (ops key). */
export type AccountReader = (accountId: string, symbol: string, key: Ed25519Key | null) => Promise<VenueAccount>;
/** Best-effort cancel-all with a specific key (used before revoking a trade key). */
export type CancelAll = (accountId: string, symbol: string, key: Ed25519Key | null) => Promise<void>;

/** signed: EIP-712 reports published off-chain (relayed by the mark keeper); onchain: OrderlyAdapter.report txs. */
export type ReportMode = "signed" | "onchain";

export interface OpsSettings {
  mode: "mock" | "live";
  brokerId: string;
  builderAccountId: string;
  tradeKeyTtlMs: number;
  opsKeyTtlMs: number;
  feeGraceSec: number;
  feeAuto: boolean;
  /** G6: the builder account is the broker admin wallet's (live mode): its fee withdrawal cannot be signed here (no fee sweep) */
  builderAdminOwned?: boolean;
  withdrawMaxAttempts: number;
  priceSource: "builder" | "chainlink";
  logMaxRange: bigint;
  reportMaxDropBps: number;
  reportDropConfirmations: number;
  /** Hold reports this long (chain seconds) after any on-chain venue flow (deposit / confirm / fail) so the venue reflects it. */
  reportSettleSec: number;
  /** OPS_REPORT_MODE (service default: signed). */
  reportMode: ReportMode;
  /** live builder price push enabled (published in VenueSymbolIssuesMsg: alerts expect its status) */
  builderPush?: boolean;
  /**
   * ORDERLY_LISTING_MODE (default api). manual: the admin lists each market in Orderly One; provisioning never calls
   * createSymbol / setSymbolStatus and waits for the market on /v1/public/info (worker/listing.ts, VERIFY O20).
   */
  listingMode?: ListingMode;
  /** listing check schedule (OPS_LISTING_RECHECK_MS / _MAX_MS, OPS_LISTING_CHECK_TIMEOUT_MS / _CONCURRENCY) */
  listingRecheck?: Partial<ListingSchedule>;
  /** manual listing mode: how long an IF withdrawal may wait for the admin's delisting before errors count (OPS_DELIST_WAIT_MAX_MS) */
  delistWaitMaxMs?: number;
  /**
   * ORDERLY_IF_MODE (default contract) and, in builder mode, ORDERLY_IF_BUILDER_ACCOUNTS (bookId -> expected IF account
   * id). Where the IF account id comes from in each mode: domain/ifAccount.ts.
   */
  ifMode?: IfMode;
  ifBuilderAccounts?: ReadonlyMap<number, string>;
  /** Orderly's per-market IF requirement, USD 6dp (strictly above; null = none checked, e.g. mock-orderly) */
  ifRequirementUsd?: bigint | null;
  /** builder IF mode: re-check period of an IF withdrawal waiting for the operator (OPS_IF_OPERATOR_RECHECK_MS) */
  ifOperatorRecheckMs?: number;
  /** builder IF mode: an operator payout not returned this long after Orderly paid it is written off from NAV (OPS_IF_RETURN_WRITE_OFF_MS) */
  ifReturnWriteOffMs?: number;
  /** builder IF mode: an IF withdrawal no saga adopted is reported once older than this (OPS_IF_UNADOPTED_GRACE_MS) */
  ifUnadoptedGraceMs?: number;
  /** builder IF mode: reviewed Orderly withdrawal ids that are not reported as unadopted (OPS_IF_WITHDRAW_ACK) */
  ifWithdrawAck?: ReadonlySet<string>;
  /** builder IF mode: venue IF equity this far (USD 6dp) below the adapter's insurance is an unexplained drop (OPS_IF_DROP_TOLERANCE_USD) */
  ifDropToleranceUsd?: bigint;
  /** builder IF mode: a drop stays published this long after it was last seen (OPS_IF_DROP_ALERT_MS) */
  ifDropAlertMs?: number;
  /** every book: the IF binding is re-read at least this often (OPS_IF_BINDING_RECHECK_MS) */
  ifBindingRecheckMs?: number;
  /** after an IF account switch on a listed market: how long the "re-assign the IF account in Orderly One" notice stays (OPS_IF_REASSIGN_NOTICE_MS) */
  ifReassignNoticeMs?: number;
  /** Orderly native deposit-fee keeper (worker/native.ts); default: warn only. */
  native?: NativeFeeSettings;
}

/** OPS_VENUE key signing VenueReport typed data (domain verifyingContract = the book's adapter). */
export interface ReportSigner {
  readonly address: Address;
  readonly chainId: number;
  sign(adapter: Address, r: VenueReportValues): Promise<Hex>;
}

/** Where signed reports go (Redis `bkrn:venue:report:<bookId>` in production, see worker/reportSink.ts). */
export interface ReportPublisher {
  publish(r: SignedVenueReportJson): Promise<void>;
}

/** Service status for alerts (Redis KEYS.venueSymbolIssues in production): books that are tracked but not tradable. */
export interface StatusPublisher {
  venueSymbolIssues(msg: VenueSymbolIssuesMsg): Promise<void>;
}

export interface OpsContext {
  settings: OpsSettings;
  chain: ChainPort;
  store: OpsStore;
  sagas: SagaStore;
  keys: KeyStore;
  builder: BuilderPort;
  readAccount: AccountReader;
  cancelAll: CancelAll;
  locks: KeyedMutex;
  log: Logger;
  now: () => number;
  reportSigner: ReportSigner;
  reportPublisher: ReportPublisher;
  /** optional (tests): where venue-symbol issues are published */
  status?: StatusPublisher;
}

export interface TrackedBook extends OrderlyBook {
  /**
   * Venue symbol: what every Orderly call and match uses (orders, positions, trades, listing, IF, fee rows).
   * `venueSymbol` of the charter symbol: PERP_NVDA_USDC_<broker> with ORDERLY_MODE=live, the charter symbol in mock mode.
   * When `venueSymbolError` is set it is the charter symbol, a label only: nothing is listed or traded under it.
   */
  symbol: string;
  /**
   * ORDERLY_MODE=live and the charter symbol has no Orderly market (shared resolveVenueSymbol). The book is NOT
   * listed and NOT traded (no trade key registered, no listing / REDUCE_ONLY / DELISTED, no cancel-all, no fee
   * sweeps); every non-trading duty still runs: reports, withdrawal and retirement sagas, key revocation, IF / MM
   * account reads. Published to KEYS.venueSymbolIssues for alerts.
   */
  venueSymbolError: string | null;
  state: BookState;
  accounts: { if: Hex; mm: Hex };
  /** Owner (deposit receiver / delegateContract / payout address) of each Orderly account (chain.accountOwners). */
  owners: { if: Address; mm: Address };
  /**
   * The adapter's on-chain IF binding (domain/ifAccount.ts): devnet (pre-v3), contract (OrderlyIFAccount) or builder
   * (operator EOA, adapter.setIfAccountOwner). Absent = contract / devnet as `owners` says (older fixtures).
   */
  ifBinding?: IfBinding;
  /**
   * The binding does not match ORDERLY_IF_MODE / ORDERLY_IF_BUILDER_ACCOUNTS: no IF provisioning for this book (published
   * for alerts, re-read every book poll until fixed). null / absent = consistent.
   */
  ifAccountError?: string | null;
  /**
   * The venue symbol's listing on Orderly (worker/listing.ts, GET /v1/public/info/{symbol}); undefined / null = not
   * checked yet (or every check failed so far). Shared by every book on the symbol.
   */
  listing?: ListingInfo | null;
}

export const lc = (a: Address | string) => a.toLowerCase();

/** Listed and traded on the venue (false: tracked for non-trading duties only, see TrackedBook.venueSymbolError). */
export const tradable = (b: Pick<TrackedBook, "venueSymbolError">) => b.venueSymbolError === null;
