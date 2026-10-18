// Executes adapter withdrawals (saga: domain/withdraw.ts):
//   WithdrawRequested -> [on-chain status still Requested] -> Orderly withdraw request (delegate signer)
//   -> adapter.confirmWithdraw (BEFORE any USDC can reach the adapter) -> payout (mock:
//   MockOrderlyVault.operatorWithdraw; live: Orderly pays, VERIFY) -> sweepToVault.
// Builder IF mode (ORDERLY_IF_MODE=builder, IF account of an operator EOA): the operator withdraws on Orderly and returns
// the payout to the adapter; ops-venue recognises the withdrawal, confirms it on-chain, waits for the USDG and sweeps.
// Saga state persists in the saga store and every step is idempotent / resumable: the adapter's
// on-chain request status gates each step (old or replayed requests are never executed again), and every
// tx is recorded before its receipt is awaited and inspected on retry instead of being re-sent (txonce.ts).
import { ACCOUNT } from "@bookrunner/shared";
import type { Hex } from "viem";
import { type AdapterLog, WITHDRAW_STATUS, withdrawStatusName, type WriteOpts } from "../chain";
import { isTerminal, matchPriorWithdrawal, newWithdrawSaga, nextStep, retryDelayMs, sagaKey, sagaReceiver, shortfall, transition, type WithdrawEvent, type WithdrawSaga, type WithdrawTxSlot } from "../domain/withdraw";
import { OrderlyHttpError } from "../orderly/http";
import { errMsg } from "../util";
import type { BookRegistry } from "./books";
import { type OpsContext, type TrackedBook, tradable } from "./context";
import { sendOnce } from "./txonce";

/** Manual listing mode: re-try period of an IF withdrawal waiting for the admin to delist the market in Orderly One. */
export const DELIST_WAIT_MS = 60_000;
/** Manual listing mode: past this wait (OPS_DELIST_WAIT_MAX_MS) the venue error counts as a failed attempt again. */
export const DELIST_WAIT_MAX_MS = 24 * 3_600_000;

export class WithdrawProcessor {
  private readonly nextAttemptAt = new Map<string, number>();

  constructor(
    private readonly ctx: OpsContext,
    private readonly registry: BookRegistry,
  ) {}

  private all(): Record<string, WithdrawSaga> {
    return this.ctx.sagas.get().withdrawals;
  }

  private get(key: string): WithdrawSaga {
    const s = this.all()[key];
    if (!s) throw new Error(`unknown withdraw saga ${key}`);
    return s;
  }

  /**
   * Record a WithdrawRequested log (idempotent). A request that is no longer Requested on-chain
   * (confirmed, cancelled or failed: a replay after a restart, a pruned or lost saga) never gets a saga.
   */
  async onRequested(l: Extract<AdapterLog, { kind: "WithdrawRequested" }>): Promise<WithdrawSaga | null> {
    const book = this.registry.byAdapter(l.adapter);
    if (!book) return null;
    const existing = this.all()[sagaKey(l.adapter, l.nonce)];
    if (existing) return existing;
    try {
      const st = await this.ctx.chain.withdrawStatus(l.adapter, l.nonce);
      if (st.status !== WITHDRAW_STATUS.Requested) {
        this.ctx.log.debug({ bookId: book.bookId, nonce: l.nonce.toString(), status: withdrawStatusName(st.status) }, "WithdrawRequested replay: request no longer pending on-chain — ignored");
        return null;
      }
    } catch (err) {
      this.ctx.log.warn({ bookId: book.bookId, nonce: l.nonce.toString(), err: errMsg(err) }, "withdraw status read failed; the request step re-checks it");
    }
    const operatorIf = l.account === ACCOUNT.IF && book.ifBinding === "builder";
    const s = newWithdrawSaga({ bookId: book.bookId, adapter: l.adapter, account: l.account, accountId: l.account === ACCOUNT.IF ? book.accounts.if : book.accounts.mm, owner: l.account === ACCOUNT.IF ? book.owners.if : book.owners.mm, amount: l.amount, nonce: l.nonce, txHash: l.txHash, operatorIf }, this.ctx.now());
    if (this.all()[s.key]) return this.all()[s.key] ?? null; // recorded meanwhile
    this.all()[s.key] = s;
    this.ctx.sagas.save();
    this.ctx.log.info({ bookId: book.bookId, account: l.account, amount: l.amount.toString(), nonce: l.nonce.toString(), tx: l.txHash }, "withdraw requested on adapter");
    return s;
  }

  /** Manual listing mode: pending IF withdrawals waiting for the admin's delisting (published for alerts). */
  delistWaits(): Array<{ bookId: number; symbol: string; since: number }> {
    return this.pending()
      .filter((s) => s.stage === "detected" && s.delistWaitSince !== undefined)
      .map((s) => ({ bookId: s.bookId, symbol: this.registry.get(s.bookId)?.symbol ?? "", since: s.delistWaitSince as number }));
  }

  /** Builder IF mode: IF withdrawals waiting for the operator (withdraw on Orderly / return to the adapter), for alerts. */
  ifOperatorWaits(): Array<{ bookId: number; nonce: string; step: "withdraw" | "return"; amount: string; owner: string; adapter: string; since: number }> {
    const out: ReturnType<WithdrawProcessor["ifOperatorWaits"]> = [];
    for (const s of this.pending()) {
      if (!s.operatorIf) continue;
      const base = { bookId: s.bookId, nonce: s.nonce, amount: s.amount, owner: sagaReceiver(s), adapter: s.adapter };
      if (s.stage === "detected" && s.operatorWaitSince !== undefined) out.push({ ...base, step: "withdraw", since: s.operatorWaitSince });
      else if (s.stage === "confirmed" && s.returnWaitSince !== undefined) out.push({ ...base, step: "return", since: s.returnWaitSince });
    }
    return out;
  }

  pending(): WithdrawSaga[] {
    return Object.values(this.all()).filter((s) => !isTerminal(s));
  }

  async processAll(): Promise<void> {
    const now = this.ctx.now();
    for (const s of this.pending()) {
      if ((this.nextAttemptAt.get(s.key) ?? 0) > now) continue;
      await this.process(s.key);
    }
  }

  /** execute_withdraw job: process the saga for (bookId, nonce) now. */
  async processNonce(bookId: number, nonce: string): Promise<WithdrawSaga> {
    const s = Object.values(this.all()).find((x) => x.bookId === bookId && x.nonce === nonce);
    if (!s) throw new Error(`book ${bookId}: withdraw nonce ${nonce} not indexed yet`);
    this.nextAttemptAt.delete(s.key);
    return this.process(s.key);
  }

  private patch(key: string, p: Partial<WithdrawSaga>): WithdrawSaga {
    const next = { ...this.get(key), ...p, updatedAt: this.ctx.now() };
    this.all()[key] = next;
    this.ctx.sagas.save();
    return next;
  }

  private apply(s: WithdrawSaga, ev: WithdrawEvent): WithdrawSaga {
    const next = transition(s, ev, this.ctx.now(), this.ctx.settings.withdrawMaxAttempts);
    this.all()[s.key] = next;
    this.ctx.sagas.save();
    if (ev.type === "error") {
      this.nextAttemptAt.set(s.key, this.ctx.now() + retryDelayMs(next.attempts));
      const lvl = next.stage === "failed" ? "error" : next.attempts % 5 === 1 ? "warn" : "debug";
      this.ctx.log[lvl]({ bookId: s.bookId, nonce: s.nonce, stage: s.stage, attempts: next.attempts, err: ev.error }, next.stage === "failed" ? "withdraw saga FAILED — manual action required" : "withdraw step failed");
    } else {
      this.nextAttemptAt.delete(s.key);
      const lvl = ev.type === "cancelled" ? "warn" : "info";
      this.ctx.log[lvl]({ bookId: s.bookId, nonce: s.nonce, stage: next.stage, ...(next.reason ? { reason: next.reason } : {}) }, "withdraw saga advanced");
    }
    return next;
  }

  async process(key: string): Promise<WithdrawSaga> {
    const first = this.get(key);
    return this.ctx.locks.run(first.bookId, async () => {
      for (let guard = 0; guard < 8; guard++) {
        const s = this.get(key);
        if (isTerminal(s)) break;
        const step = nextStep(s);
        if (!step) break;
        let ev: WithdrawEvent | null;
        try {
          ev = await this.runStep(step, key);
        } catch (err) {
          ev = { type: "error", error: errMsg(err) };
        }
        if (!ev) break; // waiting (venue payout, pending tx, mark-window gate)
        this.apply(this.get(key), ev); // re-read: the step may have recorded txs
        if (ev.type === "error") break;
      }
      return this.get(key);
    });
  }

  /** sendOnce bound to a saga tx slot: `{hash}` once the tx landed (hash null = nothing to send), null while it is pending. */
  private async once(key: string, slot: WithdrawTxSlot, send: (o: WriteOpts) => Promise<Hex | null>): Promise<{ hash: Hex | null } | null> {
    const r = await sendOnce(this.ctx.chain, this.get(key).txs?.[slot], (tx) => this.patch(key, { txs: { ...this.get(key).txs, [slot]: tx } }), send);
    if (r.kind === "pending") {
      this.ctx.log.info({ key, slot, tx: r.hash }, "withdraw tx still pending — waiting for it instead of re-sending");
      return null;
    }
    return { hash: r.kind === "mined" ? r.hash : r.value };
  }

  private async runStep(step: NonNullable<ReturnType<typeof nextStep>>, key: string): Promise<WithdrawEvent | null> {
    const { builder, chain, settings, log } = this.ctx;
    const s = this.get(key);
    const nonce = BigInt(s.nonce);
    switch (step) {
      case "request": {
        const st = await chain.withdrawStatus(s.adapter, nonce);
        if (st.status !== WITHDRAW_STATUS.Requested) return { type: "skipped", reason: `on-chain request is ${withdrawStatusName(st.status)}` };
        const book = this.registry.get(s.bookId);
        if (s.operatorIf) return this.operatorRequest(key, st.requestedAt);
        try {
          const withdrawId = await this.venueRequest(s, st.requestedAt);
          if (s.delistWaitSince !== undefined) log.info({ bookId: s.bookId, symbol: book?.symbol, waitedMs: this.ctx.now() - s.delistWaitSince }, "delisting in Orderly One done: the insurance-fund withdrawal went through");
          return { type: "venue_requested", withdrawId };
        } catch (err) {
          if (book && tradable(book) && s.account === ACCOUNT.IF && isInsufficient(err) && book.state === "Retiring" && (await this.mmFlat(book))) {
            if ((settings.listingMode ?? "api") === "manual") {
              // no confirmed delisting endpoint (VERIFY O20): the admin delists in Orderly One. Waiting on a person is
              // not a failed attempt (the saga would run out of attempts): re-try the venue request every minute, up to
              // the ceiling; past it the error counts again (the saga can fail: a real shortfall is not hidden forever).
              const now = this.ctx.now();
              const since = s.delistWaitSince ?? now;
              const maxMs = settings.delistWaitMaxMs ?? DELIST_WAIT_MAX_MS;
              if (s.delistWaitSince === undefined) {
                this.patch(key, { delistWaitSince: since });
                log.warn({ bookId: s.bookId, symbol: book.symbol, err: errMsg(err) }, "retiring book: the insurance fund is locked by the listed market — delist it in Orderly One (manual listing mode); the IF withdrawal re-tries every minute");
              } else {
                log.debug({ bookId: s.bookId, symbol: book.symbol, err: errMsg(err), waitingMs: now - since }, "IF withdrawal still waiting for the delisting in Orderly One");
              }
              if (now - since < maxMs) {
                this.nextAttemptAt.set(key, now + DELIST_WAIT_MS);
                return null;
              }
              log.error({ bookId: s.bookId, symbol: book.symbol, err: errMsg(err), waitingMs: now - since }, "IF withdrawal waited past the delisting ceiling: counting the venue error as a failed attempt (check the market in Orderly One and the IF balance)");
              throw err;
            }
            log.info({ bookId: s.bookId, symbol: book.symbol }, "retiring book: delisting symbol to release the insurance fund");
            await builder.setSymbolStatus(book.symbol, "DELISTED");
            return { type: "venue_requested", withdrawId: await this.venueRequest(s, st.requestedAt) };
          }
          throw err;
        }
      }
      case "confirm": {
        // Right after the venue accepted (and debited) the withdrawal, before any payout can land.
        const st = await chain.withdrawStatus(s.adapter, nonce);
        if (st.status === WITHDRAW_STATUS.Confirmed) return { type: "confirmed", ...(s.txs?.confirm ? { confirmTx: s.txs.confirm.hash } : {}) };
        if (st.status !== WITHDRAW_STATUS.Requested) return { type: "error", error: `on-chain request is ${withdrawStatusName(st.status)}; cannot confirm`, fatal: true };
        // best effort: a venue read error must not hold up the confirm (a later FAILED is handled by `pay`)
        const rec = await builder.withdrawal(s.accountId, s.withdrawId as string).catch(() => null);
        if (rec?.status === "FAILED") {
          // rejected on the venue before anything moved: release the on-chain request (Requested -> Cancelled)
          const c = await this.once(key, "cancel", (o) => chain.cancelWithdraw(s.adapter, nonce, o));
          if (!c) return null;
          return { type: "cancelled", reason: `venue withdrawal ${s.withdrawId} FAILED before confirmation`, ...(c.hash ? { cancelTx: c.hash } : {}) };
        }
        const r = await this.once(key, "confirm", (o) => chain.confirmWithdraw(s.adapter, nonce, o));
        if (!r) return null;
        return { type: "confirmed", ...(r.hash ? { confirmTx: r.hash } : {}) };
      }
      case "pay": {
        const wid = s.withdrawId as string;
        const rec = await builder.withdrawal(s.accountId, wid);
        if (rec?.status === "COMPLETED") {
          if (s.operatorIf && !(await this.operatorReturned(key))) return null;
          return { type: "venue_paid", ...(rec.txHash ? { payTx: rec.txHash as Hex } : s.payTx ? { payTx: s.payTx } : {}) };
        }
        if (rec?.status === "FAILED") {
          if (s.payTx || s.txs?.pay) return { type: "error", error: `venue withdrawal ${wid} FAILED after the mock payout was sent — manual reconcile`, fatal: true };
          // confirmed on-chain, failed on the venue (funds credited back): Confirmed -> Failed
          const c = await this.once(key, "cancel", (o) => chain.failWithdraw(s.adapter, nonce, o));
          if (!c) return null;
          return { type: "cancelled", reason: `venue withdrawal ${wid} FAILED after confirmation`, ...(c.hash ? { cancelTx: c.hash } : {}) };
        }
        if (s.operatorIf) return null; // builder IF: Orderly pays the operator's EOA; poll until COMPLETED
        if (settings.mode === "live") return null; // VERIFY: Orderly pays out asynchronously; poll until COMPLETED
        return this.mockPay(key);
      }
      case "sweep": {
        const st = await chain.withdrawStatus(s.adapter, nonce);
        if (st.status === WITHDRAW_STATUS.Requested) {
          // saga persisted by the old pay-before-confirm order: never sweep an unconfirmed payout
          if (!(await this.once(key, "confirm", (o) => chain.confirmWithdraw(s.adapter, nonce, o)))) return null;
        } else if (st.status !== WITHDRAW_STATUS.Confirmed) {
          return { type: "error", error: `on-chain request is ${withdrawStatusName(st.status)}; not sweeping`, fatal: true };
        }
        try {
          const r = await this.once(key, "sweep", (o) => chain.sweepToVault(s.adapter, o));
          if (!r) return null;
          return { type: "swept", sweepTx: r.hash };
        } catch (err) {
          if (/SweepBlockedUntilMark/i.test(errMsg(err))) {
            log.info({ bookId: s.bookId, nonce: s.nonce }, "sweep waits for the period's mark (mark-window gate)");
            return null;
          }
          throw err;
        }
      }
    }
  }

  /** Mock payout: materialise venue PnL the mock vault never received, then MockOrderlyVault.operatorWithdraw. */
  private async mockPay(key: string): Promise<WithdrawEvent | null> {
    const { builder, chain, log } = this.ctx;
    let s = this.get(key);
    const amount = BigInt(s.amount);
    if (!s.payTx) {
      if (!s.txs?.pay) {
        if (s.creditAmount === undefined) s = this.patch(key, { creditAmount: shortfall(await chain.vaultLedger(s.accountId), amount).toString() });
        const need = BigInt(s.creditAmount as string);
        if (need > 0n) {
          if (!(await this.once(key, "mint", (o) => chain.mockVaultMint(need, o)))) return null;
          const c = await this.once(key, "credit", (o) => chain.vaultCreditFees(s.accountId, need, o));
          if (!c) return null;
          log.info({ bookId: s.bookId, accountId: s.accountId, amount: need.toString(), tx: c.hash }, "mock vault: materialised venue PnL before payout");
        }
      }
      const p = await this.once(key, "pay", (o) => chain.vaultOperatorWithdraw(s.accountId, sagaReceiver(s), amount, o));
      if (!p) return null;
      s = this.patch(key, { payTx: p.hash as Hex });
    }
    await builder.mockCompleteWithdraw(s.withdrawId as string, s.payTx as string);
    return { type: "venue_paid", ...(s.payTx ? { payTx: s.payTx } : {}) };
  }

  /**
   * Builder IF mode, request step: ops-venue cannot sign for the operator's EOA, so it waits for the operator's own Orderly
   * withdrawal of exactly this amount from the IF account (to the EOA, created after the on-chain request, not claimed by
   * another saga) and adopts it. Waiting (or an unreadable history, e.g. the IF key not registered yet) burns no attempt.
   */
  private async operatorRequest(key: string, requestedAtSec: bigint): Promise<WithdrawEvent | null> {
    const { builder, log } = this.ctx;
    const s = this.get(key);
    const now = this.ctx.now();
    const claimed = new Set(
      Object.values(this.all())
        .filter((x) => x.key !== s.key && x.withdrawId)
        .map((x) => x.withdrawId as string),
    );
    let prior: ReturnType<typeof matchPriorWithdrawal> = null;
    let readError: string | null = null;
    try {
      prior = matchPriorWithdrawal(await builder.withdrawals(s.accountId), { ref: `wr-${s.nonce}`, amount: BigInt(s.amount), receiver: sagaReceiver(s), sinceMs: Number(requestedAtSec) * 1000, claimed });
    } catch (err) {
      readError = errMsg(err);
    }
    if (prior) {
      log.info({ bookId: s.bookId, nonce: s.nonce, withdrawId: String(prior.id), status: prior.status, waitedMs: s.operatorWaitSince !== undefined ? now - s.operatorWaitSince : 0 }, "builder IF account: the operator's Orderly withdrawal found — adopting it");
      return { type: "venue_requested", withdrawId: String(prior.id) };
    }
    if (s.operatorWaitSince === undefined) {
      this.patch(key, { operatorWaitSince: now });
      log.warn(
        { bookId: s.bookId, nonce: s.nonce, amount: s.amount, accountId: s.accountId, owner: sagaReceiver(s), adapter: s.adapter, ...(readError ? { err: readError } : {}) },
        "builder IF account: the operator must withdraw this amount from the IF account on Orderly (paid to its wallet) and then transfer it to the adapter; ops-venue re-checks every minute",
      );
    } else {
      log.debug({ bookId: s.bookId, nonce: s.nonce, waitingMs: now - s.operatorWaitSince, ...(readError ? { err: readError } : {}) }, "builder IF withdrawal still waiting for the operator");
    }
    this.nextAttemptAt.set(key, now + (this.ctx.settings.ifOperatorRecheckMs ?? DELIST_WAIT_MS));
    return null;
  }

  /**
   * Builder IF mode, pay step after Orderly paid the operator's EOA: true once the adapter holds every confirmed
   * in-transit amount (the operator transferred it back), so the sweep returns this payout. Else waits (no attempt burnt).
   */
  private async operatorReturned(key: string): Promise<boolean> {
    const { chain, log } = this.ctx;
    const s = this.get(key);
    const f = await chain.adapterFlowState(s.adapter);
    const now = this.ctx.now();
    if (f.usdcBalance >= f.inTransitUsd) {
      if (s.returnWaitSince !== undefined) log.info({ bookId: s.bookId, nonce: s.nonce, waitedMs: now - s.returnWaitSince }, "builder IF account: the operator returned the payout to the adapter");
      return true;
    }
    if (s.returnWaitSince === undefined) {
      this.patch(key, { returnWaitSince: now });
      log.warn(
        { bookId: s.bookId, nonce: s.nonce, amount: s.amount, owner: sagaReceiver(s), adapter: s.adapter, adapterBalance: f.usdcBalance.toString(), inTransit: f.inTransitUsd.toString() },
        "builder IF account: Orderly paid the IF withdrawal to the operator's wallet — the operator must transfer it to the adapter; ops-venue re-checks every minute",
      );
    }
    this.nextAttemptAt.set(key, now + (this.ctx.settings.ifOperatorRecheckMs ?? DELIST_WAIT_MS));
    return false;
  }

  /** POST the venue withdrawal unless an earlier attempt already created it (see matchPriorWithdrawal). */
  private async venueRequest(s: WithdrawSaga, requestedAtSec: bigint): Promise<string> {
    const { builder, log } = this.ctx;
    const amount = BigInt(s.amount);
    const ref = `wr-${s.nonce}`;
    const claimed = new Set(
      Object.values(this.all())
        .filter((x) => x.key !== s.key && x.withdrawId)
        .map((x) => x.withdrawId as string),
    );
    const prior = matchPriorWithdrawal(await builder.withdrawals(s.accountId), { ref, amount, receiver: sagaReceiver(s), sinceMs: Number(requestedAtSec) * 1000, claimed });
    if (prior) {
      log.info({ bookId: s.bookId, nonce: s.nonce, withdrawId: String(prior.id), status: prior.status }, "venue withdrawal already requested by an earlier attempt — adopting it");
      return String(prior.id);
    }
    const r = await builder.requestWithdraw({ accountId: s.accountId, amountUsd: amount, to: sagaReceiver(s), nonce: ref, delegateContract: sagaReceiver(s) });
    return r.withdrawId;
  }

  private async mmFlat(book: TrackedBook): Promise<boolean> {
    const acct = await this.ctx.readAccount(book.accounts.mm, book.symbol, await this.ctx.keys.opsKey(book.bookId, "mm"));
    return !acct.position || acct.position.netQty === 0;
  }
}

function isInsufficient(err: unknown): boolean {
  return err instanceof OrderlyHttpError && (err.code === -1009 || /exceeds|insufficient/i.test(err.message));
}
