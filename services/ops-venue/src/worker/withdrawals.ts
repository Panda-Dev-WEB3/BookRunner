// Executes adapter withdrawals: WithdrawRequested -> Orderly withdraw request (delegate signer) ->
// payment (mock: MockOrderlyVault.operatorWithdraw; live: Orderly pays, VERIFY) -> confirmWithdraw ->
// sweepToVault. Saga state persists in the saga store; every step is idempotent / resumable.
import { ACCOUNT } from "@bookrunner/shared";
import type { Hex } from "viem";
import type { AdapterLog } from "../chain";
import { isTerminal, looksAlreadyConfirmed, newWithdrawSaga, nextStep, retryDelayMs, shortfall, transition, type WithdrawEvent, type WithdrawSaga } from "../domain/withdraw";
import { OrderlyHttpError } from "../orderly/http";
import { errMsg } from "../util";
import type { BookRegistry } from "./books";
import type { OpsContext, TrackedBook } from "./context";

export class WithdrawProcessor {
  private readonly nextAttemptAt = new Map<string, number>();

  constructor(
    private readonly ctx: OpsContext,
    private readonly registry: BookRegistry,
  ) {}

  private all(): Record<string, WithdrawSaga> {
    return this.ctx.sagas.get().withdrawals;
  }

  /** Record a WithdrawRequested log (idempotent). */
  onRequested(l: Extract<AdapterLog, { kind: "WithdrawRequested" }>): WithdrawSaga | null {
    const book = this.registry.byAdapter(l.adapter);
    if (!book) return null;
    const sagas = this.all();
    const s = newWithdrawSaga({ bookId: book.bookId, adapter: l.adapter, account: l.account, accountId: l.account === ACCOUNT.IF ? book.accounts.if : book.accounts.mm, amount: l.amount, nonce: l.nonce, txHash: l.txHash }, this.ctx.now());
    if (sagas[s.key]) return sagas[s.key] ?? null;
    sagas[s.key] = s;
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

  private save(s: WithdrawSaga) {
    this.all()[s.key] = s;
    this.ctx.sagas.save();
  }

  private apply(s: WithdrawSaga, ev: WithdrawEvent): WithdrawSaga {
    const next = transition(s, ev, this.ctx.now(), this.ctx.settings.withdrawMaxAttempts);
    this.save(next);
    if (ev.type === "error") {
      this.nextAttemptAt.set(s.key, this.ctx.now() + retryDelayMs(next.attempts));
      const lvl = next.stage === "failed" ? "error" : next.attempts % 5 === 1 ? "warn" : "debug";
      this.ctx.log[lvl]({ bookId: s.bookId, nonce: s.nonce, stage: s.stage, attempts: next.attempts, err: ev.error }, next.stage === "failed" ? "withdraw saga FAILED — manual action required" : "withdraw step failed");
    } else {
      this.nextAttemptAt.delete(s.key);
      this.ctx.log.info({ bookId: s.bookId, nonce: s.nonce, stage: next.stage }, "withdraw saga advanced");
    }
    return next;
  }

  async process(key: string): Promise<WithdrawSaga> {
    const first = this.all()[key];
    if (!first) throw new Error(`unknown withdraw saga ${key}`);
    return this.ctx.locks.run(first.bookId, async () => {
      let s = this.all()[key] as WithdrawSaga;
      for (let guard = 0; guard < 6 && !isTerminal(s); guard++) {
        const step = nextStep(s);
        if (!step) break;
        let ev: WithdrawEvent | null;
        try {
          ev = await this.runStep(step, s);
        } catch (err) {
          ev = { type: "error", error: errMsg(err) };
        }
        if (!ev) break; // waiting on the venue
        s = this.apply(s, ev);
        if (ev.type === "error") break;
      }
      return s;
    });
  }

  private async runStep(step: NonNullable<ReturnType<typeof nextStep>>, s: WithdrawSaga): Promise<WithdrawEvent | null> {
    const { builder, chain, settings, log } = this.ctx;
    const amount = BigInt(s.amount);
    switch (step) {
      case "request": {
        const book = this.registry.get(s.bookId);
        try {
          const r = await builder.requestWithdraw({ accountId: s.accountId, amountUsd: amount, to: s.adapter, nonce: `wr-${s.nonce}`, delegateContract: s.adapter });
          return { type: "venue_requested", withdrawId: r.withdrawId };
        } catch (err) {
          if (book && s.account === ACCOUNT.IF && isInsufficient(err) && book.state === "Retiring" && (await this.mmFlat(book))) {
            log.info({ bookId: s.bookId, symbol: book.symbol }, "retiring book: delisting symbol to release the insurance fund");
            await builder.setSymbolStatus(book.symbol, "DELISTED");
            const r = await builder.requestWithdraw({ accountId: s.accountId, amountUsd: amount, to: s.adapter, nonce: `wr-${s.nonce}`, delegateContract: s.adapter });
            return { type: "venue_requested", withdrawId: r.withdrawId };
          }
          throw err;
        }
      }
      case "pay": {
        const wid = s.withdrawId as string;
        const rec = await builder.withdrawal(s.accountId, wid);
        if (rec?.status === "COMPLETED") return { type: "venue_paid", ...(rec.txHash ? { payTx: rec.txHash as Hex } : {}) };
        if (rec?.status === "FAILED") return { type: "error", error: `venue withdrawal ${wid} FAILED`, fatal: true };
        if (settings.mode === "live") return null; // VERIFY: Orderly pays out asynchronously; poll until COMPLETED
        if (s.payTx) {
          // paid on-chain before a crash; only the venue acknowledgement is missing
          await builder.mockCompleteWithdraw(wid, s.payTx);
          return { type: "venue_paid", payTx: s.payTx };
        }
        const need = shortfall(await chain.vaultLedger(s.accountId), amount);
        if (need > 0n) {
          const creditTx = await chain.vaultCreditFees(s.accountId, need);
          log.info({ bookId: s.bookId, accountId: s.accountId, amount: need.toString(), tx: creditTx }, "mock vault: materialised venue PnL before payout");
        }
        const payTx = await chain.vaultOperatorWithdraw(s.accountId, s.adapter, amount);
        this.save({ ...s, payTx, updatedAt: this.ctx.now() });
        await builder.mockCompleteWithdraw(wid, payTx);
        return { type: "venue_paid", payTx };
      }
      case "confirm": {
        const sim = await chain.simulateConfirmWithdraw(s.adapter, BigInt(s.nonce));
        if (sim.ok) return { type: "confirmed", confirmTx: await chain.confirmWithdraw(s.adapter, BigInt(s.nonce)) };
        if (looksAlreadyConfirmed(sim.error) && s.payTx) {
          log.warn({ bookId: s.bookId, nonce: s.nonce, err: sim.error }, "confirmWithdraw reverts as already confirmed — continuing");
          return { type: "confirmed" };
        }
        return { type: "error", error: `confirmWithdraw simulation: ${sim.error}` };
      }
      case "sweep":
        return { type: "swept", sweepTx: await chain.sweepToVault(s.adapter) };
    }
  }

  private async mmFlat(book: TrackedBook): Promise<boolean> {
    const acct = await this.ctx.readAccount(book.accounts.mm, book.symbol, await this.ctx.keys.opsKey(book.bookId, "mm"));
    return !acct.position || acct.position.netQty === 0;
  }
}

function isInsufficient(err: unknown): boolean {
  return err instanceof OrderlyHttpError && (err.code === -1009 || /exceeds|insufficient/i.test(err.message));
}
