// Periodic IOrderlyAdapter.report(insuranceUsd, marginUsd, netExposureUsd, asOf) per Live/Retiring book.
//
// A report overwrites the adapter's venue-side balances with what the venue shows, so it must never be
// posted while the venue and the adapter disagree about an in-flight flow:
//   - withdrawals: the venue debits the account at request time, the adapter only at confirmWithdraw.
//     No report while any withdraw saga of the book is between detection and sweep, or while the adapter
//     still has requested-but-unconfirmed amounts (a request not indexed yet, or a stuck one).
//   - deposits: the adapter credits them at once, the venue only after its indexer / cross-chain delivery.
//     No report within `reportSettleSec` (chain time) of the adapter's lastFlowAt.
// The whole read -> post runs under the book's lock, so it cannot interleave with a withdraw saga step.
import { computeReport, dropSuspicious, reportableState, reportedValue } from "../domain/report";
import { isTerminal } from "../domain/withdraw";
import type { OpsContext, TrackedBook } from "./context";

export class Reporter {
  constructor(private readonly ctx: OpsContext) {}

  async report(book: TrackedBook): Promise<string | null> {
    if (!reportableState(book.state)) return null;
    return this.ctx.locks.run(book.bookId, () => this.reportLocked(book));
  }

  /** Why a report must not be posted now (null = clear to report). */
  async holdReason(book: TrackedBook, headSec: bigint): Promise<string | null> {
    const inflight = Object.values(this.ctx.sagas.get().withdrawals).filter((w) => w.bookId === book.bookId && !isTerminal(w));
    if (inflight.length) return `withdrawal in flight (${inflight.map((w) => `${w.nonce}:${w.stage}`).join(",")})`;
    const f = await this.ctx.chain.adapterFlowState(book.adapter);
    if (f.pendingWithdrawUsd > 0n) return `adapter has ${f.pendingWithdrawUsd} requested-but-unconfirmed withdrawal`;
    const settle = BigInt(Math.max(0, Math.floor(this.ctx.settings.reportSettleSec)));
    if (f.lastFlowAt > 0n && headSec < f.lastFlowAt + settle) return `venue flow at ${f.lastFlowAt} still settling (head ${headSec})`;
    return null;
  }

  private async reportLocked(book: TrackedBook): Promise<string | null> {
    const { keys, readAccount, sagas, chain, log, settings } = this.ctx;
    // asOf must not exceed block.timestamp of the simulation block (latest): clamp the wall clock to the head.
    const headSec = await chain.headTimestamp();
    const hold = await this.holdReason(book, headSec);
    if (hold) {
      log.debug({ bookId: book.bookId, reason: hold }, "venue report held");
      return null;
    }
    const [ifKey, mmKey] = await Promise.all([keys.opsKey(book.bookId, "if"), keys.opsKey(book.bookId, "mm")]);
    const [ifAcct, mmAcct] = await Promise.all([readAccount(book.accounts.if, book.symbol, ifKey), readAccount(book.accounts.mm, book.symbol, mmKey)]);
    const st = sagas.get();
    const k = book.adapter.toLowerCase();
    const lastRaw = st.lastAsOf[k];
    const r = computeReport(ifAcct, mmAcct, book.symbol, Math.min(this.ctx.now(), Number(headSec) * 1000), lastRaw ? BigInt(lastRaw) : null);
    if (!r) return null;
    // first report: compare against the charter's planned deployment (IF target + MM inventory)
    const guard = (st.reportGuard[k] ??= { value: (book.ifTargetUsd + book.mmInventoryUsd).toString(), at: 0, suspect: 0 });
    const withdrawnSince = Object.values(st.withdrawals)
      .filter((w) => w.bookId === book.bookId && w.updatedAt >= guard.at && w.stage !== "skipped" && w.stage !== "cancelled") // those moved nothing
      .reduce((x, w) => x + BigInt(w.amount), 0n);
    const value = reportedValue(r);
    if (dropSuspicious({ lastValue: BigInt(guard.value), newValue: value, withdrawnSince, maxDropBps: settings.reportMaxDropBps })) {
      guard.suspect = (guard.suspect ?? 0) + 1;
      if (guard.suspect < settings.reportDropConfirmations) {
        sagas.save();
        log.warn({ bookId: book.bookId, lastValue: guard.value, newValue: value.toString(), seen: guard.suspect }, "venue value fell sharply — holding the report until the reading persists");
        return null;
      }
      log.warn({ bookId: book.bookId, lastValue: guard.value, newValue: value.toString() }, "sharp venue value fall persisted — reporting it");
    }
    const tx = await chain.report(book.adapter, r.insuranceUsd, r.marginUsd, r.netExposureUsd, r.asOf);
    st.lastAsOf[k] = r.asOf.toString();
    st.reportGuard[k] = { value: value.toString(), at: this.ctx.now(), suspect: 0 };
    sagas.save();
    log.info(
      { bookId: book.bookId, tx, insuranceUsd: r.insuranceUsd.toString(), marginUsd: r.marginUsd.toString(), netExposureUsd: r.netExposureUsd.toString(), asOf: Number(r.asOf) },
      "venue report posted",
    );
    return tx;
  }
}
