import { type MarkInput, type MarkPnl, VENUE, WAD, usd } from "@bookrunner/shared";
import type { BookRef } from "@bookrunner/waterfall";
import type { Address, Hex } from "viem";
import type { AdapterReportState } from "../../ops-venue/src/report712";
import type { SignedPrice } from "../src/domain/prices";
import type { MarkSnapshot } from "../src/domain/types";
import type { AtomicMarkResult, CommittedMark, MarkAppliedEvent, MarkChain, MarkRow, MarkStore, ReceiptsRootPort, SimulationResult, StoredMark } from "../src/ports";

export const P = 1_790_000_100; // multiple of 300
export const USDC = "0x00000000000000000000000000000000000000c1" as Address;
export const NVDA = "0x00000000000000000000000000000000000000a1" as Address;
export const TSLA = "0x00000000000000000000000000000000000000a2" as Address;

export function ref(bookId = 1, venue: 0 | 1 = VENUE.ORDERLY): BookRef {
  const a = (n: number) => `0x${(bookId * 16 + n).toString(16).padStart(40, "0")}` as Address;
  return { bookId, venue, components: { book: a(1), senior: a(2), junior: a(3), vault: a(4), mandate: a(5), router: a(6), desk: a(7), adapter: a(8) } };
}

export function snapshot(over: Partial<MarkSnapshot> = {}): MarkSnapshot {
  return {
    bookId: 1,
    blockNumber: 100n,
    blockTimestamp: P + 30,
    usdc: USDC,
    vaultIdle: usd("2000"),
    vaultIdleView: usd("2000"),
    unfundedClaims: 0n,
    flowNonce: 7n,
    venue: {
      insuranceUsd: usd("25000"),
      marginUsd: usd("75500"),
      netExposureUsd: -usd("10000"),
      inTransitUsd: 0n,
      deployedValueUsd: usd("100500"),
      valuationAt: P - 10,
      poolCashUsd: null,
      poolEquityUsd: null,
    },
    desk: {
      usdc: usd("500"),
      positions: [
        { token: NVDA, ticker: "NVDA", qtyRaw: 40n * 10n ** 18n, priceWad: 190n * WAD, multiplierWad: WAD, decimals: 18, valueUsd: usd("7600"), priceStale: false },
      ],
      onchainValueUsd: usd("8100"),
      hedgeNotionalUsd: usd("7600"),
    },
    book: {
      state: "Live",
      seniorNav: usd("70000"),
      juniorNav: usd("30000"),
      seniorImpairment: 0n,
      perfIndex: WAD,
      highWater: WAD,
      seniorSupply: usd("70000"),
      juniorSupply: usd("30000"),
      lastMarkPeriodEnd: P - 300,
    },
    backstopBalance: usd("5000"),
    mandate: {
      maxInventoryUsd: usd("50000"),
      maxSkewBps: 25,
      minQuoteWidthBps: 8,
      maxHedgeLeverage: 100,
      hedgeRatioMinBps: 5000,
      hedgeRatioMaxBps: 12000,
      noNewRiskOffHours: true,
      killAtDrawdownBps: -800,
      hedgeAllowRoot: `0x${"00".repeat(32)}` as Hex,
    },
    killed: false,
    underlyingPrice: { priceId: `0x${"4e56444100".padEnd(64, "0")}` as Hex, priceWad: 190n * WAD, publishedAt: P - 5, held: false },
    ...over,
  };
}

let h = 0;
const hash = (): Hex => `0x${(++h).toString(16).padStart(64, "0")}`;

/** In-memory MarkRegistry + Book. */
export class FakeMarkChain implements MarkChain {
  snap = snapshot();
  snapshots = 0;
  /** Book flowNonce timeline: each flowNonce() call consumes the next value (capital flows happening). */
  nonces: bigint[] = [];
  private currentNonce: bigint | null = null;
  lastPeriodEnd = P - 300;
  marks: CommittedMark[] = [];
  applyCalls = 0;
  commitCalls = 0;
  failApply = false;
  /** MarkRegistry has commitAndApply (default false: the pre-low-gas two-tx path). */
  atomic = false;
  supportsCalls = 0;
  /** simulation outcome per (priceData, venueReport): an error name reverts that variant */
  simulateError: (priceData: Hex, venueReport: Hex) => string | null = () => null;
  /** the registry reverts with no data (function missing) */
  simulateUnsupported = false;
  simulations: Array<{ priceData: Hex; venueReport: Hex }> = [];
  atomicCalls: Array<{ priceData: Hex; venueReport: Hex; input: MarkInput }> = [];
  /** throw from commitAndApply (after a successful simulation) */
  failAtomic: string[] = [];
  reportState: AdapterReportState | null = { valuationAt: BigInt(P - 10), lastFlowAt: 0n, pendingWithdrawUsd: 0n };
  /** prices handed to snapshot() */
  lastPrices: ReadonlyMap<string, SignedPrice> | undefined;

  async head() {
    return { blockNumber: 100n, timestamp: P + 30 };
  }
  async markInterval() {
    return 300;
  }
  async maxMarkAge() {
    return 3600;
  }
  private get nonce(): bigint {
    return this.currentNonce ?? this.snap.flowNonce;
  }
  async snapshot(_ref: BookRef, _block: bigint, prices?: ReadonlyMap<string, SignedPrice>) {
    this.snapshots++;
    this.lastPrices = prices;
    // the real adapter returns the signed prices it valued with; the fake values with every one handed in
    const signedPrices = prices && prices.size ? [...prices.values()] : (this.snap.signedPrices ?? []);
    return { ...this.snap, flowNonce: this.nonce, signedPrices };
  }
  async supportsCommitAndApply() {
    this.supportsCalls++;
    return this.atomic;
  }
  async simulateCommitAndApply(_ref: BookRef, _input: MarkInput, _sig: Hex, priceData: Hex, venueReport: Hex): Promise<SimulationResult> {
    this.simulations.push({ priceData, venueReport });
    if (this.simulateUnsupported) return { ok: false, error: "execution reverted", unsupported: true };
    const err = this.simulateError(priceData, venueReport);
    return err ? { ok: false, error: err, unsupported: false } : { ok: true };
  }
  async commitAndApply(ref: BookRef, input: MarkInput, sig: Hex, priceData: Hex, venueReport: Hex): Promise<AtomicMarkResult> {
    this.atomicCalls.push({ priceData, venueReport, input });
    const fail = this.failAtomic.shift();
    if (fail) throw new Error(fail);
    if (this.nonce !== input.flowNonce) throw new Error("execution reverted: FlowNonceMismatch");
    const c = await this.commit(input, sig);
    this.commitCalls--; // counted as an atomic call, not a commit tx
    const a = await this.applyMark(ref, c.markId);
    this.applyCalls--;
    return { hash: a.hash, markId: c.markId, committedAt: c.committedAt, applied: a.applied };
  }
  async adapterReportState() {
    return this.reportState;
  }
  async flowNonce() {
    const next = this.nonces.shift();
    if (next !== undefined) this.currentNonce = next;
    return this.nonce;
  }
  async lastMarkPeriodEnd() {
    return this.lastPeriodEnd;
  }
  async latestCommitted() {
    return this.marks[this.marks.length - 1] ?? null;
  }
  async hashMark() {
    return null;
  }
  async commit(input: MarkInput, _sig: Hex) {
    this.commitCalls++;
    const last = this.marks[this.marks.length - 1];
    if (last && Number(input.periodEnd) <= last.periodEnd) throw new Error("execution reverted: PeriodNotNewer");
    const m: CommittedMark = { markId: BigInt(this.marks.length + 1), periodEnd: Number(input.periodEnd), applied: false, input, signer: USDC };
    this.marks.push(m);
    return { hash: hash(), markId: m.markId, committedAt: new Date((P + 31) * 1000) };
  }
  async commitTxOf() {
    return null;
  }
  async applyMark(_ref: BookRef, markId: bigint): Promise<{ hash: Hex; applied: MarkAppliedEvent }> {
    this.applyCalls++;
    if (this.failApply) throw new Error("execution reverted");
    const m = this.marks.find((x) => x.markId === markId);
    if (!m) throw new Error("no mark");
    m.applied = true;
    this.lastPeriodEnd = m.periodEnd;
    return { hash: hash(), applied: { markId, navUsd: m.input.navUsd, pnlUsd: 0n, seniorNav: usd("70000"), juniorNav: m.input.navUsd - usd("70000"), seniorPrice: WAD, juniorPrice: WAD } };
  }
}

export class FakeMarkStore implements MarkStore {
  rows = new Map<number, MarkRow & { appliedTx?: Hex }>();
  bookNav = new Map<number, bigint>();
  dist: { senior: bigint; junior: bigint; txHash: string } | null = { senior: usd("6"), junior: usd("4"), txHash: "0xd" };
  failSave = 0;
  async distribution() {
    return this.dist;
  }
  async fundingInPeriod() {
    return 0n;
  }
  async prevUnrealized() {
    return 0n;
  }
  async lastQuoteSkewBps() {
    return 5;
  }
  async markForPeriod(bookId: number, periodEnd: number): Promise<StoredMark | null> {
    for (const r of this.rows.values()) {
      if (r.bookId === bookId && r.periodEnd === periodEnd) return { markId: r.markId, pnl: r.pnl as MarkPnl, commitTx: r.commitTx, appliedTx: r.appliedTx ?? null, receiptsRoot: r.input.receiptsRoot };
    }
    return null;
  }
  async saveCommitted(r: MarkRow) {
    if (this.failSave > 0) {
      this.failSave--;
      throw new Error("db down");
    }
    this.rows.set(r.markId, { ...r });
  }
  async saveApplied(markId: number, appliedTx: Hex) {
    const r = this.rows.get(markId);
    if (r) r.appliedTx = appliedTx;
  }
  async updateBookNav(bookId: number, _markId: number, ev: MarkAppliedEvent) {
    this.bookNav.set(bookId, ev.navUsd);
  }
}

export class FakeReceipts implements ReceiptsRootPort {
  complete = true;
  async periodRoot() {
    return { root: `0x${"ab".repeat(32)}` as Hex, complete: this.complete, windows: 5, receipts: 12 };
  }
}
