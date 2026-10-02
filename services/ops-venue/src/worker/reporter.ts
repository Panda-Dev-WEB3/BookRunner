// Periodic IOrderlyAdapter.report(insuranceUsd, marginUsd, netExposureUsd, asOf) per Live/Retiring book.
import { computeReport, dropSuspicious, reportableState, reportedValue } from "../domain/report";
import type { OpsContext, TrackedBook } from "./context";

export class Reporter {
  constructor(private readonly ctx: OpsContext) {}

  async report(book: TrackedBook): Promise<string | null> {
    if (!reportableState(book.state)) return null;
    const { keys, readAccount, sagas, chain, log, settings } = this.ctx;
    const [ifKey, mmKey] = await Promise.all([keys.opsKey(book.bookId, "if"), keys.opsKey(book.bookId, "mm")]);
    const [ifAcct, mmAcct] = await Promise.all([readAccount(book.accounts.if, book.symbol, ifKey), readAccount(book.accounts.mm, book.symbol, mmKey)]);
    const st = sagas.get();
    const k = book.adapter.toLowerCase();
    const lastRaw = st.lastAsOf[k];
    // asOf must not exceed block.timestamp of the simulation block (latest): clamp the wall clock to the head.
    const headMs = Number(await chain.headTimestamp()) * 1000;
    const r = computeReport(ifAcct, mmAcct, book.symbol, Math.min(this.ctx.now(), headMs), lastRaw ? BigInt(lastRaw) : null);
    if (!r) return null;
    // first report: compare against the charter's planned deployment (IF target + MM inventory)
    const guard = (st.reportGuard[k] ??= { value: (book.ifTargetUsd + book.mmInventoryUsd).toString(), at: 0, suspect: 0 });
    const withdrawnSince = Object.values(st.withdrawals)
      .filter((w) => w.bookId === book.bookId && w.updatedAt >= guard.at)
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
