// Builder fee settlement per mark period: read the venue's builder fee settlements, withdraw the
// amount from the builder account to the book's adapter, then adapter.sweepFees(period, amount) ->
// RevenueRouter. Exactly once per (book, period): saga store + on-chain FeesSwept(period) logs +
// settlements table checks.
import type { Address } from "viem";
import { advanceFee, completedPeriods, type FeeSaga, feeInFlight, feeSagaKey, periodReady, planFeeSweep, type SettlementRow } from "../domain/fees";
import { reportableState } from "../domain/report";
import { errMsg, nowSec } from "../util";
import type { BookRegistry } from "./books";
import type { OpsContext, TrackedBook } from "./context";

interface SweptLedger {
  scannedTo: bigint;
  total: bigint;
  periods: Set<number>;
}

const MAX_UINT = 2n ** 255n;

export class FeeSweeper {
  private readonly swept = new Map<string, SweptLedger>();

  constructor(
    private readonly ctx: OpsContext,
    private readonly registry: BookRegistry,
  ) {}

  private sagas(): Record<string, FeeSaga> {
    return this.ctx.sagas.get().fees;
  }

  /** Incrementally scan FeesSwept(period, amount) for an adapter (from deployment.startBlock). */
  async refreshSwept(adapter: Address): Promise<SweptLedger> {
    const k = adapter.toLowerCase();
    const led = this.swept.get(k) ?? { scannedTo: this.ctx.chain.startBlock - 1n, total: 0n, periods: new Set<number>() };
    const head = await this.ctx.chain.blockNumber();
    let from = led.scannedTo + 1n;
    while (from <= head) {
      const to = from + this.ctx.settings.logMaxRange - 1n < head ? from + this.ctx.settings.logMaxRange - 1n : head;
      for (const l of await this.ctx.chain.adapterLogs([adapter], from, to)) {
        if (l.kind !== "FeesSwept") continue;
        led.total += l.amount;
        led.periods.add(Number(l.period));
      }
      led.scannedTo = to;
      from = to + 1n;
    }
    this.swept.set(k, led);
    return led;
  }

  /** Record a FeesSwept seen by the log watcher (keeps the ledger warm). */
  noteSwept(adapter: Address, period: bigint, amount: bigint, block: bigint) {
    const led = this.swept.get(adapter.toLowerCase());
    if (!led || block <= led.scannedTo) return;
    led.total += amount;
    led.periods.add(Number(period));
  }

  /** Auto mode: sweep each Live/Retiring book's last completed period once it is ready. */
  async auto(): Promise<void> {
    const books = this.registry.list().filter((b) => reportableState(b.state));
    if (books.length === 0) return;
    const interval = await this.ctx.chain.markInterval();
    const now = nowSec(this.ctx.now());
    let settlements: SettlementRow[] | null = null;
    for (const book of books) {
      const lastDone = Object.values(this.sagas())
        .filter((s) => s.bookId === book.bookId)
        .reduce((m, s) => Math.max(m, s.period), 0);
      const periods = completedPeriods(now, interval, Math.max(lastDone, now - interval * 2));
      const period = periods[periods.length - 1];
      if (period === undefined || this.sagas()[feeSagaKey(book.bookId, period)]) continue;
      settlements ??= await this.ctx.builder.feeSettlements(0);
      if (!periodReady({ period, nowSec: now, graceSec: this.ctx.settings.feeGraceSec, settlements, symbol: book.symbol })) continue;
      try {
        await this.sweep(book.bookId, period, settlements);
      } catch (err) {
        this.ctx.log.warn({ bookId: book.bookId, period, err: errMsg(err) }, "fee sweep failed (will retry)");
      }
    }
  }

  /** sweep_fees job / auto: idempotent per (book, period). */
  async sweep(bookId: number, period: number, settlementsIn?: SettlementRow[]): Promise<FeeSaga> {
    const book = this.registry.get(bookId);
    if (!book) throw new Error(`book ${bookId} is not a tracked Orderly book`);
    return this.ctx.locks.run(bookId, async () => {
      const key = feeSagaKey(bookId, period);
      let s = this.sagas()[key];
      if (!s) {
        s = await this.plan(book, period, settlementsIn);
        this.save(s);
      }
      for (let guard = 0; guard < 4 && (s.stage === "planned" || s.stage === "requested" || s.stage === "paid"); guard++) {
        try {
          const next = await this.step(book, s);
          if (!next) break;
          s = next;
          this.save(s);
        } catch (err) {
          s = { ...s, attempts: s.attempts + 1, lastError: errMsg(err), updatedAt: this.ctx.now() };
          this.save(s);
          throw err;
        }
      }
      return s;
    });
  }

  private save(s: FeeSaga) {
    this.sagas()[s.key] = s;
    this.ctx.sagas.save();
  }

  private async plan(book: TrackedBook, period: number, settlementsIn?: SettlementRow[]): Promise<FeeSaga> {
    const { chain, store, builder, log } = this.ctx;
    const now = this.ctx.now();
    const base = { key: feeSagaKey(book.bookId, period), bookId: book.bookId, adapter: book.adapter, symbol: book.symbol, period, attempts: 0, createdAt: now, updatedAt: now };
    const led = await this.refreshSwept(book.adapter);
    if (led.periods.has(period) || (await store.hasFeeSettlement(book.bookId, period))) {
      log.info({ bookId: book.bookId, period }, "fees already swept for period");
      return { ...base, amount: "0", stage: "swept" };
    }
    const settlements = settlementsIn ?? (await builder.feeSettlements(0));
    let cap: bigint;
    try {
      cap = await chain.maxFeeSweepPerPeriod(book.adapter);
    } catch {
      cap = MAX_UINT;
    }
    const plan = planFeeSweep({ symbol: book.symbol, period, settlements, sweptTotalUsd: led.total, inFlightUsd: feeInFlight(Object.values(this.sagas()), book.bookId), capUsd: cap });
    if (plan.amount === 0n) {
      log.debug({ bookId: book.bookId, period, settledUpTo: plan.settledUpTo.toString() }, "no builder fees to sweep for period");
      return { ...base, amount: "0", stage: "skipped" };
    }
    log.info({ bookId: book.bookId, period, amount: plan.amount.toString(), carried: plan.carried.toString() }, "fee sweep planned");
    return { ...base, amount: plan.amount.toString(), stage: "planned" };
  }

  private async step(book: TrackedBook, s: FeeSaga): Promise<FeeSaga | null> {
    const { builder, chain, settings, store, log } = this.ctx;
    const amount = BigInt(s.amount);
    const now = this.ctx.now();
    if (s.stage === "planned") {
      // mock: Orderly pays straight to the adapter; live: to the builder EOA, then an ERC20 transfer (VERIFY)
      const to = settings.mode === "mock" ? book.adapter : chain.opsAddress;
      const r = await builder.requestWithdraw({ accountId: settings.builderAccountId, amountUsd: amount, to, nonce: `fee-${book.bookId}-${s.period}` });
      return advanceFee(s, "requested", { withdrawId: r.withdrawId }, now);
    }
    if (s.stage === "requested") {
      const wid = s.withdrawId as string;
      const rec = await builder.withdrawal(settings.builderAccountId, wid);
      if (settings.mode === "live") {
        if (rec?.status !== "COMPLETED") return null;
        const payTx = s.payTx ?? (await chain.usdcTransfer(book.adapter, amount));
        return advanceFee(s, "paid", { payTx }, now);
      }
      if (rec?.status === "COMPLETED" && rec.txHash) return advanceFee(s, "paid", { payTx: rec.txHash as `0x${string}` }, now);
      let cur = s;
      if (!cur.creditTx) {
        const creditTx = await chain.vaultCreditFees(settings.builderAccountId as `0x${string}`, amount);
        cur = { ...cur, creditTx, updatedAt: now };
        this.save(cur);
      }
      if (!cur.payTx) {
        const payTx = await chain.vaultOperatorWithdraw(settings.builderAccountId as `0x${string}`, book.adapter, amount);
        cur = { ...cur, payTx, updatedAt: now };
        this.save(cur);
      }
      await builder.mockCompleteWithdraw(wid, cur.payTx as string);
      return advanceFee(cur, "paid", {}, now);
    }
    if (s.stage === "paid") {
      const led = await this.refreshSwept(book.adapter);
      if (led.periods.has(s.period)) return advanceFee(s, "swept", {}, now);
      const r = await chain.sweepFees(book.adapter, BigInt(s.period), amount);
      led.total += amount;
      led.periods.add(s.period);
      try {
        await store.insertFeeSettlement({ bookId: book.bookId, period: s.period, amountUsd: amount, txHash: r.txHash, logIndex: r.logIndex, ts: new Date(now) });
      } catch (err) {
        log.warn({ bookId: book.bookId, period: s.period, err: errMsg(err) }, "settlements insert failed (on-chain FeesSwept is authoritative)");
      }
      log.info({ bookId: book.bookId, period: s.period, amount: amount.toString(), tx: r.txHash }, "builder fees swept to RevenueRouter");
      return advanceFee(s, "swept", { sweepTx: r.txHash, logIndex: r.logIndex }, now);
    }
    return null;
  }
}
