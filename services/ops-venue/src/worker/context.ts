import type { BookState, Logger, VenueAccount } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import type { ChainPort, OrderlyBook } from "../chain";
import type { FeeSettlement, OrderlyBuilderClient } from "../client";
import type { KeyStore } from "../keys";
import type { Ed25519Key } from "../orderly/auth";
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
}

export interface TrackedBook extends OrderlyBook {
  state: BookState;
  accounts: { if: Hex; mm: Hex };
}

export const lc = (a: Address | string) => a.toLowerCase();
