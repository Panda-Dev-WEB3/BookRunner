// Ports between the risk logic and infrastructure. Real adapters live in src/adapters/*; tests
// inject fakes that record calls.
import type { BookState, DomainEvent, KillMsg, OraclePriceMsg, QuotingVenue, VenueOpsJob } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import type { FlattenOrder, Holding } from "./domain/flatten";
import type { BookRef, ChainObservation, LiveNav, QuoteObservation, RiskStatePayload } from "./types";

export interface KillLog {
  txHash: Hex;
  reason: Hex;
  by: Address;
  blockNumber: bigint;
}

/** Chain reads + RISK-role writes for one deployment. */
export interface ChainPort {
  readonly riskAddress: Address;
  observe(ref: BookRef): Promise<ChainObservation>;
  isKilled(ref: BookRef): Promise<boolean>;
  /** Latest MMMandate `Kill` log of the book's mandate (null if none found). */
  latestKill(ref: BookRef): Promise<KillLog | null>;
  /** IPoolEngineAdapter.setReduceOnly(true) — engine books only. Returns the tx hash. */
  setReduceOnly(ref: BookRef): Promise<Hex>;
  deskHoldings(ref: BookRef): Promise<Holding[]>;
  /** desk.execute(Flatten) with the RISK account. Returns the tx hash. */
  flatten(ref: BookRef, order: FlattenOrder, poolFee: number): Promise<Hex>;
  /** IMMMandate.kill(bytes32(reason)) with the RISK account. Returns the tx hash. */
  mandateKill(ref: BookRef, reason: string): Promise<Hex>;
}

/** Book discovery. */
export interface DiscoveryPort {
  listBookIds(): Promise<number[]>;
  loadRef(bookId: number): Promise<BookRef>;
  bookState(ref: BookRef): Promise<BookState>;
}

export interface LimitsRow {
  bookId: number;
  ts: Date;
  inventoryUtil: number;
  skewUtil: number;
  hedgeRatio: number | null;
  drawdownBps: number;
  state: string;
  offHours: boolean;
  breaches: string[];
  netExposureUsd: number;
  liveNavUsd: number;
}

export interface ReceiptRow {
  bookId: number;
  kind: number;
  ts: Date;
  payload: Record<string, unknown>;
  payloadHash: Hex;
  hourStart: Date;
}

export interface KillEventRow {
  bookId: number;
  ts: Date;
  reason: string;
  breaches: string[];
  actions: string[];
  txHashes: string[];
}

export interface HedgeRow {
  bookId: number;
  ts: Date;
  asset: string;
  qtyRaw: string; // signed raw units (negative = sell)
  px: number;
  mult: number;
  txHash: string;
  venue: string;
  valueUsd: string;
}

export interface EventRow {
  type: string;
  bookId: number;
  payload: Record<string, unknown>;
  dedupeKey: string;
}

export interface DbBookRow {
  id: number;
  venue: number;
  symbol: string;
  underlying: string;
  state: string;
  bookAddr: string;
  seniorAddr: string;
  juniorAddr: string;
  vaultAddr: string;
  mandateAddr: string;
  routerAddr: string;
  deskAddr: string;
  adapterAddr: string;
}

export interface StorePort {
  insertLimits(row: LimitsRow): Promise<void>;
  /** ON CONFLICT (dedupe_key) DO NOTHING; returns the new row, or the existing one (inserted=false). */
  insertEvent(e: EventRow): Promise<{ id: number; createdAt: Date; inserted: boolean }>;
  insertReceipt(r: ReceiptRow): Promise<void>;
  insertKillEvent(r: KillEventRow): Promise<void>;
  killEvents(bookId: number): Promise<Array<{ reason: string; txHashes: string[] }>>;
  insertHedge(r: HedgeRow): Promise<void>;
  liveBooks(): Promise<DbBookRow[]>;
}

export interface BusPort {
  latestQuote(bookId: number): Promise<QuoteObservation | null>;
  oracleLast(priceId: string): Promise<OraclePriceMsg | null>;
  loadRiskState(bookId: number): Promise<RiskStatePayload | null>;
  /** SET KEYS.riskState + PUBLISH CHANNELS.riskState. */
  saveRiskState(bookId: number, payload: RiskStatePayload): Promise<void>;
  saveLiveNav(bookId: number, nav: LiveNav): Promise<void>;
  /** PUBLISH CHANNELS.kill(bookId). */
  publishKill(bookId: number, msg: KillMsg): Promise<void>;
  /** PUBLISH CHANNELS.domainEvents. */
  publishDomainEvent(evt: DomainEvent): Promise<void>;
}

export interface QueuePort {
  enqueueVenueOp(job: VenueOpsJob, jobId: string): Promise<void>;
}

/** Live venue clients (QuotingVenue) per book; null when none is available (engine books, no keys). */
export interface VenueProvider {
  forBook(ref: BookRef): Promise<QuotingVenue | null>;
}

export interface Clock {
  nowMs(): number;
}

export const systemClock: Clock = { nowMs: () => Date.now() };
