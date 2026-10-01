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

export interface VoteEntry {
  charterId: number;
  approve: boolean;
  tx: string;
  logIndex: number;
  ts: string;
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

  /** Domain-event protocol insert; null when the dedupe key already exists. */
  insertEvent(e: PendingEvent): Promise<{ id: number; createdAt: Date } | null>;
}
