// Executes adapter withdrawals (saga: domain/withdraw.ts):
//   WithdrawRequested -> [on-chain status still Requested] -> Orderly withdraw request (delegate signer)
//   -> adapter.confirmWithdraw (BEFORE any USDC can reach the adapter) -> payout (mock:
//   MockOrderlyVault.operatorWithdraw; live: Orderly pays, VERIFY) -> sweepToVault.
// Saga state persists in the saga store and every step is idempotent / resumable: the adapter's
// on-chain request status gates each step (old or replayed requests are never executed again), and every
// tx is recorded before its receipt is awaited and inspected on retry instead of being re-sent (txonce.ts).
import { ACCOUNT } from "@bookrunner/shared";
import type { Hex } from "viem";
import { type AdapterLog, WITHDRAW_STATUS, withdrawStatusName, type WriteOpts } from "../chain";
import { isTerminal, matchPriorWithdrawal, newWithdrawSaga, nextStep, retryDelayMs, sagaKey, shortfall, transition, type WithdrawEvent, type WithdrawSaga, type WithdrawTxSlot } from "../domain/withdraw";
import { OrderlyHttpError } from "../orderly/http";
import { errMsg } from "../util";
import type { BookRegistry } from "./books";
import type { OpsContext, TrackedBook } from "./context";
import { sendOnce } from "./txonce";

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
    const s = newWithdrawSaga({ bookId: book.bookId, adapter: l.adapter, account: l.account, accountId: l.account === ACCOUNT.IF ? book.accounts.if : book.accounts.mm, amount: l.amount, nonce: l.nonce, txHash: l.txHash }, this.ctx.now());
    if (this.all()[s.key]) return this.all()[s.key] ?? null; // recorded meanwhile
    this.all()[s.key] = s;
    this.ctx.sagas.save();
    this.ctx.log.info({ bookId: book.bookId, account: l.account, amount: l.amount.toString(), nonce: l.nonce.toString(), tx: l.txHash }, "withdraw requested on adapter");
    return s;
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
        try {
          return { type: "venue_requested", withdrawId: await this.venueRequest(s, st.requestedAt) };
        } catch (err) {
          if (book && s.account === ACCOUNT.IF && isInsufficient(err) && book.state === "Retiring" && (await this.mmFlat(book))) {
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
        if (rec?.status === "COMPLETED") return { type: "venue_paid", ...(rec.txHash ? { payTx: rec.txHash as Hex } : s.payTx ? { payTx: s.payTx } : {}) };
        if (rec?.status === "FAILED") {
          if (s.payTx || s.txs?.pay) return { type: "error", error: `venue withdrawal ${wid} FAILED after the mock payout was sent — manual reconcile`, fatal: true };
          // confirmed on-chain, failed on the venue (funds credited back): Confirmed -> Failed
          const c = await this.once(key, "cancel", (o) => chain.failWithdraw(s.adapter, nonce, o));
          if (!c) return null;
          return { type: "cancelled", reason: `venue withdrawal ${wid} FAILED after confirmation`, ...(c.hash ? { cancelTx: c.hash } : {}) };
        }
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
      const p = await this.once(key, "pay", (o) => chain.vaultOperatorWithdraw(s.accountId, s.adapter, amount, o));
      if (!p) return null;
      s = this.patch(key, { payTx: p.hash as Hex });
    }
    await builder.mockCompleteWithdraw(s.withdrawId as string, s.payTx as string);
    return { type: "venue_paid", ...(s.payTx ? { payTx: s.payTx } : {}) };
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
    const prior = matchPriorWithdrawal(await builder.withdrawals(s.accountId), { ref, amount, receiver: s.adapter, sinceMs: Number(requestedAtSec) * 1000, claimed });
    if (prior) {
      log.info({ bookId: s.bookId, nonce: s.nonce, withdrawId: String(prior.id), status: prior.status }, "venue withdrawal already requested by an earlier attempt — adopting it");
      return String(prior.id);
    }
    const r = await builder.requestWithdraw({ accountId: s.accountId, amountUsd: amount, to: s.adapter, nonce: ref, delegateContract: s.adapter });
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
