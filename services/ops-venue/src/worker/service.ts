// Wires the ops-venue workers together and runs the periodic loops.
import { bytes32ToStr, type KillMsg, type VenueOpsJob } from "@bookrunner/shared";
import type { AdapterLog, MandateLog } from "../chain";
import { pruneSagas } from "../store";
import { errMsg, runLoop } from "../util";
import { BookRegistry } from "./books";
import type { OpsContext, TrackedBook } from "./context";
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

  constructor(
    readonly ctx: OpsContext,
    readonly provisioner: Provisioner,
  ) {
    this.registry = new BookRegistry(ctx);
    this.reporter = new Reporter(ctx);
    this.withdrawals = new WithdrawProcessor(ctx, this.registry);
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

  /** Books loop: discover/refresh, provision new books, re-provision on state change. */
  async syncBooks(): Promise<void> {
    const delta = await this.registry.refresh();
    for (const b of [...delta.added, ...delta.changed.map((c) => c.book)]) {
      try {
        await this.provisioner.ensure(b);
      } catch (err) {
        this.ctx.log.warn({ bookId: b.bookId, err: errMsg(err) }, "provisioning failed (will retry)");
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
    if (!this.registry.get(msg.bookId) && !this.ctx.keys.loadBook(msg.bookId)) return; // not an Orderly book
    await this.revoker.revoke(msg.bookId, msg.reason || "RISK_KILL", "kill_channel");
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
