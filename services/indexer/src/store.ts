// Persistence port of the indexer. Every write is idempotent (natural keys / tx_hash+log_index /
// guarded state transitions) so a range can be re-applied after a crash or a cursor reset.
// Implementations: PgIndexerStore (drizzle, src/pgStore.ts) and MemoryIndexerStore (tests).
import type { BookComponents, CharterStatus } from "@bookrunner/shared";

export interface PendingEvent {
  type: string;
  bookId: number | null;
  payload: Record<string, unknown>;
  dedupeKey: string;
}

export interface CharterFiledRow {
  id: number;
  sponsor: string;
  structJson: Record<string, unknown>;
  underlying: string;
  symbol: string;
  venue: number;
  feeUsd: string | null;
  bondBkrn: string | null;
  filedAt: Date;
  bondTx: string;
}

export interface BookRow {
  id: number;
  charterId: number;
  bookAddr: string;
  seniorAddr: string;
  juniorAddr: string;
  vaultAddr: string;
  mandateAddr: string;
  routerAddr: string;
  deskAddr: string;
  adapterAddr: string;
  venue: number;
  symbol: string;
  underlying: string;
  name: string | null;
  createdAt: Date;
  subscriptionEnds: Date | null;
}

export interface BookPatch {
  state?: string;
  seniorNav?: string;
  juniorNav?: string;
  navUsd?: string;
  /** only applied when >= the stored last_mark_id */
  lastMarkId?: number;
}

export interface SubscriptionRow {
  bookId: number;
  tranche: "senior" | "junior";
  wallet: string;
  shares: string;
  assets: string;
  ts: Date;
  kind: "commit" | "allocation" | "refund" | "cancelled_refund";
  round: number;
  txHash: string;
  logIndex: number;
}

export interface RedemptionRow {
  bookId: number;
  tranche: "senior" | "junior";
  wallet: string;
  shares: string;
  noticeAt: Date;
  requestId: string;
  eligibleAt: Date;
  requestTx: string;
  logIndex: number;
}

export interface SettlementRow {
  bookId: number;
  ts: Date;
  source: string;
  grossUsd: string;
  expensesUsd: string;
  carryUsd: string;
  seniorUsd: string;
  juniorUsd: string;
  /** 2026-10 insurance pool: premium paid to the pool (RevenueRouter.PremiumPaid of the same tx); "0" otherwise */
  premiumUsd?: string;
  period: number | null;
  txHash: string;
  logIndex: number;
}

export interface AgentKeyRow {
  bookId: number;
  key: string;
  operator: string;
  validUntil: Date | null;
  inventoryTierUsd: string | null;
  registeredTx: string;
}

export interface KillRow {
  bookId: number;
  ts: Date;
  reason: string;
  breaches: string[];
  actions: string[];
  txHash: string;
}

export interface MarkRow {
  id: number;
  bookId: number;
  periodEnd: Date;
  navUsd: string;
  deployedValueUsd: string;
  inventoryRoot: string;
  pnlJsonHash: string;
  receiptsRoot: string;
  flowNonce: number;
  signer: string;
  signature: string;
  txHash: string;
  committedAt: Date;
}

export interface MarkAppliedPatch {
  seniorNav?: string;
  juniorNav?: string;
  seniorPrice?: number;
  juniorPrice?: number;
  pnlUsd?: string;
}

// ---------------------------------------------------------------- insurance pool (2026-10)

export interface PoolDepositRow {
  id: number;
  owner: string;
  assets: string;
  epoch: number;
  requestedAt: Date;
  requestTx: string;
}

export interface PoolWithdrawalRow {
  id: number;
  owner: string;
  sharesRaw: string;
  epoch: number;
  epochEndsAt: Date;
  requestedAt: Date;
  requestTx: string;
}

/** Fields set on the epoch row (absent = unchanged); `addFilled*` are added (guarded by the epoch_fill flow row). */
export interface PoolEpochPatch {
  endsAt?: Date | null;
  processedAt?: Date;
  processTx?: string;
  depositAssets?: string;
  depositSharesRaw?: string;
  stale?: boolean;
  staleBooks?: number;
  addFilledSharesRaw?: string;
  addFilledAssets?: string;
  complete?: boolean;
}

export interface PoolBookRow {
  bookId: number;
  market: string;
  allocation: string;
  claim: string;
  lossFirstLoss: string;
  lossDepositors: string;
  lastMarkAt: Date | null;
  active: boolean;
  allocatedAt: Date;
  /** true: the read failed, the values are the last good ones (or the Allocated event's) until the backfill re-reads */
  stale?: boolean;
}

export type PoolFlowKind =
  | "allocated"
  | "repaid"
  | "premium"
  | "loss"
  | "recovery"
  | "first_loss_deposit"
  | "first_loss_withdraw"
  | "withdraw_claim"
  | "epoch_fill";

export interface PoolFlowRow {
  ts: Date;
  kind: PoolFlowKind;
  bookId: number | null;
  amount: string;
  firstLossPart: string;
  txHash: string;
  logIndex: number;
}

export interface PoolSnapshotRow {
  blockNumber: number;
  ts: Date;
  poolAssets: string;
  depositorAssets: string;
  totalSupplyRaw: string;
  sharePrice: string;
  firstLoss: string;
  freeLiquidity: string;
  claims: string;
  utilisationBps: number;
  premiumsTotal: string;
  lossesTotal: string;
  depositsPending: string;
  pendingSharesRaw: string;
  /** true: the read at this block failed, the values are the previous good row's until the backfill re-reads it */
  stale?: boolean;
}

export interface VoteEntry {
  charterId: number;
  approve: boolean;
  tx: string;
  logIndex: number;
  ts: string;
}

/** engine_positions row (liquidation keeper trader set). */
export interface EnginePositionRow {
  marketId: number;
  trader: string;
  /** signed size after the event, 1e18 units (decimal string) */
  sizeRaw: string;
  lastBlock: number;
  lastLogIndex: number;
}

export interface IndexerStore {
  /** Runs fn atomically (DB transaction). */
  transaction<T>(fn: (s: IndexerStore) => Promise<T>): Promise<T>;
  /** Nested atomic unit inside a transaction (savepoint); a failure rolls back only fn. */
  savepoint<T>(fn: (s: IndexerStore) => Promise<T>): Promise<T>;

  getCursor(name: string): Promise<number | null>;
  setCursor(name: string, block: number): Promise<void>;
  loadBooks(): Promise<Array<{ bookId: number; components: BookComponents }>>;
  getCharterStruct(id: number): Promise<Record<string, unknown> | null>;
  getBookState(id: number): Promise<string | null>;

  upsertCharterFiled(r: CharterFiledRow): Promise<void>;
  /** Transition guarded by `from` (when given). Returns true when a row changed. */
  setCharterStatus(id: number, status: CharterStatus, p: { decidedAt?: Date; juryCid?: string; bookAddr?: string; from?: CharterStatus[] }): Promise<boolean>;
  setCharterJuryCid(id: number, cid: string): Promise<void>;
  setCharterBook(id: number, bookAddr: string): Promise<void>;
  appendCharterSlash(id: number, entry: { sponsor: string; amount: string; reason: string; tx: string; logIndex: number; ts: string }): Promise<boolean>;

  /** jury_verdicts.posted_tx for the (charter, digest) row; inserts a placeholder row if none exists. */
  recordVerdictPosted(p: { charterId: number; digest: string; cid: string; recommendApprove: boolean; txHash: string }): Promise<"updated" | "inserted" | "unchanged">;
  setCommitteeSeat(member: string, seat: number): Promise<void>;
  clearCommitteeSeat(seat: number): Promise<void>;
  setCommitteeBond(member: string, bond: bigint): Promise<void>;
  reduceCommitteeBond(member: string, amount: bigint): Promise<void>;
  appendCommitteeVote(member: string, vote: VoteEntry): Promise<boolean>;

  upsertBook(r: BookRow): Promise<void>;
  updateBook(id: number, patch: BookPatch): Promise<void>;

  insertSubscription(r: SubscriptionRow): Promise<boolean>;
  insertRedemption(r: RedemptionRow): Promise<boolean>;
  /** Fills honoured_mark_id + per-controller assets = floor(shares * price / 1e18) for unsettled rows. */
  settleRedemptions(p: { bookId: number; tranche: "senior" | "junior"; requestId: string; priceWad: bigint; markId: number | null }): Promise<number>;
  claimRedemptions(p: { bookId: number; tranche: "senior" | "junior"; wallet: string; at: Date }): Promise<number>;

  insertSettlement(r: SettlementRow): Promise<boolean>;
  upsertAgentKey(r: AgentKeyRow): Promise<void>;
  revokeAgentKey(p: { bookId: number; key: string; operator: string; revokedTx: string; reason: string }): Promise<void>;
  insertKillIfAbsent(r: KillRow): Promise<boolean>;
  insertMarkIfAbsent(r: MarkRow): Promise<boolean>;
  setMarkApplied(markId: number, txHash: string, patch?: MarkAppliedPatch): Promise<void>;

  // insurance pool (2026-10)
  insertPoolDeposit(r: PoolDepositRow): Promise<boolean>;
  /** cancelDeposit / claimDeposit: status transition from queued only. */
  closePoolDeposit(p: { id: number; status: "cancelled" | "claimed"; sharesRaw?: string; at: Date; txHash: string }): Promise<void>;
  insertPoolWithdrawal(r: PoolWithdrawalRow): Promise<boolean>;
  /** Adds `assets` to the request's claimed total (call only when the withdraw_claim flow row was new). */
  addPoolWithdrawalClaim(p: { id: number; assets: string; at: Date }): Promise<void>;
  upsertPoolEpoch(epoch: number, patch: PoolEpochPatch): Promise<void>;
  upsertPoolBook(r: PoolBookRow): Promise<void>;
  /** Adds a premium to pool_books.premiums_usd (call only when the premium flow row was new). */
  addPoolBookPremium(bookId: number, amount: string): Promise<void>;
  /** Idempotent per (tx, logIndex); true when inserted. */
  insertPoolFlow(r: PoolFlowRow): Promise<boolean>;
  upsertPoolSnapshot(r: PoolSnapshotRow): Promise<void>;
  /** Newest snapshot at or before `block` (the last good values a stale row carries). */
  poolSnapshotAtOrBefore(block: number): Promise<PoolSnapshotRow | null>;
  getPoolBook(bookId: number): Promise<PoolBookRow | null>;
  /** Keeps the last good values, flags the row for the backfill (no-op when the book has no row). */
  markPoolBookStale(bookId: number): Promise<void>;
  /** Backfill work (review I-3): stale snapshot blocks (oldest first), stale books, processed epochs without an end. */
  stalePoolSnapshots(limit: number): Promise<number[]>;
  stalePoolBooks(): Promise<number[]>;
  poolEpochsWithoutEnd(limit: number): Promise<number[]>;

  // in-house engine (2026-10 liquidation keeper)
  /**
   * Upserts the (market, trader) row. `sizeRaw` null = keep the stored size (MarginChanged: a new trader starts at 0).
   * A row written by a later log (block, logIndex) is never overwritten by an earlier one (re-applied ranges).
   */
  upsertEnginePosition(r: Omit<EnginePositionRow, "sizeRaw"> & { sizeRaw: string | null }): Promise<void>;

  /** Domain-event protocol insert; null when the dedupe key already exists. */
  insertEvent(e: PendingEvent): Promise<{ id: number; createdAt: Date } | null>;
}
