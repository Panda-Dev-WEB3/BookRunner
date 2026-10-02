// Venue report per Live/Retiring book every OPS_REPORT_INTERVAL_MS.
//
//   OPS_REPORT_MODE=signed (default, docs/LOW_GAS.md §2): the report is EIP-712 signed by the OPS_VENUE key
//     (domain verifyingContract = the book's adapter, src/report712.ts) and published to Redis
//     `bkrn:venue:report:<bookId>` (+ the `:recent` list). NO transaction: the mark keeper relays the latest
//     report inside its daily MarkRegistry.commitAndApply (OrderlyAdapter.reportSigned), desk hedge legs
//     carry it when they need a fresh exposure. An adapter whose implementation predates reportSigned gets
//     the same report posted with `report` as well (old deployments keep a fresh on-chain venue view).
//   OPS_REPORT_MODE=onchain: IOrderlyAdapter.report(insuranceUsd, marginUsd, netExposureUsd, asOf) tx.
//
// A report overwrites the adapter's venue-side balances with what the venue shows, so it must never be
// produced (signed or posted) while the venue and the adapter disagree about an in-flight flow:
//   - withdrawals: the venue debits the account at request time, the adapter only at confirmWithdraw.
//     No report while any withdraw saga of the book is between detection and sweep, or while the adapter
//     still has requested-but-unconfirmed amounts (a request not indexed yet, or a stuck one).
//   - deposits: the adapter credits them at once, the venue only after its indexer / cross-chain delivery.
//     No report within `reportSettleSec` (chain time) of the adapter's lastFlowAt.
// The whole read -> sign/post runs under the book's lock, so it cannot interleave with a withdraw saga step.
import { computeReport, dropSuspicious, reportableState, reportedValue } from "../domain/report";
import { isTerminal } from "../domain/withdraw";
import { toSignedVenueReportJson } from "../report712";
import { errMsg } from "../util";
import type { OpsContext, TrackedBook } from "./context";

export interface ReportResult {
  mode: "signed" | "onchain";
  asOf: bigint;
  /** on-chain report tx (onchain mode, or signed mode on an adapter without reportSigned) */
  tx: string | null;
  /** EIP-712 signature (signed mode) */
  signature: string | null;
}

export class Reporter {
  private readonly legacyWarned = new Set<string>();

  constructor(private readonly ctx: OpsContext) {}

  /** Tx hash (onchain) or the report signature (signed); null when nothing was reported. */
  async report(book: TrackedBook): Promise<string | null> {
    const r = await this.reportDetailed(book);
    return r ? (r.tx ?? r.signature) : null;
  }

  async reportDetailed(book: TrackedBook): Promise<ReportResult | null> {
    if (!reportableState(book.state)) return null;
    return this.ctx.locks.run(book.bookId, () => this.reportLocked(book));
  }

  /** Why a report must not be produced now (null = clear to report). Applies to signed and on-chain reports alike. */
  async holdReason(book: TrackedBook, headSec: bigint): Promise<string | null> {
    const inflight = Object.values(this.ctx.sagas.get().withdrawals).filter((w) => w.bookId === book.bookId && !isTerminal(w));
    if (inflight.length) return `withdrawal in flight (${inflight.map((w) => `${w.nonce}:${w.stage}`).join(",")})`;
    const f = await this.ctx.chain.adapterFlowState(book.adapter);
    if (f.pendingWithdrawUsd > 0n) return `adapter has ${f.pendingWithdrawUsd} requested-but-unconfirmed withdrawal`;
    const settle = BigInt(Math.max(0, Math.floor(this.ctx.settings.reportSettleSec)));
    if (f.lastFlowAt > 0n && headSec < f.lastFlowAt + settle) return `venue flow at ${f.lastFlowAt} still settling (head ${headSec})`;
    return null;
  }

  private async reportLocked(book: TrackedBook): Promise<ReportResult | null> {
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

    const fields = { insuranceUsd: r.insuranceUsd.toString(), marginUsd: r.marginUsd.toString(), netExposureUsd: r.netExposureUsd.toString(), asOf: Number(r.asOf) };
    let out: ReportResult;
    if (settings.reportMode === "signed") {
      const signer = this.ctx.reportSigner;
      const signature = await signer.sign(book.adapter, r);
      await this.ctx.reportPublisher.publish(
        toSignedVenueReportJson({ ...r, bookId: book.bookId, chainId: signer.chainId, adapter: book.adapter, signer: signer.address, signature, signedAt: this.ctx.now() }),
      );
      let tx: string | null = null;
      if (!(await this.adapterTakesSigned(book))) {
        if (!this.legacyWarned.has(k)) {
          this.legacyWarned.add(k);
          log.warn({ bookId: book.bookId, adapter: book.adapter }, "adapter implementation predates reportSigned — signed reports are also posted on-chain (OrderlyAdapter.report) until it is upgraded");
        }
        tx = await chain.report(book.adapter, r.insuranceUsd, r.marginUsd, r.netExposureUsd, r.asOf);
      }
      out = { mode: "signed", asOf: r.asOf, tx, signature };
      log.info({ bookId: book.bookId, ...fields, signer: signer.address, ...(tx ? { tx } : {}) }, "venue report signed and published");
    } else {
      const tx = await chain.report(book.adapter, r.insuranceUsd, r.marginUsd, r.netExposureUsd, r.asOf);
      out = { mode: "onchain", asOf: r.asOf, tx, signature: null };
      log.info({ bookId: book.bookId, tx, ...fields }, "venue report posted");
    }
    st.lastAsOf[k] = r.asOf.toString();
    st.reportGuard[k] = { value: value.toString(), at: this.ctx.now(), suspect: 0 };
    sagas.save();
    return out;
  }

  /** reportSigned available on the adapter (a failed check counts as available: never fall back to txs on an RPC blip). */
  private async adapterTakesSigned(book: TrackedBook): Promise<boolean> {
    try {
      return await this.ctx.chain.supportsReportSigned(book.adapter);
    } catch (err) {
      this.ctx.log.debug({ bookId: book.bookId, err: errMsg(err) }, "reportSigned support check failed; assuming supported");
      return true;
    }
  }
}
