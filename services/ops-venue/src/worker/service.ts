// Wires the ops-venue workers together and runs the periodic loops.
import { busDropper, bytes32ToStr, CHANNELS, type KillMsg, type VenueOpsJob } from "@bookrunner/shared";
import type { AdapterLog, MandateLog } from "../chain";
import { pruneSagas } from "../store";
import { errMsg, runLoop } from "../util";
import { BookRegistry } from "./books";
import { prefixOf, toKey } from "../keys";
import { type OpsContext, type TrackedBook, tradable } from "./context";
import { FeeSweeper } from "./fees";
import { handleVenueOpsJob } from "./jobs";
import { LogWatcher } from "./logs";
import { NativeFeeKeeper } from "./native";
import type { Provisioner } from "./provision";
import { Reporter } from "./reporter";
import { Revoker } from "./revoke";
import { WithdrawProcessor } from "./withdrawals";

export interface LoopIntervals {
  bookPollMs: number;
  logPollMs: number;
  reportMs: number;
  feePollMs: number;
}

export class OpsService {
  readonly registry: BookRegistry;
  readonly reporter: Reporter;
  readonly withdrawals: WithdrawProcessor;
  readonly fees: FeeSweeper;
  readonly revoker: Revoker;
  readonly logs: LogWatcher;
  readonly native: NativeFeeKeeper;
  /** kill channels are namespaced per stack; a kill stamped with another stack's namespace is dropped (logged once) */
  private readonly foreignKill = busDropper((msg, meta) => this.ctx.log.warn(meta, msg));

  constructor(
    readonly ctx: OpsContext,
    readonly provisioner: Provisioner,
  ) {
    this.registry = new BookRegistry(ctx);
    this.reporter = new Reporter(ctx);
    this.withdrawals = new WithdrawProcessor(ctx, this.registry);
    this.registry.delistWaits = () => this.withdrawals.delistWaits();
    this.registry.ifOperatorWaits = () => this.withdrawals.ifOperatorWaits();
    this.registry.ifKeysPending = () => this.provisioner.pendingIfKeys();
    this.registry.ifReassign = () => this.provisioner.pendingReassign();
    this.registry.ifUnadopted = () => this.withdrawals.ifUnadopted();
    this.registry.ifEquityDrops = () => this.reporter.ifEquityDrops();
    this.registry.failedWithdrawals = () => this.withdrawals.failedSagas().map(({ operatorIf: _o, ...f }) => f);
    this.registry.ifPriorEquity = () => Object.entries(this.ctx.sagas.get().ifPriorEquity ?? {}).flatMap(([a, p]) => {
      const b = this.registry.byAdapter(a);
      return b ? [{ bookId: b.bookId, accountId: b.accounts.if, usd: p.usd, since: p.at }] : [];
    });
    this.fees = new FeeSweeper(ctx, this.registry);
    this.revoker = new Revoker(ctx, this.registry);
    this.native = new NativeFeeKeeper(ctx, ctx.settings.native ?? { topUpMaxWei: 0n, headroom: 2n, cooldownMs: 3_600_000 });
    this.logs = new LogWatcher(ctx, this.registry, {
      onAdapterLog: (l) => this.onAdapterLog(l),
      onMandateLog: (l, b) => this.onMandateLog(l, b),
    });
  }

  private async onAdapterLog(l: AdapterLog) {
    if (l.kind === "WithdrawRequested") await this.withdrawals.onRequested(l);
    else this.fees.noteSwept(l.adapter, l.period, l.amount, l.block, l.txHash, l.logIndex);
  }

  private async onMandateLog(l: MandateLog, book: TrackedBook) {
    // Replays are safe: act only on the mandate's CURRENT state.
    const killed = await this.ctx.chain.mandateKilled(book.mandate);
    if (l.kind === "Kill" && killed) {
      await this.revoker.revoke(book.bookId, bytes32ToStr(l.reason) || "KILL", "mandate_kill");
    } else if (l.kind === "Remandated" && !killed) {
      await this.provisioner.rotateTradeKey(book);
    }
  }

  /**
   * Books loop: discover/refresh, provision new books, re-provision on state change, listing checks (each symbol on its
   * own backoff, worker/listing.ts), then the status for alerts. Every book is isolated: one failing never stops another.
   */
  async syncBooks(): Promise<void> {
    const delta = await this.registry.refresh({ publish: false });
    for (const b of [...delta.added, ...delta.changed.map((c) => c.book)]) {
      try {
        await this.provisioner.ensure(b);
      } catch (err) {
        this.ctx.log.warn({ bookId: b.bookId, err: errMsg(err) }, "provisioning failed (will retry)");
      }
    }
    for (const r of delta.rebound) {
      const b = r.book;
      const oldKey = this.ctx.keys.loadBook(b.bookId)?.ops.if ?? null; // ensure() replaces it with a key for the new account
      try {
        await this.provisioner.ensure(b, true); // new IF account id: new IF ops key, delegates / registration again
      } catch (err) {
        this.ctx.log.warn({ bookId: b.bookId, err: errMsg(err) }, "re-provisioning after an IF account change failed (will retry)");
      }
      // the previous IF account's ops key is of no further use: remove it from Orderly (best effort) and keep it in history
      if (oldKey && oldKey.accountId.toLowerCase() === r.from.toLowerCase()) {
        if (oldKey.registeredAt) {
          try {
            await this.ctx.builder.removeKeyWith(oldKey.accountId, await toKey(oldKey), oldKey.orderlyKey);
            this.ctx.log.info({ bookId: b.bookId, accountId: oldKey.accountId, key: prefixOf(oldKey) }, "previous IF account's ops key removed from Orderly");
          } catch (err) {
            this.ctx.log.warn({ bookId: b.bookId, accountId: oldKey.accountId, key: prefixOf(oldKey), err: errMsg(err) }, "could not remove the previous IF account's ops key (remove it in Orderly One)");
          }
        }
        this.ctx.keys.addHistory(b.bookId, oldKey, "if_account_switched", this.ctx.now());
      }
      if (tradable(b) && (b.listing?.phase === "listed" || (this.ctx.settings.listingMode ?? "api") === "api")) this.provisioner.noteReassign(b, r.from);
      // a fresh binding gets a fresh prior-equity verdict
      const pe = this.ctx.sagas.get().ifPriorEquity;
      if (pe?.[b.adapter.toLowerCase()]) {
        delete pe[b.adapter.toLowerCase()];
        this.ctx.sagas.save();
      }
    }
    // retry books whose provisioning failed earlier
    for (const b of this.registry.list()) {
      try {
        await this.provisioner.ensure(b);
      } catch (err) {
        this.ctx.log.debug({ bookId: b.bookId, err: errMsg(err) }, "provisioning retry failed");
      }
    }
    // builder IF mode: has the operator registered ops-venue's IF key yet? (throttled per book)
    for (const b of this.registry.list()) {
      if (b.ifBinding !== "builder" || b.state === "Cancelled" || b.state === "Retired") continue;
      await this.provisioner.checkBuilderIfKey(b).catch((err) => this.ctx.log.debug({ bookId: b.bookId, err: errMsg(err) }, "builder IF key check failed"));
      await this.provisioner.checkPriorEquity(b).catch((err) => this.ctx.log.debug({ bookId: b.bookId, err: errMsg(err) }, "builder IF prior-equity check failed"));
    }
    await this.provisioner.listing.check(this.registry.list());
    await this.registry.publishStatus();
  }

  async reportAll(): Promise<void> {
    for (const b of this.registry.list()) {
      try {
        await this.reporter.report(b);
      } catch (err) {
        this.ctx.log.warn({ bookId: b.bookId, err: errMsg(err) }, "venue report failed");
      }
    }
  }

  async onKillMessage(raw: string): Promise<void> {
    let msg: KillMsg;
    try {
      msg = JSON.parse(raw) as KillMsg;
    } catch {
      this.ctx.log.warn({ raw: raw.slice(0, 200) }, "unparseable kill message");
      return;
    }
    if (this.foreignKill(CHANNELS.killPattern, msg)) return; // another stack's kill: never revoke our keys for it
    if (!this.registry.get(msg.bookId) && !this.ctx.keys.loadBook(msg.bookId)) return; // not an Orderly book
    // Redis is not trusted: cancel now, revoke only once the mandate is killed on-chain (revoke.ts)
    await this.revoker.revokeIfKilledOnChain(Number(msg.bookId), String(msg.reason || "RISK_KILL"), "kill_channel");
  }

  handleJob(job: VenueOpsJob) {
    return handleVenueOpsJob(job, { ctx: this.ctx, registry: this.registry, provisioner: this.provisioner, reporter: this.reporter, withdrawals: this.withdrawals, fees: this.fees, revoker: this.revoker });
  }

  /** Runs all periodic loops until `signal` aborts. */
  run(signal: AbortSignal, iv: LoopIntervals): Promise<void[]> {
    const { log } = this.ctx;
    return Promise.all([
      runLoop(
        "books",
        iv.bookPollMs,
        async () => {
          await this.syncBooks();
          await this.native.checkAll(this.registry.list());
        },
        signal,
        log,
      ),
      runLoop(
        "logs+withdrawals",
        iv.logPollMs,
        async () => {
          await this.logs.poll();
          await this.withdrawals.processAll();
        },
        signal,
        log,
      ),
      runLoop("report", iv.reportMs, () => this.reportAll(), signal, log),
      runLoop(
        "fees",
        iv.feePollMs,
        async () => {
          if (this.ctx.settings.feeAuto) await this.fees.auto();
          if (pruneSagas(this.ctx.sagas.get(), this.ctx.now())) this.ctx.sagas.save();
        },
        signal,
        log,
      ),
    ]);
  }
}
