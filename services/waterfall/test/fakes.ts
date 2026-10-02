import { type BookState, type SplitResult, VENUE, splitDistribution } from "@bookrunner/shared";
import type { Hex } from "viem";
import type { BookRef } from "../src/kit/books";
import type {
  BookLookup,
  BuybackChain,
  DistributedLog,
  KeeperChain,
  KeeperSnapshot,
  SettlementChain,
  SettlementReceivedLog,
  SettlementStore,
  SplitParams,
  StoredDistribution,
  SweepJobState,
  VenueOps,
} from "../src/ports";

export const ZERO = "0x0000000000000000000000000000000000000000" as const;

export function bookRef(bookId: number, venue: 0 | 1 = VENUE.POOL_ENGINE): BookRef {
  const a = (n: number) => `0x${(bookId * 16 + n).toString(16).padStart(40, "0")}` as `0x${string}`;
  return { bookId, venue, components: { book: a(1), senior: a(2), junior: a(3), vault: a(4), mandate: a(5), router: a(6), desk: a(7), adapter: a(8) } };
}

export class FakeBooks implements BookLookup {
  constructor(private readonly refs: BookRef[]) {}
  async get(id: number) {
    return this.refs.find((r) => r.bookId === id);
  }
}

let txn = 0;
export const fakeHash = (): Hex => `0x${(++txn).toString(16).padStart(64, "0")}`;

export class FakeSettlementChain implements SettlementChain {
  state: BookState = "Live";
  distributed = new Map<string, DistributedLog>();
  swept = new Set<string>();
  params: SplitParams = { pendingGross: 1_000_000_000n, expenseCapBps: 2000n, carryBps: 1000n, seniorHurdleBps: 6000n, seniorSupply: 70_000_000_000n, juniorSupply: 30_000_000_000n };
  calls: string[] = [];
  /** Simulate a router that diverges from the normative split (parity break). */
  tamper?: (s: SplitResult) => SplitResult;
  /** Make distribute() revert; optionally record the period as distributed first (race). */
  failDistribute?: "revert" | "race";
  /** Fee flow arriving at the router during the sweep. */
  sweepAdds = 0n;

  async bookState() {
    return this.state;
  }
  async findDistributed(ref: BookRef, period: number) {
    this.calls.push("findDistributed");
    return this.distributed.get(`${ref.bookId}:${period}`) ?? null;
  }
  sweepTx = new Map<string, Hex>();
  /** Fee settlement ops-venue swept (Orderly), keyed by tx. */
  receivedByTx = new Map<Hex, SettlementReceivedLog[]>();
  async feesSwept(ref: BookRef, period: number) {
    const k = `${ref.bookId}:${period}`;
    if (!this.swept.has(k)) return null;
    if (!this.sweepTx.has(k)) this.sweepTx.set(k, fakeHash());
    return this.sweepTx.get(k) as Hex;
  }
  async receivedInTx(_ref: BookRef, txHash: Hex) {
    return this.receivedByTx.get(txHash) ?? [];
  }
  /** Orderly: FeesSwept amount per earmark tx (default: what the earmark tx itself forwarded). */
  earmarked = new Map<Hex, bigint>();
  /** Router SettlementReceived logs after each earmark (ops-venue's forwardPendingFees txs). */
  forwardedAfter = new Map<Hex, SettlementReceivedLog[]>();
  /** adapter.pendingFeesUsd (default 0: no earmark outstanding). */
  pendingFees = 0n;
  feeForwardingCalls = 0;
  async feeForwarding(_ref: BookRef, txHash: Hex) {
    this.feeForwardingCalls++;
    const own = this.receivedByTx.get(txHash) ?? [];
    const later = this.forwardedAfter.get(txHash) ?? [];
    return { earmarked: this.earmarked.get(txHash) ?? own.reduce((a, r) => a + r.amount, 0n), received: [...own, ...later], pendingFees: this.pendingFees };
  }
  /** Earmark `amount` for (book, period) with no USDC on the adapter yet (FeesSwept forwards nothing). */
  async earmark(ref: BookRef, period: number, amount: bigint): Promise<Hex> {
    this.swept.add(`${ref.bookId}:${period}`);
    const tx = (await this.feesSwept(ref, period)) as Hex;
    this.earmarked.set(tx, amount);
    this.pendingFees += amount;
    return tx;
  }
  /** ops-venue's forwardPendingFees after the earmark `tx`: USDC -> router, SettlementReceived(VENUE_TAKER_SHARE). */
  forward(earmarkTx: Hex, amount: bigint) {
    const log: SettlementReceivedLog = { source: 0, amount, txHash: fakeHash(), logIndex: 2, blockNumber: 11n, ts: new Date() };
    this.forwardedAfter.set(earmarkTx, [...(this.forwardedAfter.get(earmarkTx) ?? []), log]);
    this.params.pendingGross += amount;
    this.pendingFees -= amount;
  }
  async sweepEngineFees(ref: BookRef, period: number) {
    this.calls.push("sweepEngineFees");
    this.swept.add(`${ref.bookId}:${period}`);
    this.params.pendingGross += this.sweepAdds;
    const received: SettlementReceivedLog[] = this.sweepAdds ? [{ source: 1, amount: this.sweepAdds, txHash: fakeHash(), logIndex: 0, blockNumber: 1n, ts: new Date() }] : [];
    return { hash: fakeHash(), received };
  }
  /** PoolEngine fees accrued (null = unreadable: the runner sweeps anyway). */
  engineFees: bigint | null = null;
  async engineFeesAccrued() {
    this.calls.push("engineFeesAccrued");
    return this.engineFees;
  }
  async splitParams() {
    return { ...this.params };
  }
  async previewOnChain(_ref: BookRef, gross: bigint, expenses: bigint) {
    return splitDistribution({ ...this.params, gross, expensesRequested: expenses });
  }
  async distribute(ref: BookRef, period: number, expenses: bigint) {
    this.calls.push("distribute");
    const k = `${ref.bookId}:${period}`;
    if (this.failDistribute === "race") {
      this.distributed.set(k, this.log(ref, period, splitDistribution({ ...this.params, gross: this.params.pendingGross, expensesRequested: expenses })));
      throw new Error("execution reverted: AlreadyDistributed");
    }
    if (this.failDistribute === "revert") throw new Error("execution reverted");
    if (this.distributed.has(k)) throw new Error("execution reverted: already distributed");
    let amounts = splitDistribution({ ...this.params, gross: this.params.pendingGross, expensesRequested: expenses });
    if (this.tamper) amounts = this.tamper(amounts);
    const d = this.log(ref, period, amounts);
    this.distributed.set(k, d);
    this.params.pendingGross = 0n;
    return { hash: d.txHash, distributed: d };
  }
  private log(ref: BookRef, period: number, amounts: SplitResult): DistributedLog {
    return { bookId: ref.bookId, period, amounts, txHash: fakeHash(), logIndex: 3, blockNumber: 10n, ts: new Date(period * 1000 + 5000) };
  }
}

export class FakeSettlementStore implements SettlementStore {
  rows = new Map<string, StoredDistribution & { logIndex: number }>();
  received: SettlementReceivedLog[] = [];
  async distributionFor(bookId: number, period: number) {
    return this.rows.get(`${bookId}:${period}`) ?? null;
  }
  async insertDistribution(d: DistributedLog) {
    const k = `${d.bookId}:${d.period}`;
    if (!this.rows.has(k)) this.rows.set(k, { txHash: d.txHash, amounts: d.amounts, logIndex: d.logIndex });
  }
  async insertReceived(_bookId: number, _period: number, logs: SettlementReceivedLog[]) {
    this.received.push(...logs);
  }
}

export class FakeVenueOps implements VenueOps {
  enqueued: string[] = [];
  state: SweepJobState = "pending";
  onEnqueue?: () => void;
  async enqueueSweep(bookId: number, period: number) {
    this.enqueued.push(`${bookId}:${period}`);
    this.onEnqueue?.();
  }
  async sweepJobState() {
    return this.state;
  }
}

export class FakeBuybackChain implements BuybackChain {
  pending = 0n;
  /** BKRN per USDC unit of the router quote (WAD), or null = the router has no quote. */
  quoteWad: bigint | null = 20n * 10n ** 18n;
  failQuote = false;
  failExecute = false;
  executed: Array<{ amountIn: bigint; minOut: bigint; poolFee: number }> = [];
  async buybackPending() {
    return this.pending;
  }
  async quoteBuyback(amountIn: bigint) {
    if (this.failQuote) throw new Error("quote reverted");
    return this.quoteWad === null ? null : (amountIn * this.quoteWad) / 10n ** 6n;
  }
  async executeBuyback(amountIn: bigint, minOut: bigint, poolFee: number) {
    if (this.failExecute) throw new Error("execution reverted: InsufficientOutput");
    this.executed.push({ amountIn, minOut, poolFee });
    const bkrnOut = this.quoteWad === null ? minOut : (amountIn * this.quoteWad) / 10n ** 6n;
    this.pending -= amountIn;
    return { hash: fakeHash(), usdcIn: amountIn, bkrnOut };
  }
}

export class FakeKeeperChain implements KeeperChain {
  snap: KeeperSnapshot = {
    state: "Live",
    nowSec: 1_790_000_150,
    markInterval: 300,
    subscriptionEnds: 1_789_990_000,
    unfundedClaims: 0n,
    vaultIdle: 1_000_000_000n,
    inTransit: 0n,
    pendingWithdraw: 0n,
    mmWithdrawable: null,
    insuranceEquity: 25_000_000_000n,
    marginEquity: 75_000_000_000n,
    netExposure: 0n,
    sharePriceWad: { senior: 10n ** 18n, junior: 10n ** 18n },
    lastMarkPeriodEnd: 1_789_999_800,
    lastMark: null,
  };
  pending = { senior: 0n, junior: 0n };
  pendingArgs: Array<[bigint, bigint]> = [];
  sent: string[] = [];
  failing = new Set<string>();

  async snapshot() {
    return { ...this.snap };
  }
  async pendingRedemptions(_ref: BookRef, after: bigint, upTo: bigint) {
    this.pendingArgs.push([after, upTo]);
    return { ...this.pending };
  }
  private tx(name: string) {
    if (this.failing.has(name)) throw new Error(`execution reverted: ${name} failed`);
    this.sent.push(name);
    return fakeHash();
  }
  async closeWindow() {
    return this.tx("closeWindow");
  }
  async fundClaims() {
    return this.tx("fundClaims");
  }
  async recall(_ref: BookRef, account: number, amount: bigint) {
    return this.tx(`recall:${account}:${amount}`);
  }
  async finalizeRetirement() {
    return this.tx("finalizeRetirement");
  }
}
