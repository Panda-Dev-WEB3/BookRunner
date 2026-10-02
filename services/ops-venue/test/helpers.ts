// Test fakes: in-process mock-orderly (no network), in-memory chain + store, and an OpsContext factory.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, MockVenue, mulberry32 } from "@bookrunner/mock-orderly";
import { type BookState, createLogger, devAccount, type DomainEventPayloads, type DomainEventType, type ReceiptKind } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
import type { AdapterLog, ChainPort, MandateLog, OrderlyBook, SimResult } from "../src/chain";
import { OrderlyBuilderClient, OrderlyVenue } from "../src/client";
import { KeyStore } from "../src/keys";
import { generateKey } from "../src/orderly/auth";
import { orderlyAccountId } from "../src/orderly/convert";
import type { FetchLike } from "../src/orderly/http";
import { MemorySagaStore, type OpsStore, type VenueAccountKind, type VenueAccountRow, type VenueAccountStatus } from "../src/store";
import { KeyedMutex } from "../src/util";
import type { OpsContext, TrackedBook } from "../src/worker/context";

export const log = createLogger("ops-venue-test", "silent");
export const OPS = devAccount("opsVenue");
export const BROKER = "bookrunner";
export const BASE = "http://mock-orderly.test";
export const LEDGER = "0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203" as Address;

export function makeMock(authMode: "strict" | "permissive" = "permissive", now?: () => number) {
  const venue = new MockVenue({ settleIntervalSec: 300, ifRequirementUsd: 100 }, now);
  const app = createApp({ venue, authMode, brokerId: BROKER, ledgerAddress: LEDGER, delegateSigners: [OPS.address.toLowerCase()], rng: mulberry32(1) });
  const fetch: FetchLike = async (url, init) => app.request(url, init as RequestInit);
  return { venue, app, fetch };
}

export const ADAPTER = "0x00000000000000000000000000000000000a0a01" as Address;
export const MANDATE = "0x00000000000000000000000000000000000a0a02" as Address;
export const IF_ID = `0x${"a1".repeat(32)}` as Hex;
export const MM_ID = `0x${"b2".repeat(32)}` as Hex;
export const BUILDER_ID = orderlyAccountId(OPS.address, BROKER).toLowerCase();
export const SYMBOL = "PERP_NVDA_USDC";

export function trackedBook(state: BookState = "Live"): TrackedBook {
  return {
    bookId: 1,
    book: "0x00000000000000000000000000000000000a0a00",
    adapter: ADAPTER,
    mandate: MANDATE,
    vault: "0x00000000000000000000000000000000000a0a03",
    router: "0x00000000000000000000000000000000000a0a04",
    symbol: SYMBOL,
    baseAsset: "NVDA",
    sessions: `0x${"00".repeat(32)}`,
    underlying: `0x${"00".repeat(32)}`,
    ifTargetUsd: 25_000_000_000n,
    mmInventoryUsd: 75_000_000_000n,
    state,
    accounts: { if: IF_ID, mm: MM_ID },
  };
}

/** In-memory chain: adapter USDC balances, mock vault ledger, FeesSwept / WithdrawRequested logs. */
export class FakeChain implements ChainPort {
  readonly opsAddress = OPS.address;
  readonly usdc = "0x00000000000000000000000000000000000000c0" as Address;
  readonly startBlock = 1n;
  block = 10n;
  calls: Array<{ fn: string; args: unknown[] }> = [];
  balances = new Map<string, bigint>();
  ledger = new Map<string, bigint>();
  adapterLogList: AdapterLog[] = [];
  mandateLogList: MandateLog[] = [];
  confirmed = new Set<string>();
  pendingNonces = new Set<string>();
  killed = false;
  cap = 10_000_000_000n;
  failNext: Record<string, string> = {};
  books: OrderlyBook[] = [];
  states = new Map<string, BookState>();
  private seq = 0;

  private tx(fn: string, args: unknown[]): Hex {
    const err = this.failNext[fn];
    if (err) {
      delete this.failNext[fn];
      throw new Error(err);
    }
    this.calls.push({ fn, args });
    this.block++;
    this.seq++;
    return `0x${this.seq.toString(16).padStart(64, "0")}` as Hex;
  }
  count(fn: string) {
    return this.calls.filter((c) => c.fn === fn).length;
  }
  async listBookIds() {
    return this.books.map((b) => b.bookId);
  }
  async loadOrderlyBook(id: number) {
    return this.books.find((b) => b.bookId === id) ?? null;
  }
  async bookState(book: Address) {
    return this.states.get(book.toLowerCase()) ?? "Live";
  }
  async accountIds() {
    return { if: IF_ID, mm: MM_ID };
  }
  async mandateKilled() {
    return this.killed;
  }
  async maxFeeSweepPerPeriod() {
    return this.cap;
  }
  async markInterval() {
    return 300;
  }
  async usdcBalance(who: Address) {
    return this.balances.get(who.toLowerCase()) ?? 0n;
  }
  async blockNumber() {
    return this.block;
  }
  async adapterLogs(adapters: Address[], from: bigint, to: bigint) {
    const set = new Set(adapters.map((a) => a.toLowerCase()));
    return this.adapterLogList.filter((l) => set.has(l.adapter.toLowerCase()) && l.block >= from && l.block <= to);
  }
  async mandateLogs(mandates: Address[], from: bigint, to: bigint) {
    const set = new Set(mandates.map((a) => a.toLowerCase()));
    return this.mandateLogList.filter((l) => set.has(l.mandate.toLowerCase()) && l.block >= from && l.block <= to);
  }
  async report(adapter: Address, i: bigint, m: bigint, e: bigint, asOf: bigint) {
    return this.tx("report", [adapter, i, m, e, asOf]);
  }
  async simulateConfirmWithdraw(adapter: Address, nonce: bigint): Promise<SimResult> {
    const k = `${adapter.toLowerCase()}:${nonce}`;
    if (this.confirmed.has(k)) return { ok: false, error: "AlreadyConfirmed()" };
    if (!this.pendingNonces.has(k)) return { ok: false, error: "UnknownNonce()" };
    return { ok: true };
  }
  async confirmWithdraw(adapter: Address, nonce: bigint) {
    const h = this.tx("confirmWithdraw", [adapter, nonce]);
    this.confirmed.add(`${adapter.toLowerCase()}:${nonce}`);
    return h;
  }
  async sweepToVault(adapter: Address) {
    const bal = this.balances.get(adapter.toLowerCase()) ?? 0n;
    if (bal === 0n) return null;
    const h = this.tx("sweepToVault", [adapter, bal]);
    this.balances.set(adapter.toLowerCase(), 0n);
    return h;
  }
  async sweepFees(adapter: Address, period: bigint, amount: bigint) {
    const bal = this.balances.get(adapter.toLowerCase()) ?? 0n;
    if (bal < amount) throw new Error("insufficient adapter balance");
    if (this.adapterLogList.some((l) => l.kind === "FeesSwept" && l.period === period && l.adapter.toLowerCase() === adapter.toLowerCase())) throw new Error("PeriodAlreadySwept()");
    if (amount > this.cap) throw new Error("FeeSweepCap()");
    const txHash = this.tx("sweepFees", [adapter, period, amount]);
    this.balances.set(adapter.toLowerCase(), bal - amount);
    this.adapterLogList.push({ kind: "FeesSwept", adapter, period, amount, block: this.block, txHash, logIndex: 3 });
    return { txHash, logIndex: 3 };
  }
  async vaultLedger(accountId: Hex) {
    return this.ledger.get(accountId.toLowerCase()) ?? 0n;
  }
  async vaultCreditFees(accountId: Hex, amount: bigint) {
    const h = this.tx("creditFees", [accountId, amount]);
    this.ledger.set(accountId.toLowerCase(), (this.ledger.get(accountId.toLowerCase()) ?? 0n) + amount);
    return h;
  }
  async vaultOperatorWithdraw(accountId: Hex, to: Address, amount: bigint) {
    const led = this.ledger.get(accountId.toLowerCase()) ?? 0n;
    if (led < amount) throw new Error("InsufficientLedger()");
    const h = this.tx("operatorWithdraw", [accountId, to, amount]);
    this.ledger.set(accountId.toLowerCase(), led - amount);
    this.balances.set(to.toLowerCase(), (this.balances.get(to.toLowerCase()) ?? 0n) + amount);
    return h;
  }
  async usdcTransfer(to: Address, amount: bigint) {
    const h = this.tx("usdcTransfer", [to, amount]);
    this.balances.set(to.toLowerCase(), (this.balances.get(to.toLowerCase()) ?? 0n) + amount);
    return h;
  }
  /** far-future head so tests' injected clock wins the min(now, head) clamp */
  headTs = 1n << 40n;
  async headTimestamp() {
    return this.headTs;
  }
  mockAccounts = new Set<string>();
  async ensureMockAccount(accountId: Hex) {
    if (this.mockAccounts.has(accountId.toLowerCase())) return;
    this.mockAccounts.add(accountId.toLowerCase());
    this.tx("ensureMockAccount", [accountId]);
  }
}

export class MemoryStore implements OpsStore {
  accounts = new Map<string, VenueAccountRow>();
  settlements: Array<{ bookId: number; period: number; amountUsd: bigint; txHash: string; logIndex: number }> = [];
  events: Array<{ type: string; bookId: number | null; data: unknown; dedupeKey: string }> = [];
  receipts: Array<{ bookId: number; kind: ReceiptKind; tsSec: number; payload: unknown }> = [];
  cursors = new Map<string, bigint>();

  async upsertVenueAccount(r: VenueAccountRow) {
    this.accounts.set(`${r.bookId}:${r.kind}:${r.accountId}`, { ...r });
  }
  async setVenueAccountStatus(bookId: number, kind: VenueAccountKind, status: VenueAccountStatus, keyPrefix?: string | null) {
    for (const r of this.accounts.values()) if (r.bookId === bookId && r.kind === kind) Object.assign(r, { status, ...(keyPrefix !== undefined ? { keyPrefix } : {}) });
  }
  async venueAccounts(bookId: number) {
    return [...this.accounts.values()].filter((r) => r.bookId === bookId);
  }
  async hasFeeSettlement(bookId: number, period: number) {
    return this.settlements.some((s) => s.bookId === bookId && s.period === period);
  }
  async insertFeeSettlement(r: { bookId: number; period: number; amountUsd: bigint; txHash: string; logIndex: number }) {
    if (!this.settlements.some((s) => s.txHash === r.txHash && s.logIndex === r.logIndex)) this.settlements.push(r);
  }
  async emitEvent<T extends DomainEventType>(type: T, bookId: number | null, data: DomainEventPayloads[T], dedupeKey: string) {
    if (this.events.some((e) => e.dedupeKey === dedupeKey)) return false;
    this.events.push({ type, bookId, data, dedupeKey });
    return true;
  }
  async insertReceipt(r: { bookId: number; kind: ReceiptKind; tsSec: number; payload: unknown }) {
    this.receipts.push(r);
  }
  async getCursor(name: string) {
    return this.cursors.get(name) ?? null;
  }
  async setCursor(name: string, block: bigint) {
    this.cursors.set(name, block);
  }
}

export async function makeCtx(o: { mode?: "mock" | "live"; authMode?: "strict" | "permissive"; now?: () => number } = {}) {
  const mock = makeMock(o.authMode ?? "permissive", o.now);
  const chain = new FakeChain();
  const store = new MemoryStore();
  const sagas = new MemorySagaStore();
  const keys = new KeyStore(mkdtempSync(join(tmpdir(), "bkrn-keys-")));
  const builderKey = await generateKey();
  const builder = new OrderlyBuilderClient({
    baseUrl: BASE,
    mode: o.mode ?? "mock",
    brokerId: BROKER,
    chainId: 31337,
    builderAccountId: BUILDER_ID,
    builderKey,
    keyFor: (id) => keys.opsKeyForAccount(id),
    signer: OPS,
    ledgerAddress: LEDGER,
    fetch: mock.fetch,
    ...(o.now ? { now: o.now } : {}),
  });
  const ctx: OpsContext = {
    settings: {
      mode: o.mode ?? "mock",
      brokerId: BROKER,
      builderAccountId: BUILDER_ID,
      tradeKeyTtlMs: 30 * 86_400_000,
      opsKeyTtlMs: 365 * 86_400_000,
      feeGraceSec: 20,
      feeAuto: true,
      withdrawMaxAttempts: 5,
      priceSource: "builder",
      logMaxRange: 1000n,
      reportMaxDropBps: 5000,
      reportDropConfirmations: 3,
    },
    chain,
    store,
    sagas,
    keys,
    builder,
    readAccount: (accountId, symbol, key) => new OrderlyVenue({ baseUrl: BASE, accountId, symbol, tradeKey: key, mode: o.mode ?? "mock", fetch: mock.fetch }).account(),
    cancelAll: (accountId, symbol, key) => new OrderlyVenue({ baseUrl: BASE, accountId, symbol, tradeKey: key, mode: o.mode ?? "mock", fetch: mock.fetch }).cancelAll(),
    locks: new KeyedMutex(),
    log,
    now: o.now ?? Date.now,
  };
  return { ctx, mock, chain, store, sagas, keys, builder, builderKey };
}
