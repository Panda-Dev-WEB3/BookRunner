// Ports between the waterfall's orchestration (settlement.ts, keeper.ts) and its adapters
// (adapters/chain.ts, adapters/store.ts, adapters/venue-ops.ts). Tests use in-memory fakes.
import type { BookState, SplitResult } from "@bookrunner/shared";
import type { Hex } from "viem";
import type { LastMarkInfo } from "./domain/keeper";
import type { BookRef } from "./kit/books";

export interface DistributedLog {
  bookId: number;
  period: number;
  amounts: SplitResult;
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  ts: Date;
}

export interface SettlementReceivedLog {
  source: number; // REVENUE_SOURCE
  amount: bigint;
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  ts: Date;
}

export interface SplitParams {
  pendingGross: bigint;
  expenseCapBps: bigint;
  carryBps: bigint;
  seniorHurdleBps: bigint;
  seniorSupply: bigint;
  juniorSupply: bigint;
}

export interface SettlementChain {
  bookState(ref: BookRef): Promise<BookState>;
  /** Distributed(bookId, period) already emitted by the router (on-chain idempotency). */
  findDistributed(ref: BookRef, period: number): Promise<DistributedLog | null>;
  /** Tx hash of the adapter's FeesSwept(period) event, or null if the period was not swept yet. */
  feesSwept(ref: BookRef, period: number): Promise<Hex | null>;
  /** SettlementReceived logs of the book's router emitted by one transaction (e.g. ops-venue's sweep). */
  receivedInTx(ref: BookRef, txHash: Hex): Promise<SettlementReceivedLog[]>;
  /** PoolEngineAdapter.sweepFees(period, 0) (anyone may call). */
  sweepEngineFees(ref: BookRef, period: number): Promise<{ hash: Hex; received: SettlementReceivedLog[] }>;
  splitParams(ref: BookRef): Promise<SplitParams>;
  /** router.previewSplit (null if the call fails). */
  previewOnChain(ref: BookRef, gross: bigint, expenses: bigint): Promise<SplitResult | null>;
  distribute(ref: BookRef, period: number, expenses: bigint): Promise<{ hash: Hex; distributed: DistributedLog }>;
}

export interface StoredDistribution {
  txHash: string;
  amounts: SplitResult;
}

export interface SettlementStore {
  distributionFor(bookId: number, period: number): Promise<StoredDistribution | null>;
  insertDistribution(d: DistributedLog): Promise<void>;
  insertReceived(bookId: number, period: number, logs: SettlementReceivedLog[]): Promise<void>;
}

export type SweepJobState = "completed" | "failed" | "pending" | "missing";

export interface VenueOps {
  /** QUEUES.venueOps {kind: "sweep_fees", bookId, period}; deduplicated per (book, period). */
  enqueueSweep(bookId: number, period: number): Promise<void>;
  sweepJobState(bookId: number, period: number): Promise<SweepJobState>;
}

export interface KeeperSnapshot {
  state: BookState;
  nowSec: number; // chain time (latest block)
  markInterval: number;
  subscriptionEnds: number;
  unfundedClaims: bigint;
  vaultIdle: bigint;
  inTransit: bigint;
  insuranceEquity: bigint;
  marginEquity: bigint;
  netExposure: bigint;
  sharePriceWad: { senior: bigint; junior: bigint };
  lastMarkPeriodEnd: number;
  lastMark: LastMarkInfo | null;
}

export interface KeeperChain {
  snapshot(ref: BookRef): Promise<KeeperSnapshot>;
  /** Pending (unsettled) redemption shares per tranche in buckets afterIndex < id <= upToIndex. */
  pendingRedemptions(ref: BookRef, afterIndex: bigint, upToIndex: bigint): Promise<{ senior: bigint; junior: bigint }>;
  closeWindow(ref: BookRef): Promise<Hex>;
  fundClaims(ref: BookRef): Promise<Hex>;
  recall(ref: BookRef, account: number, amount: bigint): Promise<Hex>;
  finalizeRetirement(ref: BookRef): Promise<Hex>;
}

export interface BookLookup {
  get(bookId: number): Promise<BookRef | undefined>;
}
