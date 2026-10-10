// Test fakes: in-process mock-orderly (no network), in-memory chain + store, and an OpsContext factory.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, MockVenue, mulberry32 } from "@bookrunner/mock-orderly";
import { type BookState, createLogger, devAccount, type DomainEventPayloads, type DomainEventType, type ReceiptKind } from "@bookrunner/shared";
import type { Address, Hex } from "viem";
// NOTE: value imports here must also exist in the pre-fix sources (regressions.test.ts runs against both).
import type { AdapterFlowState, AdapterLog, ChainPort, MandateLog, OrderlyBook, SentTx, SimResult, TxState, WithdrawRequestView, WriteOpts } from "../src/chain";
import { OrderlyBuilderClient, OrderlyVenue } from "../src/client";
import { KeyStore } from "../src/keys";
import { generateKey, keyFromSecret } from "../src/orderly/auth";
import { orderlyAccountId } from "../src/orderly/convert";
import type { FetchLike } from "../src/orderly/http";
import { MemorySagaStore, type OpsStore, type VenueAccountKind, type VenueAccountRow, type VenueAccountStatus } from "../src/store";
import { KeyedMutex } from "../src/util";
import { BookRegistry } from "../src/worker/books";
import type { OpsContext, TrackedBook } from "../src/worker/context";
import { FeeSweeper } from "../src/worker/fees";
import { loadOrCreateBuilderKey, Provisioner } from "../src/worker/provision";
import type { SignedVenueReportJson, VenueReportValues } from "../src/report712";
import type { ReportPublisher, ReportSigner } from "../src/worker/context";
import { OpsService } from "../src/worker/service";
import { WithdrawProcessor } from "../src/worker/withdrawals";

/** OrderlyAdapter.WithdrawStatus (mirrors src/chain WITHDRAW_STATUS). */
export const WS = { None: 0, Requested: 1, Confirmed: 2, Cancelled: 3, Failed: 4 } as const;

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
export const VAULT = "0x00000000000000000000000000000000000a0a03" as Address;
export const ROUTER = "0x00000000000000000000000000000000000a0a04" as Address;
/** The book's OrderlyIFAccount (owner of the IF Orderly account; v3 adapters). */
export const IF_OWNER = "0x00000000000000000000000000000000000a0a05" as Address;
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
    vault: VAULT,
    router: ROUTER,
    symbol: SYMBOL,
    baseAsset: "NVDA",
    sessions: `0x${"00".repeat(32)}`,
    underlying: `0x${"00".repeat(32)}`,
    ifTargetUsd: 25_000_000_000n,
    mmInventoryUsd: 75_000_000_000n,
    state,
    accounts: { if: IF_ID, mm: MM_ID },
    owners: { if: IF_OWNER, mm: ADAPTER },
  };
}

/** OrderlyAdapter accounting the services depend on (attribution, earmarks, request statuses). */
export interface FakeAdapterState {
  vault: Address;
  router: Address;
  nonce: bigint;
  requests: Map<string, { status: number; amount: bigint; account: number; requestedAt: bigint }>;
  inTransit: bigint;
  pendingWithdraw: [bigint, bigint];
  pendingFees: bigint;
  feeSwept: Map<string, bigint>;
  lastFlowAt: bigint;
}

/**
 * In-memory chain. The adapter follows OrderlyAdapter's rules: USDC on it is attributed principal-first
 * (up to inTransit), then to earmarked fees (pendingFees), anything else is unattributed and vault-bound;
 * sweepToVault is permissionless (`thirdPartySweep`). `strictReserve` emulates the stricter contract that
 * also holds back requested-but-unconfirmed withdrawals. Failure injection: `failNext[fn]` (reverts before
 * broadcast), `lostReceipt[fn]` (mined, but the receipt wait fails after `onSent`), `after[fn]` (runs right
 * after the tx, e.g. a third party front-running the next step), `txStates` (what `txState` reports).
 */
export class FakeChain implements ChainPort {
  readonly opsAddress = OPS.address;
  readonly usdc = "0x00000000000000000000000000000000000000c0" as Address;
  readonly startBlock = 1n;
  block = 10n;
  calls: Array<{ fn: string; args: unknown[] }> = [];
  balances = new Map<string, bigint>();
  ledger = new Map<string, bigint>();
  vaultFree = 0n; // MockOrderlyVault unallocated USDC
  adapterLogList: AdapterLog[] = [];
  mandateLogList: MandateLog[] = [];
  logQueries: Array<{ from: bigint; to: bigint }> = [];
  adapters = new Map<string, FakeAdapterState>();
  strictReserve = false;
  sweepBlocked = false;
  killed = false;
  cap = 10_000_000_000n;
  failNext: Record<string, string> = {};
  lostReceipt: Record<string, boolean> = {};
  after: Record<string, () => void> = {};
  txStates = new Map<string, TxState>();
  books: OrderlyBook[] = [];
  states = new Map<string, BookState>();
  /** adapter -> its OrderlyIFAccount (IF payouts land there; the adapter pulls them before sweeping/forwarding). */
  ifOwners = new Map<string, Address>([[ADAPTER.toLowerCase(), IF_OWNER]]);
  /** adapter ETH (Orderly deposit fees) and the venue's per-deposit native fee. */
  native = new Map<string, bigint>();
  depositFee = 0n;
  delegateTxs = new Map<string, Hex>();
  /** far-future head so tests' injected clock wins the min(now, head) clamp */
  headTs = 1n << 40n;
  private seq = 0;

  adapter(a: Address): FakeAdapterState {
    const k = a.toLowerCase();
    let s = this.adapters.get(k);
    if (!s) {
      const b = this.books.find((x) => x.adapter.toLowerCase() === k);
      s = { vault: b?.vault ?? VAULT, router: b?.router ?? ROUTER, nonce: 0n, requests: new Map(), inTransit: 0n, pendingWithdraw: [0n, 0n], pendingFees: 0n, feeSwept: new Map(), lastFlowAt: 0n };
      this.adapters.set(k, s);
    }
    return s;
  }
  bal(who: Address | string) {
    return this.balances.get(who.toLowerCase()) ?? 0n;
  }
  private move(from: Address | string | null, to: Address | string, amount: bigint) {
    if (from) {
      if (this.bal(from) < amount) throw new Error("ERC20InsufficientBalance()");
      this.balances.set(from.toLowerCase(), this.bal(from) - amount);
    }
    this.balances.set(to.toLowerCase(), this.bal(to) + amount);
  }

  // ---- tx plumbing
  private begin(fn: string, args: unknown[], opts?: WriteOpts): Hex {
    const err = this.failNext[fn];
    if (err) {
      delete this.failNext[fn];
      throw new Error(err);
    }
    this.calls.push({ fn, args });
    this.block++;
    this.seq++;
    const hash = `0x${this.seq.toString(16).padStart(64, "0")}` as Hex;
    opts?.onSent?.({ hash, nonce: opts.nonce ?? this.seq, at: 0 });
    return hash;
  }
  private end(fn: string, hash: Hex): Hex {
    this.after[fn]?.();
    if (this.lostReceipt[fn]) {
      delete this.lostReceipt[fn];
      throw new Error(`timed out waiting for the receipt of ${hash}`);
    }
    return hash;
  }
  count(fn: string) {
    return this.calls.filter((c) => c.fn === fn).length;
  }
  order(...fns: string[]) {
    return this.calls.filter((c) => fns.includes(c.fn)).map((c) => c.fn);
  }

  /** Vault.recall -> adapter.requestWithdraw: a Requested request + its WithdrawRequested log. */
  requestWithdraw(adapter: Address, account: number, amount: bigint): Extract<AdapterLog, { kind: "WithdrawRequested" }> {
    const a = this.adapter(adapter);
    const nonce = ++a.nonce;
    a.requests.set(nonce.toString(), { status: WS.Requested, amount, account, requestedAt: 0n });
    a.pendingWithdraw[account as 0 | 1] += amount;
    this.block++;
    const l = { kind: "WithdrawRequested" as const, adapter, account, amount, nonce, block: this.block, txHash: `0x${"ee".repeat(31)}${nonce.toString(16).padStart(2, "0")}` as Hex, logIndex: 0 };
    this.adapterLogList.push(l);
    return l;
  }
  /** Anyone calling the permissionless adapter.sweepToVault (not one of ops-venue's txs). */
  thirdPartySweep(adapter: Address): bigint {
    return this.applySweep(adapter);
  }
  /** OrderlyAdapter._pullIfAccount: USDC paid to the IF account contract moves to the adapter. */
  private pull(adapter: Address) {
    const ifo = this.ifOwners.get(adapter.toLowerCase());
    if (ifo && this.bal(ifo) > 0n) this.move(ifo, adapter, this.bal(ifo));
  }
  /** Adapter USDC incl. payouts parked on its IF account contract. */
  attributed(adapter: Address): bigint {
    const ifo = this.ifOwners.get(adapter.toLowerCase());
    return this.bal(adapter) + (ifo ? this.bal(ifo) : 0n);
  }
  private applySweep(adapter: Address, dry = false): bigint {
    if (!dry) this.pull(adapter);
    const a = this.adapter(adapter);
    const bal = this.attributed(adapter);
    const principal = bal < a.inTransit ? bal : a.inTransit;
    const pend = this.strictReserve ? a.pendingWithdraw[0] + a.pendingWithdraw[1] : 0n;
    const held = bal - principal < pend ? bal - principal : pend;
    const free = bal - principal - held;
    const feeReserved = a.pendingFees < free ? a.pendingFees : free;
    const amount = bal - held - feeReserved;
    if (amount === 0n) return 0n;
    if (principal !== 0n && this.sweepBlocked) throw new Error("SweepBlockedUntilMark(1, 0)");
    if (dry) return amount;
    a.inTransit -= principal;
    this.move(adapter, a.vault, amount);
    return amount;
  }
  private forwardable(adapter: Address): bigint {
    const a = this.adapter(adapter);
    const bal = this.attributed(adapter);
    const reserved = a.inTransit + (this.strictReserve ? a.pendingWithdraw[0] + a.pendingWithdraw[1] : 0n);
    const avail = bal - (bal < reserved ? bal : reserved);
    return a.pendingFees < avail ? a.pendingFees : avail;
  }
  private applyForward(adapter: Address): bigint {
    const a = this.adapter(adapter);
    const amt = this.forwardable(adapter);
    if (amt === 0n) return 0n;
    this.pull(adapter);
    a.pendingFees -= amt;
    this.move(adapter, a.router, amt);
    return amt;
  }

  // ---- reads
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
  async accountOwners(adapter: Address) {
    return { if: this.ifOwners.get(adapter.toLowerCase()) ?? adapter, mm: adapter };
  }
  async nativeFeeState(adapter: Address, deposits: Array<{ account: number; amount: bigint }>) {
    return { balance: this.native.get(adapter.toLowerCase()) ?? 0n, required: this.depositFee * BigInt(deposits.length) };
  }
  async fundNative(adapter: Address, value: bigint, opts?: WriteOpts) {
    const h = this.begin("fundNative", [adapter, value], opts);
    this.native.set(adapter.toLowerCase(), (this.native.get(adapter.toLowerCase()) ?? 0n) + value);
    return this.end("fundNative", h);
  }
  async delegateTx(delegateContract: Address) {
    return this.delegateTxs.get(delegateContract.toLowerCase()) ?? null;
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
    return this.bal(who);
  }
  async blockNumber() {
    return this.block;
  }
  async adapterLogs(adapters: Address[], from: bigint, to: bigint) {
    this.logQueries.push({ from, to });
    const set = new Set(adapters.map((a) => a.toLowerCase()));
    return this.adapterLogList.filter((l) => set.has(l.adapter.toLowerCase()) && l.block >= from && l.block <= to);
  }
  async mandateLogs(mandates: Address[], from: bigint, to: bigint) {
    const set = new Set(mandates.map((a) => a.toLowerCase()));
    return this.mandateLogList.filter((l) => set.has(l.mandate.toLowerCase()) && l.block >= from && l.block <= to);
  }
  async withdrawStatus(adapter: Address, nonce: bigint): Promise<WithdrawRequestView> {
    const r = this.adapter(adapter).requests.get(nonce.toString());
    return r ? { status: r.status, amount: r.amount, account: r.account, requestedAt: r.requestedAt } : { status: WS.None, amount: 0n, account: 0, requestedAt: 0n };
  }
  async adapterFlowState(adapter: Address): Promise<AdapterFlowState> {
    const a = this.adapter(adapter);
    return { lastFlowAt: a.lastFlowAt, pendingWithdrawUsd: a.pendingWithdraw[0] + a.pendingWithdraw[1], inTransitUsd: a.inTransit, pendingFeesUsd: a.pendingFees, usdcBalance: this.attributed(adapter) };
  }
  async feeSweptForPeriod(adapter: Address, period: bigint) {
    return this.adapter(adapter).feeSwept.get(period.toString()) ?? 0n;
  }
  async forwardableFees(adapter: Address) {
    return this.forwardable(adapter);
  }
  async txState(tx: SentTx): Promise<TxState> {
    return this.txStates.get(tx.hash) ?? "success";
  }
  async vaultLedger(accountId: Hex) {
    return this.ledger.get(accountId.toLowerCase()) ?? 0n;
  }
  async headTimestamp() {
    return this.headTs;
  }

  // ---- writes
  async report(adapter: Address, i: bigint, m: bigint, e: bigint, asOf: bigint) {
    const h = this.begin("report", [adapter, i, m, e, asOf]);
    return this.end("report", h);
  }
  /** pre-fix ChainPort surface (kept so the regression tests also run against the old saga code) */
  async simulateConfirmWithdraw(adapter: Address, nonce: bigint): Promise<SimResult> {
    const r = this.adapter(adapter).requests.get(nonce.toString());
    if (!r || r.status !== WS.Requested) return { ok: false, error: `RequestNotPending(${nonce}, ${r?.status ?? 0})` };
    return { ok: true };
  }
  async confirmWithdraw(adapter: Address, nonce: bigint, opts?: WriteOpts) {
    const a = this.adapter(adapter);
    const r = a.requests.get(nonce.toString());
    if (!r || r.status !== WS.Requested) throw new Error(`RequestNotPending(${nonce}, ${r?.status ?? 0})`);
    const h = this.begin("confirmWithdraw", [adapter, nonce], opts);
    r.status = WS.Confirmed;
    a.pendingWithdraw[r.account as 0 | 1] -= r.amount;
    a.inTransit += r.amount;
    a.lastFlowAt = this.headTs;
    return this.end("confirmWithdraw", h);
  }
  async cancelWithdraw(adapter: Address, nonce: bigint, opts?: WriteOpts) {
    const a = this.adapter(adapter);
    const r = a.requests.get(nonce.toString());
    if (!r || r.status !== WS.Requested) throw new Error(`RequestNotPending(${nonce}, ${r?.status ?? 0})`);
    const h = this.begin("cancelWithdraw", [adapter, nonce], opts);
    r.status = WS.Cancelled;
    a.pendingWithdraw[r.account as 0 | 1] -= r.amount;
    return this.end("cancelWithdraw", h);
  }
  async failWithdraw(adapter: Address, nonce: bigint, opts?: WriteOpts) {
    const a = this.adapter(adapter);
    const r = a.requests.get(nonce.toString());
    if (!r || r.status !== WS.Confirmed) throw new Error(`RequestNotConfirmed(${nonce}, ${r?.status ?? 0})`);
    const h = this.begin("failWithdraw", [adapter, nonce], opts);
    r.status = WS.Failed;
    a.inTransit -= a.inTransit < r.amount ? a.inTransit : r.amount;
    a.lastFlowAt = this.headTs;
    return this.end("failWithdraw", h);
  }
  async sweepToVault(adapter: Address, opts?: WriteOpts) {
    if (this.attributed(adapter) === 0n) return null;
    this.applySweep(adapter, true); // simulation: a closed mark-window gate reverts before broadcast
    const h = this.begin("sweepToVault", [adapter, this.attributed(adapter)], opts);
    this.applySweep(adapter);
    return this.end("sweepToVault", h);
  }
  async sweepFees(adapter: Address, period: bigint, amount: bigint, opts?: WriteOpts) {
    const a = this.adapter(adapter);
    if (amount > this.cap) throw new Error("FeeSweepAboveCap()");
    if (a.feeSwept.has(period.toString())) throw new Error("PeriodAlreadySwept()");
    const txHash = this.begin("sweepFees", [adapter, period, amount], opts);
    a.feeSwept.set(period.toString(), amount);
    a.pendingFees += amount;
    this.adapterLogList.push({ kind: "FeesSwept", adapter, period, amount, block: this.block, txHash, logIndex: 3 });
    this.applyForward(adapter);
    this.end("sweepFees", txHash);
    return { txHash, logIndex: 3 };
  }
  async forwardPendingFees(adapter: Address, opts?: WriteOpts) {
    const txHash = this.begin("forwardPendingFees", [adapter], opts);
    const forwarded = this.applyForward(adapter);
    this.end("forwardPendingFees", txHash);
    return { txHash, forwarded };
  }
  async mockVaultMint(amount: bigint, opts?: WriteOpts) {
    const h = this.begin("mint", [amount], opts);
    this.vaultFree += amount;
    return this.end("mint", h);
  }
  async vaultCreditFees(accountId: Hex, amount: bigint, opts?: WriteOpts) {
    const h = this.begin("creditFees", [accountId, amount], opts);
    // lenient: the pre-fix code minted inside this call, so a missing mint is not modelled as a revert
    this.vaultFree -= this.vaultFree < amount ? this.vaultFree : amount;
    this.ledger.set(accountId.toLowerCase(), (this.ledger.get(accountId.toLowerCase()) ?? 0n) + amount);
    return this.end("creditFees", h);
  }
  async vaultOperatorWithdraw(accountId: Hex, to: Address, amount: bigint, opts?: WriteOpts) {
    const led = this.ledger.get(accountId.toLowerCase()) ?? 0n;
    if (led < amount) throw new Error("InsufficientLedger()");
    const h = this.begin("operatorWithdraw", [accountId, to, amount], opts);
    this.ledger.set(accountId.toLowerCase(), led - amount);
    this.move(null, to, amount);
    return this.end("operatorWithdraw", h);
  }
  async usdcTransfer(to: Address, amount: bigint, opts?: WriteOpts) {
    if (this.bal(this.opsAddress) < amount) throw new Error("ERC20InsufficientBalance()");
    const h = this.begin("usdcTransfer", [to, amount], opts);
    this.move(this.opsAddress, to, amount);
    return this.end("usdcTransfer", h);
  }
  mockAccounts = new Set<string>();
  async ensureMockAccount(accountId: Hex) {
    if (this.mockAccounts.has(accountId.toLowerCase())) return;
    this.mockAccounts.add(accountId.toLowerCase());
    this.end("ensureMockAccount", this.begin("ensureMockAccount", [accountId]));
  }
  /** OrderlyAdapter implementation has reportSigned (false = pre-low-gas adapter); "throw" = RPC failure. */
  reportSignedSupported: boolean | "throw" = true;
  async supportsReportSigned() {
    if (this.reportSignedSupported === "throw") throw new Error("rpc down");
    return this.reportSignedSupported;
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

/** In-memory ReportPublisher (latest + every published report). Inline: see the NOTE on value imports. */
export class TestReportPublisher implements ReportPublisher {
  readonly latest = new Map<number, SignedVenueReportJson>();
  readonly published: SignedVenueReportJson[] = [];
  fail: string | null = null;
  async publish(r: SignedVenueReportJson) {
    if (this.fail) throw new Error(this.fail);
    this.published.push(r);
    this.latest.set(r.bookId, r);
  }
}

/** OPS-key VenueReport signer (same typed data as src/report712.ts; cross-checked in report712.test.ts). */
export const testReportSigner = (chainId = 31337): ReportSigner => ({
  address: OPS.address,
  chainId,
  sign: (adapter: Address, r: VenueReportValues) =>
    OPS.signTypedData({
      domain: { name: "Bookrunner OrderlyAdapter", version: "1", chainId, verifyingContract: adapter },
      types: {
        VenueReport: [
          { name: "insuranceUsd", type: "uint256" },
          { name: "marginUsd", type: "int256" },
          { name: "netExposureUsd", type: "int256" },
          { name: "asOf", type: "uint64" },
        ],
      },
      primaryType: "VenueReport",
      message: { insuranceUsd: r.insuranceUsd, marginUsd: r.marginUsd, netExposureUsd: r.netExposureUsd, asOf: r.asOf },
    }),
});

/**
 * Test context. `reportMode` defaults to "onchain" (the scenarios below assert report txs); the service
 * default is OPS_REPORT_MODE=signed (see report712.test.ts for the signed flow).
 */
export async function makeCtx(o: { mode?: "mock" | "live"; authMode?: "strict" | "permissive"; now?: () => number; reportMode?: "signed" | "onchain" } = {}) {
  const mock = makeMock(o.authMode ?? "permissive", o.now);
  const chain = new FakeChain();
  const store = new MemoryStore();
  const sagas = new MemorySagaStore();
  const reports = new TestReportPublisher();
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
      reportSettleSec: 30,
      reportMode: o.reportMode ?? "onchain",
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
    reportSigner: testReportSigner(31337),
    reportPublisher: reports,
  };
  return { ctx, mock, chain, store, sagas, keys, builder, builderKey, reports };
}

const provisioner = async (t: Awaited<ReturnType<typeof makeCtx>>) => new Provisioner(t.ctx, await loadOrCreateBuilderKey(t.keys, BUILDER_ID, undefined, 86_400_000, keyFromSecret));

/** Withdraw saga fixture: provisioned book (IF 25k / MM 75k on the venue and in the mock vault ledger). */
export async function setupWithdraw(state: "Live" | "Retiring" = "Live", authMode: "strict" | "permissive" = "permissive") {
  const t = await makeCtx({ authMode });
  const reg = new BookRegistry(t.ctx);
  t.chain.books = [trackedBook(state)];
  t.chain.states.set(trackedBook().book.toLowerCase(), state);
  await reg.refresh();
  await (await provisioner(t)).ensure(reg.list()[0] as TrackedBook);
  t.mock.venue.credit(IF_ID, 25_000_000_000);
  t.mock.venue.credit(MM_ID, 75_000_000_000);
  t.mock.venue.setPrice("NVDA", 190, false);
  t.chain.ledger.set(MM_ID, 75_000_000_000n);
  t.chain.ledger.set(IF_ID, 25_000_000_000n);
  const wp = new WithdrawProcessor(t.ctx, reg);
  return { ...t, reg, wp, adapterState: () => t.chain.adapter(ADAPTER) };
}

/** Fee saga fixture: one completed mark period with a 3.00 USDC builder fee settlement. */
export async function setupFees() {
  let now = 1_700_000_400_000;
  const t = await makeCtx({ now: () => now });
  t.chain.books = [trackedBook()];
  const reg = new BookRegistry(t.ctx);
  await reg.refresh();
  await (await provisioner(t)).ensure(reg.list()[0] as TrackedBook);
  const v = t.mock.venue;
  v.credit(IF_ID, 25_000_000_000);
  v.credit(MM_ID, 75_000_000_000);
  v.setPrice("NVDA", 200, false);
  // 10,000 notional of taker flow -> 6.00 base taker fee -> 3.00 builder share
  v.placeOrder({ accountId: MM_ID, keyId: null }, { symbol: SYMBOL, order_type: "LIMIT", side: "SELL", order_price: 200, order_quantity: 50 });
  v.externalTaker(SYMBOL, "BUY", 50);
  const period = Math.floor(now / 1000 / 300) * 300 + 300;
  now = period * 1000 + 1000; // period complete
  v.settleDue();
  return { ...t, reg, sweeper: new FeeSweeper(t.ctx, reg), period, advance: (ms: number) => (now += ms) };
}

/** Reporting fixture: full OpsService, venue funded, chain head in step with the injected clock. */
export async function setupReporting(reportMode: "signed" | "onchain" = "onchain") {
  let now = 1_800_000_000_000;
  const t = await makeCtx({ now: () => now, reportMode });
  t.chain.books = [trackedBook()];
  const svc = new OpsService(t.ctx, await provisioner(t));
  await svc.syncBooks();
  t.mock.venue.credit(IF_ID, 25_000_000_000);
  t.mock.venue.credit(MM_ID, 75_000_000_000);
  t.mock.venue.setPrice("NVDA", 190, false);
  t.chain.ledger.set(MM_ID, 75_000_000_000n);
  t.chain.headTs = BigInt(now / 1000);
  const tick = (sec: number) => {
    now += sec * 1000;
    t.chain.headTs += BigInt(sec);
  };
  return { ...t, svc, tick, book: () => svc.registry.list()[0] as TrackedBook };
}
