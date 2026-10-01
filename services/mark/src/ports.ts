// Ports between the mark pipeline and its adapters (viem chain, Postgres, receipts, signer).
import type { BookRef } from "@bookrunner/waterfall";
import type { MarkInput, MarkPnl } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import type { MarkSnapshot } from "./domain/types";

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
  snapshot(ref: BookRef, blockNumber: bigint): Promise<MarkSnapshot>;
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
