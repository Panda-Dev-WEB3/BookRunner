import type { BookState, Logger, VenueAccount } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import type { ChainPort, OrderlyBook } from "../chain";
import type { FeeSettlement, OrderlyBuilderClient } from "../client";
import type { KeyStore } from "../keys";
import type { Ed25519Key } from "../orderly/auth";
import type { SignedVenueReportJson, VenueReportValues } from "../report712";
import type { OpsStore, SagaStore } from "../store";
import type { KeyedMutex } from "../util";

/** Builder/ops venue operations the workers use (OrderlyBuilderClient satisfies it; tests fake it). */
export type BuilderPort = Pick<
  OrderlyBuilderClient,
  "createSymbol" | "setSymbolStatus" | "insuranceFund" | "addKey" | "keyInfo" | "revokeTradeKey" | "requestWithdraw" | "withdrawal" | "withdrawals" | "mockCompleteWithdraw" | "mockRegisterAccount"
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
  withdrawMaxAttempts: number;
  priceSource: "builder" | "chainlink";
  logMaxRange: bigint;
  reportMaxDropBps: number;
  reportDropConfirmations: number;
  /** Hold reports this long (chain seconds) after any on-chain venue flow (deposit / confirm / fail) so the venue reflects it. */
  reportSettleSec: number;
  /** OPS_REPORT_MODE (service default: signed). */
  reportMode: ReportMode;
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
}

export interface TrackedBook extends OrderlyBook {
  state: BookState;
  accounts: { if: Hex; mm: Hex };
}

export const lc = (a: Address | string) => a.toLowerCase();
