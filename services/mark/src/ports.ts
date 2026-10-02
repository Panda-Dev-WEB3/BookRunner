// Ports between the mark pipeline and its adapters (viem chain, Postgres, receipts, signer, Redis feeds).
import type { BookRef } from "@bookrunner/waterfall";
import type { MarkInput, MarkPnl } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import type { AdapterReportState, SignedVenueReport } from "../../ops-venue/src/report712";
import type { SignedPrice } from "./domain/prices";
import type { MarkSnapshot } from "./domain/types";

/** MarkRegistry.commitAndApply outcome: one tx committed AND applied the mark (docs/LOW_GAS.md §3). */
export interface AtomicMarkResult {
  hash: Hex;
  markId: bigint;
  committedAt: Date;
  applied: MarkAppliedEvent;
}

export type SimulationResult = { ok: true } | { ok: false; error: string; /** the registry has no commitAndApply */ unsupported: boolean };

/** Off-chain signed inputs (Redis), already signature-verified by the adapter. */
export interface MarkFeeds {
  /** Signed oracle prices (bundle + per-key messages) whose signer is an active AttestedOracle signer. */
  signedPrices(): Promise<SignedPrice[]>;
  /** Signed venue reports of an Orderly book whose signer holds OPS_VENUE (any order). */
  venueReports(ref: BookRef): Promise<SignedVenueReport[]>;
}

export interface CommittedMark {
  markId: bigint;
  periodEnd: number;
  applied: boolean;
  input: MarkInput;
  signer: Address;
}

export interface MarkAppliedEvent {
  markId: bigint;
  navUsd: bigint;
  pnlUsd: bigint;
  seniorNav: bigint;
  juniorNav: bigint;
  seniorPrice: bigint;
  juniorPrice: bigint;
}

export interface MarkChain {
  head(): Promise<{ blockNumber: bigint; timestamp: number }>;
  markInterval(): Promise<number>;
  maxMarkAge(): Promise<number>;
  /**
   * Everything a mark needs at ONE block. `prices` (newest signed price per lower-case underlying) values
   * desk tokens / the engine pool whenever a signed price is newer than the stored on-chain one; the
   * prices used are returned in `snapshot.signedPrices`.
   */
  snapshot(ref: BookRef, blockNumber: bigint, prices?: ReadonlyMap<string, SignedPrice>): Promise<MarkSnapshot>;
  /** MarkRegistry implements commitAndApply (checked on its bytecode; cached). */
  supportsCommitAndApply(): Promise<boolean>;
  /** eth_call of commitAndApply from the keeper account (nothing sent). */
  simulateCommitAndApply(ref: BookRef, input: MarkInput, signature: Hex, priceData: Hex, venueReport: Hex): Promise<SimulationResult>;
  /** MarkRegistry.commitAndApply: oracle.update + adapter.reportSigned + commit + Book.applyMark in one tx. */
  commitAndApply(ref: BookRef, input: MarkInput, signature: Hex, priceData: Hex, venueReport: Hex): Promise<AtomicMarkResult>;
  /** Orderly: the adapter's report state at the latest block (null for engine books / unreadable). */
  adapterReportState(ref: BookRef): Promise<AdapterReportState | null>;
  flowNonce(ref: BookRef): Promise<bigint>;
  lastMarkPeriodEnd(ref: BookRef): Promise<number>;
  /** MarkRegistry.latestMarkId(bookId) -> getMark (null if none). */
  latestCommitted(ref: BookRef): Promise<CommittedMark | null>;
  /** MarkRegistry.hashMark (digest cross-check; null if the call fails). */
  hashMark(input: MarkInput): Promise<Hex | null>;
  commit(input: MarkInput, signature: Hex): Promise<{ hash: Hex; markId: bigint; committedAt: Date }>;
  /** Tx hash of MarkCommitted(markId) (resume path when the marks row is missing). */
  commitTxOf(markId: bigint): Promise<Hex | null>;
  applyMark(ref: BookRef, markId: bigint): Promise<{ hash: Hex; applied: MarkAppliedEvent }>;
}

export interface MarkRow {
  markId: number;
  bookId: number;
  periodEnd: number;
  input: MarkInput;
  pnl: MarkPnl;
  signer: Address;
  signature: Hex;
  commitTx: Hex;
  committedAt: Date;
  preview: { seniorNav: bigint; juniorNav: bigint; seniorPrice: bigint; juniorPrice: bigint; pnlUsd: bigint };
}

export interface StoredMark {
  markId: number;
  pnl: MarkPnl;
  commitTx: string;
  appliedTx: string | null;
  receiptsRoot: string;
}

export interface MarkStore {
  /** Fee flow credited to the tranches by the distribution of `period` (null = not distributed yet). */
  distribution(bookId: number, period: number): Promise<{ senior: bigint; junior: bigint; txHash: string } | null>;
  fundingInPeriod(bookId: number, periodStart: number, periodEnd: number): Promise<bigint>;
  /** pnl.unrealizedUsd of the latest mark before `periodEnd` (0 if none). */
  prevUnrealized(bookId: number, periodEnd: number): Promise<bigint>;
  lastQuoteSkewBps(bookId: number, atOrBefore: number): Promise<number | null>;
  markForPeriod(bookId: number, periodEnd: number): Promise<StoredMark | null>;
  saveCommitted(row: MarkRow): Promise<void>;
  saveApplied(markId: number, appliedTx: Hex, ev: MarkAppliedEvent): Promise<void>;
  updateBookNav(bookId: number, markId: number, ev: MarkAppliedEvent): Promise<void>;
}

export interface MarkSignerPort {
  address: Address;
  sign(input: MarkInput): Promise<Hex>;
  /** Recovers the signer of `signature` over `input` (EIP-712). */
  recover(input: MarkInput, signature: Hex): Promise<Address>;
  digest(input: MarkInput): Hex;
}

export interface ReceiptsRootPort {
  periodRoot(bookId: number, periodStart: number, periodEnd: number): Promise<{ root: Hex; complete: boolean; windows: number; receipts: number }>;
}
