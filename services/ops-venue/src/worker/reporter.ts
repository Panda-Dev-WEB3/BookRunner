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
//     No report within `reportSettleSec` (chain time) of the adapter's lastFlowAt, and never one whose asOf
//     is not strictly after lastFlowAt (OrderlyAdapter rejects asOf <= lastFlowAt: a snapshot from the
//     flow's own second may predate it).
// The whole read -> sign/post runs under the book's lock, so it cannot interleave with a withdraw saga step.
// Builder IF mode (domain/ifAccount.ts): a saga waiting for the operator to RETURN a payout (stage confirmed: the venue
// debit and the adapter's confirmation are both done) does not hold the book's reports, which would otherwise freeze for
// as long as a person takes; the operator's withdrawal itself (stage detected, on-chain Requested) still does (the
// adapter refuses reports while a request is Requested: the operator must withdraw promptly). A builder IF account found
// holding equity before the book's IF deposit is never reported (ifPriorEquity). Every report of a builder IF book checks
// the venue's IF equity against the adapter's insurance (last report adjusted by on-chain flows): a lower venue figure
// is an unexplained drop (operator key, ADL / insurance use), recorded for OPS_IF_DROP_ALERT_MS and alerted critical.
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
  private readonly ifDrops = new Map<number, { accountId: string; expectedUsd: string; venueUsd: string; at: number }>();

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

  /**
   * Why a report must not be produced now (null = clear to report). Applies to signed and on-chain reports alike.
   * `asOfSec` is the report's asOf (default: the chain head).
   */
  async holdReason(book: TrackedBook, headSec: bigint, asOfSec: bigint = headSec): Promise<string | null> {
    const prior = this.ctx.sagas.get().ifPriorEquity?.[book.adapter.toLowerCase()];
    if (prior) return `builder IF account ${book.accounts.if} held ${prior.usd} before the book's IF deposit (use a fresh EOA account)`;
    const inflight = Object.values(this.ctx.sagas.get().withdrawals).filter((w) => w.bookId === book.bookId && !isTerminal(w) && !(w.operatorIf && w.stage === "confirmed"));
    if (inflight.length) return `withdrawal in flight (${inflight.map((w) => `${w.nonce}:${w.stage}`).join(",")})`;
    const f = await this.ctx.chain.adapterFlowState(book.adapter);
    if (f.pendingWithdrawUsd > 0n) return `adapter has ${f.pendingWithdrawUsd} requested-but-unconfirmed withdrawal`;
    const settle = BigInt(Math.max(0, Math.floor(this.ctx.settings.reportSettleSec)));
    if (f.lastFlowAt > 0n && headSec < f.lastFlowAt + settle) return `venue flow at ${f.lastFlowAt} still settling (head ${headSec})`;
    if (asOfSec <= f.lastFlowAt) return `report asOf ${asOfSec} not strictly after the venue flow at ${f.lastFlowAt}`;
    return null;
  }

  private async reportLocked(book: TrackedBook): Promise<ReportResult | null> {
    const { keys, readAccount, sagas, chain, log, settings } = this.ctx;
    // asOf must not exceed block.timestamp of the simulation block (latest): clamp the wall clock to the head.
    const headSec = await chain.headTimestamp();
    const nowMs = Math.min(this.ctx.now(), Number(headSec) * 1000);
    const hold = await this.holdReason(book, headSec, BigInt(Math.floor(nowMs / 1000)));
    if (hold) {
      log.debug({ bookId: book.bookId, reason: hold }, "venue report held");
      return null;
    }
    const [ifKey, mmKey] = await Promise.all([keys.opsKey(book.bookId, "if"), keys.opsKey(book.bookId, "mm")]);
    const [ifAcct, mmAcct] = await Promise.all([readAccount(book.accounts.if, book.symbol, ifKey), readAccount(book.accounts.mm, book.symbol, mmKey)]);
    const st = sagas.get();
    const k = book.adapter.toLowerCase();
    const lastRaw = st.lastAsOf[k];
    const r = computeReport(ifAcct, mmAcct, book.symbol, nowMs, lastRaw ? BigInt(lastRaw) : null);
    if (!r) return null;
    // first report: compare against the charter's planned deployment (IF target + MM inventory)
    const guard = (st.reportGuard[k] ??= { value: (book.ifTargetUsd + book.mmInventoryUsd).toString(), at: 0, suspect: 0 });
    const withdrawnSince = Object.values(st.withdrawals)
      .filter((w) => w.bookId === book.bookId && w.updatedAt >= guard.at && w.stage !== "skipped" && w.stage !== "cancelled") // those moved nothing
      .reduce((x, w) => x + BigInt(w.amount), 0n);
    if (book.ifBinding === "builder") await this.checkIfDrop(book, r.insuranceUsd);
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

  /** Builder IF mode: venue IF equity below the adapter's insurance (last report + on-chain flows) = unexplained drop. */
  private async checkIfDrop(book: TrackedBook, venueIfUsd: bigint): Promise<void> {
    const { chain, log, settings } = this.ctx;
    const now = this.ctx.now();
    let expected: bigint;
    try {
      expected = (await chain.adapterFlowState(book.adapter)).insuranceUsd;
    } catch (err) {
      log.debug({ bookId: book.bookId, err: errMsg(err) }, "IF drop check: adapter read failed");
      return;
    }
    const tol = settings.ifDropToleranceUsd ?? 10_000n;
    if (venueIfUsd + tol < expected) {
      const prev = this.ifDrops.get(book.bookId);
      if (!prev || prev.venueUsd !== venueIfUsd.toString()) log.error({ bookId: book.bookId, accountId: book.accounts.if, expectedUsd: expected.toString(), venueUsd: venueIfUsd.toString() }, "builder IF account equity DROPPED below the adapter's insurance with no on-chain flow (operator key? insurance use?) — investigate");
      this.ifDrops.set(book.bookId, { accountId: book.accounts.if, expectedUsd: expected.toString(), venueUsd: venueIfUsd.toString(), at: now });
    }
    for (const [id, d] of this.ifDrops) if (now - d.at >= (settings.ifDropAlertMs ?? 86_400_000)) this.ifDrops.delete(id);
  }

  /** Builder IF mode: unexplained IF equity drops (kept OPS_IF_DROP_ALERT_MS after the last sighting), for alerts. */
  ifEquityDrops(): Array<{ bookId: number; accountId: string; expectedUsd: string; venueUsd: string; at: number }> {
    return [...this.ifDrops.entries()].map(([bookId, d]) => ({ bookId, ...d }));
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
