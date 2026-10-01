// Persistence ports: Postgres (venue_accounts, settlements, events, receipts, chain_cursor) + Redis
// domain-event fan-out, and a JSON-file saga store for multi-step on-chain flows.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { chainCursor, type Db, events, receipts, settlements, venueAccounts } from "@bookrunner/db";
import { CHANNELS, type DomainEventPayloads, type DomainEventType, dbUsd, payloadHash, REPO_ROOT, type ReceiptKind } from "@bookrunner/shared";
import { and, eq, sql } from "drizzle-orm";
import type { FeeSaga } from "./domain/fees";
import type { WithdrawSaga } from "./domain/withdraw";

export type VenueAccountKind = "if" | "mm" | "builder";
export type VenueAccountStatus = "active" | "revoked" | "pending";

export interface VenueAccountRow {
  bookId: number;
  kind: VenueAccountKind;
  accountId: string;
  keyPrefix: string | null;
  status: VenueAccountStatus;
}

export interface OpsStore {
  upsertVenueAccount(r: VenueAccountRow): Promise<void>;
  setVenueAccountStatus(bookId: number, kind: VenueAccountKind, status: VenueAccountStatus, keyPrefix?: string | null): Promise<void>;
  venueAccounts(bookId: number): Promise<VenueAccountRow[]>;
  hasFeeSettlement(bookId: number, period: number): Promise<boolean>;
  insertFeeSettlement(r: { bookId: number; period: number; amountUsd: bigint; txHash: string; logIndex: number; ts: Date }): Promise<void>;
  emitEvent<T extends DomainEventType>(type: T, bookId: number | null, data: DomainEventPayloads[T], dedupeKey: string): Promise<boolean>;
  insertReceipt(r: { bookId: number; kind: ReceiptKind; tsSec: number; payload: unknown }): Promise<void>;
  getCursor(name: string): Promise<bigint | null>;
  setCursor(name: string, block: bigint): Promise<void>;
}

export interface Publisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export class PgOpsStore implements OpsStore {
  constructor(
    private readonly db: Db,
    private readonly pub: Publisher,
    private readonly receiptsIntervalSec: number,
  ) {}

  async upsertVenueAccount(r: VenueAccountRow): Promise<void> {
    await this.db
      .insert(venueAccounts)
      .values({ bookId: r.bookId, kind: r.kind, accountId: r.accountId, keyPrefix: r.keyPrefix, status: r.status, revokedAt: r.status === "revoked" ? new Date() : null })
      .onConflictDoUpdate({
        target: [venueAccounts.bookId, venueAccounts.kind, venueAccounts.accountId],
        set: {
          keyPrefix: r.keyPrefix,
          status: r.status,
          revokedAt: r.status === "revoked" ? sql`coalesce(${venueAccounts.revokedAt}, now())` : null,
        },
      });
  }

  async setVenueAccountStatus(bookId: number, kind: VenueAccountKind, status: VenueAccountStatus, keyPrefix?: string | null): Promise<void> {
    await this.db
      .update(venueAccounts)
      .set({
        status,
        revokedAt: status === "revoked" ? sql`coalesce(${venueAccounts.revokedAt}, now())` : null,
        ...(keyPrefix !== undefined ? { keyPrefix } : {}),
      })
      .where(and(eq(venueAccounts.bookId, bookId), eq(venueAccounts.kind, kind)));
  }

  async venueAccounts(bookId: number): Promise<VenueAccountRow[]> {
    const rows = await this.db.select().from(venueAccounts).where(eq(venueAccounts.bookId, bookId));
    return rows.map((r) => ({ bookId: r.bookId, kind: r.kind as VenueAccountKind, accountId: r.accountId, keyPrefix: r.keyPrefix, status: r.status as VenueAccountStatus }));
  }

  async hasFeeSettlement(bookId: number, period: number): Promise<boolean> {
    const rows = await this.db
      .select({ id: settlements.id })
      .from(settlements)
      .where(and(eq(settlements.bookId, bookId), eq(settlements.source, "venue_taker_share"), eq(settlements.period, period)))
      .limit(1);
    return rows.length > 0;
  }

  async insertFeeSettlement(r: { bookId: number; period: number; amountUsd: bigint; txHash: string; logIndex: number; ts: Date }): Promise<void> {
    await this.db
      .insert(settlements)
      .values({ bookId: r.bookId, ts: r.ts, source: "venue_taker_share", grossUsd: dbUsd.toDb(r.amountUsd), period: r.period, txHash: r.txHash, logIndex: r.logIndex })
      .onConflictDoNothing();
  }

  async emitEvent<T extends DomainEventType>(type: T, bookId: number | null, data: DomainEventPayloads[T], dedupeKey: string): Promise<boolean> {
    const rows = await this.db
      .insert(events)
      .values({ type, bookId, payload: data as unknown as Record<string, unknown>, dedupeKey })
      .onConflictDoNothing({ target: events.dedupeKey })
      .returning({ id: events.id, createdAt: events.createdAt });
    const row = rows[0];
    if (!row) return false;
    await this.pub.publish(CHANNELS.domainEvents, JSON.stringify({ id: row.id, type, createdAt: row.createdAt.toISOString(), data }));
    return true;
  }

  async insertReceipt(r: { bookId: number; kind: ReceiptKind; tsSec: number; payload: unknown }): Promise<void> {
    const hour = Math.floor(r.tsSec / this.receiptsIntervalSec) * this.receiptsIntervalSec;
    await this.db.insert(receipts).values({
      bookId: r.bookId,
      kind: r.kind,
      ts: new Date(r.tsSec * 1000),
      payload: r.payload as Record<string, unknown>,
      payloadHash: payloadHash(r.payload),
      hourStart: new Date(hour * 1000),
    });
  }

  async getCursor(name: string): Promise<bigint | null> {
    const rows = await this.db.select().from(chainCursor).where(eq(chainCursor.name, name)).limit(1);
    return rows[0] ? BigInt(rows[0].blockNumber) : null;
  }

  async setCursor(name: string, block: bigint): Promise<void> {
    await this.db
      .insert(chainCursor)
      .values({ name, blockNumber: Number(block) })
      .onConflictDoUpdate({ target: chainCursor.name, set: { blockNumber: Number(block), updatedAt: new Date() } });
  }
}

// ------------------------------------------------------------------ sagas
export interface SagaState {
  withdrawals: Record<string, WithdrawSaga>;
  fees: Record<string, FeeSaga>;
  /** last adapter.report asOf per adapter (monotonic guard across restarts) */
  lastAsOf: Record<string, string>;
  /** last reported venue value per adapter + consecutive suspicious readings (drop guard) */
  reportGuard: Record<string, { value: string; at: number; suspect: number }>;
}

const emptySagaState = (): SagaState => ({ withdrawals: {}, fees: {}, lastAsOf: {}, reportGuard: {} });

/** Drop terminal sagas older than the retention windows. Returns true if anything was removed. */
export function pruneSagas(s: SagaState, now: number, feeRetentionMs = 7 * 86_400_000, withdrawRetentionMs = 30 * 86_400_000): boolean {
  let changed = false;
  for (const [k, f] of Object.entries(s.fees)) {
    if ((f.stage === "swept" || f.stage === "skipped") && now - f.updatedAt > feeRetentionMs) {
      delete s.fees[k];
      changed = true;
    }
  }
  for (const [k, w] of Object.entries(s.withdrawals)) {
    if (w.stage === "swept" && now - w.updatedAt > withdrawRetentionMs) {
      delete s.withdrawals[k];
      changed = true;
    }
  }
  return changed;
}

export interface SagaStore {
  get(): SagaState;
  save(): void;
}

export class MemorySagaStore implements SagaStore {
  state: SagaState = emptySagaState();
  get() {
    return this.state;
  }
  save() {}
}

export class FileSagaStore implements SagaStore {
  private state: SagaState;
  readonly path: string;

  constructor(file: string) {
    this.path = isAbsolute(file) ? file : resolve(REPO_ROOT, file);
    this.state = existsSync(this.path) ? { ...emptySagaState(), ...(JSON.parse(readFileSync(this.path, "utf8")) as Partial<SagaState>) } : emptySagaState();
  }

  get() {
    return this.state;
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
  }
}
