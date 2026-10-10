// Builder fee settlement per mark period (saga: domain/fees.ts):
//   adapter.sweepFees(period, amount)       earmark FIRST (FeesSwept; a rejected earmark moves nothing)
//   -> builder account -> ops EOA           Orderly withdrawal (mock: MockOrderlyVault credit + payout)
//   -> ops EOA -> adapter                   the USDC lands already earmarked: a permissionless
//                                            sweepToVault can no longer take it as capital
//   -> adapter.forwardPendingFees()         -> RevenueRouter (notifySettlement)
// Exactly once per (book, period): saga store + on-chain feeSweptForPeriod / FeesSwept logs + settlements
// rows. Every tx is recorded before its receipt is awaited and inspected on retry (txonce.ts), and the
// auto loop resumes every unfinished saga.
import type { Address, Hex } from "viem";
import type { WriteOpts } from "../chain";
import { advanceFee, attributeBrokerWide, completedPeriods, type FeeSaga, type FeeTxSlot, feeInFlight, feeSagaKey, isFeeTerminal, periodReady, planFeeSweep, type SettlementRow, unpaidEarmarks } from "../domain/fees";
import { reportableState } from "../domain/report";
import { matchPriorWithdrawal } from "../domain/withdraw";
import { errMsg, nowSec } from "../util";
import type { BookRegistry } from "./books";
import type { OpsContext, TrackedBook } from "./context";
import { type OnceResult, sendOnce } from "./txonce";

interface SweptLedger {
  scannedTo: bigint;
  total: bigint;
  periods: Map<number, { amount: bigint; txHash: Hex; logIndex: number }>;
}

const MAX_UINT = 2n ** 255n;
/** A planned saga whose earmark was never broadcast is abandoned after this many failed attempts (nothing moved; the amount carries to a later period). */
const MAX_EARMARK_ATTEMPTS = 5;
const FORWARD_WAIT_WARN_MS = 15 * 60_000;

export class FeeSweeper {
  private readonly swept = new Map<string, SweptLedger>();
  private readonly warnedAt = new Map<string, number>();

  constructor(
    private readonly ctx: OpsContext,
    private readonly registry: BookRegistry,
  ) {}

  private sagas(): Record<string, FeeSaga> {
    return this.ctx.sagas.get().fees;
  }

  private get(key: string): FeeSaga {
    const s = this.sagas()[key];
    if (!s) throw new Error(`unknown fee saga ${key}`);
    return s;
  }

  /** Incrementally scan FeesSwept(period, amount) for an adapter (from deployment.startBlock). */
  async refreshSwept(adapter: Address): Promise<SweptLedger> {
    const k = adapter.toLowerCase();
    const led = this.swept.get(k) ?? { scannedTo: this.ctx.chain.startBlock - 1n, total: 0n, periods: new Map() };
    const head = await this.ctx.chain.blockNumber();
    let from = led.scannedTo + 1n;
    while (from <= head) {
      const to = from + this.ctx.settings.logMaxRange - 1n < head ? from + this.ctx.settings.logMaxRange - 1n : head;
      for (const l of await this.ctx.chain.adapterLogs([adapter], from, to)) {
        if (l.kind !== "FeesSwept" || led.periods.has(Number(l.period))) continue;
        led.total += l.amount;
        led.periods.set(Number(l.period), { amount: l.amount, txHash: l.txHash, logIndex: l.logIndex });
      }
      led.scannedTo = to;
      from = to + 1n;
    }
    this.swept.set(k, led);
    return led;
  }

  /** Record a FeesSwept seen by the log watcher (keeps the ledger warm). */
  noteSwept(adapter: Address, period: bigint, amount: bigint, block: bigint, txHash?: Hex, logIndex = 0) {
    const led = this.swept.get(adapter.toLowerCase());
    if (!led || block <= led.scannedTo || led.periods.has(Number(period))) return;
    led.total += amount;
    led.periods.set(Number(period), { amount, txHash: txHash ?? ("0x" as Hex), logIndex });
  }

  /** Auto mode: resume unfinished sagas, then sweep each Live/Retiring book's last completed period once it is ready. */
  async auto(): Promise<void> {
    for (const s of Object.values(this.sagas())) {
      if (isFeeTerminal(s) || !this.registry.get(s.bookId)) continue;
      try {
        await this.sweep(s.bookId, s.period);
      } catch (err) {
        this.ctx.log.warn({ bookId: s.bookId, period: s.period, stage: s.stage, err: errMsg(err) }, "fee saga step failed (will retry)");
      }
    }
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
      settlements ??= await this.settlements();
      if (!periodReady({ period, nowSec: now, graceSec: this.ctx.settings.feeGraceSec, settlements, symbol: book.symbol })) continue;
      try {
        await this.sweep(book.bookId, period, settlements);
      } catch (err) {
        this.ctx.log.warn({ bookId: book.bookId, period, err: errMsg(err) }, "fee sweep failed (will retry)");
      }
    }
  }

  /** sweep_fees job / auto: idempotent per (book, period). Returns the saga (it may still be waiting mid-way). */
  async sweep(bookId: number, period: number, settlementsIn?: SettlementRow[]): Promise<FeeSaga> {
    const book = this.registry.get(bookId);
    if (!book) throw new Error(`book ${bookId} is not a tracked Orderly book`);
    return this.ctx.locks.run(bookId, async () => {
      const key = feeSagaKey(bookId, period);
      if (!this.sagas()[key]) this.save(await this.plan(book, period, settlementsIn));
      for (let guard = 0; guard < 8 && !isFeeTerminal(this.get(key)); guard++) {
        try {
          const next = await this.step(book, key);
          if (!next) break; // waiting (venue payout, pending tx, fee USDC held behind in-transit principal)
          this.save(next);
        } catch (err) {
          const s = this.get(key);
          const abandon = s.stage === "planned" && !s.txs?.earmark && s.attempts + 1 >= MAX_EARMARK_ATTEMPTS;
          this.save({ ...s, attempts: s.attempts + 1, lastError: errMsg(err), updatedAt: this.ctx.now(), ...(abandon ? { stage: "failed" as const } : {}) });
          if (abandon) this.ctx.log.warn({ bookId, period, err: errMsg(err) }, "fee earmark keeps failing — abandoning the period (nothing moved; the amount carries to a later period)");
          throw err;
        }
      }
      return this.get(key);
    });
  }

  private warnedBrokerWide = false;

  /** Venue settlements, broker-wide (live) rows attributed to the only live Orderly book (see attributeBrokerWide). */
  private async settlements(): Promise<SettlementRow[]> {
    const raw = await this.ctx.builder.feeSettlements(0);
    const symbols = this.registry
      .list()
      .filter((b) => reportableState(b.state))
      .map((b) => b.symbol);
    const { rows, dropped } = attributeBrokerWide(raw, symbols);
    if (dropped > 0 && !this.warnedBrokerWide) {
      this.warnedBrokerWide = true;
      this.ctx.log.error({ dropped, symbols }, "broker-wide builder fee revenue cannot be attributed to one of several Orderly books — no fee sweeps from it (VERIFY O11: per-symbol revenue source)");
    }
    return rows;
  }

  private save(s: FeeSaga) {
    this.sagas()[s.key] = s;
    this.ctx.sagas.save();
  }

  private patch(key: string, p: Partial<FeeSaga>): FeeSaga {
    const next = { ...this.get(key), ...p, updatedAt: this.ctx.now() };
    this.save(next);
    return next;
  }

  /** sendOnce bound to a saga tx slot; null while the recorded tx is still pending. */
  private async once<T>(key: string, slot: FeeTxSlot, send: (o: WriteOpts) => Promise<T>): Promise<Exclude<OnceResult<T>, { kind: "pending" }> | null> {
    const r = await sendOnce(this.ctx.chain, this.get(key).txs?.[slot], (tx) => this.patch(key, { txs: { ...this.get(key).txs, [slot]: tx } }), send);
    if (r.kind === "pending") {
      this.ctx.log.info({ key, slot, tx: r.hash }, "fee tx still pending — waiting for it instead of re-sending");
      return null;
    }
    return r;
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
    const settlements = settlementsIn ?? (await this.settlements());
    let cap: bigint;
    try {
      cap = await chain.maxFeeSweepPerPeriod(book.adapter);
    } catch {
      cap = MAX_UINT;
    }
    const inFlightUsd = feeInFlight(Object.values(this.sagas()), book.bookId, new Set(led.periods.keys()));
    const plan = planFeeSweep({ symbol: book.symbol, period, settlements, sweptTotalUsd: led.total, inFlightUsd, capUsd: cap });
    if (plan.amount === 0n) {
      log.debug({ bookId: book.bookId, period, settledUpTo: plan.settledUpTo.toString() }, "no builder fees to sweep for period");
      return { ...base, amount: "0", stage: "skipped" };
    }
    log.info({ bookId: book.bookId, period, amount: plan.amount.toString(), carried: plan.carried.toString() }, "fee sweep planned");
    return { ...base, amount: plan.amount.toString(), stage: "planned" };
  }

  private async step(book: TrackedBook, key: string): Promise<FeeSaga | null> {
    const { builder, chain, settings, log } = this.ctx;
    let s = this.get(key);
    const amount = BigInt(s.amount);
    if (s.stage !== "planned" && !s.earmarkTx) {
      // saga persisted by the old pay-before-earmark order: earmark before anything else moves
      const e = await this.earmark(book, key);
      if (!e) return null;
      s = e;
    }
    switch (s.stage) {
      case "planned": {
        const e = await this.earmark(book, key);
        return e ? advanceFee(e, "earmarked", { requestSince: this.ctx.now() }, this.ctx.now()) : null;
      }
      case "earmarked": {
        // Both modes: the builder fee share is withdrawn from the builder admin account to the ops EOA (the
        // account owner — Orderly only pays an account's own address), then forwarded to the adapter (VERIFY).
        const withdrawId = await this.venueRequest(s);
        return advanceFee(this.get(key), "requested", { withdrawId }, this.ctx.now());
      }
      case "requested": {
        const wid = s.withdrawId as string;
        const rec = await builder.withdrawal(settings.builderAccountId, wid);
        if (rec?.status === "FAILED") {
          // nothing was paid out; the venue credited the builder account back: request it again
          log.warn({ bookId: s.bookId, period: s.period, withdrawId: wid }, "builder fee withdrawal FAILED on the venue — requesting it again");
          return advanceFee(s, "earmarked", { reqSeq: (s.reqSeq ?? 0) + 1, withdrawId: undefined, requestSince: this.ctx.now() }, this.ctx.now());
        }
        if (rec?.status === "COMPLETED") return advanceFee(s, "received", {}, this.ctx.now());
        if (settings.mode === "live") return null; // VERIFY: Orderly pays out asynchronously; poll until COMPLETED
        return this.mockPayout(book, key);
      }
      case "received": {
        let payTx = s.payTx;
        if (!payTx) {
          // the venue payout must be on the ops EOA before it is forwarded (live: Orderly's on-chain withdrawal)
          if (!s.txs?.pay && (await chain.usdcBalance(chain.opsAddress)) < amount) {
            log.debug({ bookId: s.bookId, period: s.period }, "builder fee payout not on the ops account yet");
            return null;
          }
          const r = await this.once(key, "pay", (o) => chain.usdcTransfer(book.adapter, amount, o));
          if (!r) return null;
          payTx = r.kind === "mined" ? r.hash : r.value;
        }
        return advanceFee(this.get(key), "paid", { payTx }, this.ctx.now());
      }
      case "paid":
        return this.forward(book, key);
      default:
        return null;
    }
  }

  /** adapter.sweepFees(period, amount): earmark (or recognise an earmark that already landed). */
  private async earmark(book: TrackedBook, key: string): Promise<FeeSaga | null> {
    const { chain, store, log } = this.ctx;
    const s = this.get(key);
    const amount = BigInt(s.amount);
    const period = BigInt(s.period);
    let hash: Hex | undefined;
    let logIndex: number | undefined;
    const onchain = await chain.feeSweptForPeriod(book.adapter, period);
    if (onchain === 0n) {
      const r = await this.once(key, "earmark", (o) => chain.sweepFees(book.adapter, period, amount, o));
      if (!r) return null;
      if (r.kind === "sent") {
        hash = r.value.txHash;
        logIndex = r.value.logIndex;
      } else if ((await chain.feeSweptForPeriod(book.adapter, period)) === 0n) {
        throw new Error(`earmark tx ${r.hash} mined but feeSweptForPeriod(${s.period}) is 0 — retrying`);
      } else hash = r.hash;
    } else if (onchain !== amount) {
      throw new Error(`period ${s.period} already earmarked on-chain with ${onchain}, planned ${amount} — manual reconcile`);
    }
    // earmarked (by this call, or by an earlier attempt whose receipt was lost)
    const led = await this.refreshSwept(book.adapter);
    const ref = led.periods.get(s.period);
    hash ??= s.txs?.earmark?.hash ?? ref?.txHash;
    logIndex ??= ref?.logIndex ?? 0;
    if (!led.periods.has(s.period)) {
      led.total += amount;
      led.periods.set(s.period, { amount, txHash: hash ?? ("0x" as Hex), logIndex });
    }
    if (hash) {
      try {
        await store.insertFeeSettlement({ bookId: book.bookId, period: s.period, amountUsd: amount, txHash: hash, logIndex, ts: new Date(this.ctx.now()) });
      } catch (err) {
        log.warn({ bookId: book.bookId, period: s.period, err: errMsg(err) }, "settlements insert failed (on-chain FeesSwept is authoritative)");
      }
    }
    log.info({ bookId: book.bookId, period: s.period, amount: amount.toString(), tx: hash }, "builder fees earmarked on the adapter");
    return this.patch(key, { earmarkTx: hash ?? ("0x" as Hex), ...(hash ? { sweepTx: hash } : {}), logIndex });
  }

  /** Builder account -> ops EOA withdrawal on the venue, never requested twice (see matchPriorWithdrawal). */
  private async venueRequest(s: FeeSaga): Promise<string> {
    const { builder, chain, settings, log } = this.ctx;
    const amount = BigInt(s.amount);
    const ref = `fee-${s.bookId}-${s.period}${s.reqSeq ? `-r${s.reqSeq}` : ""}`;
    const claimed = new Set(
      Object.values(this.sagas())
        .filter((x) => x.key !== s.key && x.withdrawId)
        .map((x) => x.withdrawId as string),
    );
    const prior = matchPriorWithdrawal(await builder.withdrawals(settings.builderAccountId), { ref, amount, receiver: chain.opsAddress, sinceMs: s.requestSince ?? s.createdAt, claimed });
    if (prior) {
      log.info({ bookId: s.bookId, period: s.period, withdrawId: String(prior.id) }, "builder fee withdrawal already requested by an earlier attempt — adopting it");
      return String(prior.id);
    }
    const r = await builder.requestWithdraw({ accountId: settings.builderAccountId, amountUsd: amount, to: chain.opsAddress, nonce: ref });
    return r.withdrawId;
  }

  /**
   * Mock venue payout: materialise the venue's builder settlement on MockOrderlyVault (credit the builder
   * admin account) and pay it to its owner (the ops EOA), as Orderly would.
   */
  private async mockPayout(book: TrackedBook, key: string): Promise<FeeSaga | null> {
    const { builder, chain, settings } = this.ctx;
    let s = this.get(key);
    const amount = BigInt(s.amount);
    const builderId = settings.builderAccountId as Hex;
    if (!s.creditTx) {
      await chain.ensureMockAccount(builderId, book.adapter);
      if (!(await this.once(key, "mint", (o) => chain.mockVaultMint(amount, o)))) return null;
      const c = await this.once(key, "credit", (o) => chain.vaultCreditFees(builderId, amount, o));
      if (!c) return null;
      s = this.patch(key, { creditTx: c.kind === "mined" ? c.hash : c.value });
    }
    if (!s.withdrawTx) {
      const w = await this.once(key, "withdraw", (o) => chain.vaultOperatorWithdraw(builderId, chain.opsAddress, amount, o));
      if (!w) return null;
      s = this.patch(key, { withdrawTx: w.kind === "mined" ? w.hash : w.value });
    }
    await builder.mockCompleteWithdraw(s.withdrawId as string, s.withdrawTx as string);
    return advanceFee(s, "received", {}, this.ctx.now());
  }

  /**
   * adapter.forwardPendingFees(): done once the adapter's pending (earmarked) fees are down to the earmarks
   * of other sagas that have not paid their USDC yet. Fee USDC held back behind in-transit principal
   * (principal-first attribution) is forwarded on a later call — the saga waits.
   */
  private async forward(book: TrackedBook, key: string): Promise<FeeSaga | null> {
    const { chain, log } = this.ctx;
    let s = this.get(key);
    let forwardTx = s.forwardTx;
    const prior = s.txs?.forward;
    if (prior && prior.hash !== forwardTx && (await chain.txState(prior)) === "pending") return null;
    if ((await chain.forwardableFees(book.adapter)) > 0n) {
      const r = await chain.forwardPendingFees(book.adapter, { onSent: (tx) => this.patch(key, { txs: { ...this.get(key).txs, forward: tx } }) });
      forwardTx = r.txHash;
      s = this.patch(key, { forwardTx });
      log.info({ bookId: s.bookId, period: s.period, forwarded: r.forwarded.toString(), tx: r.txHash }, "builder fees forwarded to RevenueRouter");
    }
    const f = await chain.adapterFlowState(book.adapter);
    const others = unpaidEarmarks(Object.values(this.sagas()), s.bookId, key);
    if (f.pendingFeesUsd <= others) return advanceFee(s, "swept", forwardTx ? { forwardTx } : {}, this.ctx.now());
    const now = this.ctx.now();
    if (now - s.updatedAt > FORWARD_WAIT_WARN_MS && now - (this.warnedAt.get(key) ?? 0) > FORWARD_WAIT_WARN_MS) {
      this.warnedAt.set(key, now);
      log.warn({ bookId: s.bookId, period: s.period, pendingFeesUsd: f.pendingFeesUsd.toString(), inTransitUsd: f.inTransitUsd.toString(), usdc: f.usdcBalance.toString() }, "earmarked fees still not forwardable — waiting");
    }
    return null;
  }
}
