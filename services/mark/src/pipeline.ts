// Mark pipeline for one (book, periodEnd): snapshot at one block -> NAV, inventory root, receipts root,
// MarkPnl + hash -> EIP-712 sign -> ONE tx -> persist marks row + books NAV -> mark.committed.
//
// Low-gas mode (docs/LOW_GAS.md §1-§3):
//   - inputs: the oracle service's signed prices and ops-venue's signed venue report (Redis, MarkFeeds).
//     Desk tokens / the engine pool are valued at a signed price whenever it is newer than the stored
//     on-chain one (never from strict on-chain views that revert when no update landed recently); an
//     Orderly book's venue is valued from the newest signed report consistent with the snapshot block.
//   - tx: MarkRegistry.commitAndApply(m, sig, priceData, venueReport) — oracle.update(prices the NAV used),
//     OrderlyAdapter.reportSigned(the report the NAV used), commit and Book.applyMark, atomically. The tx is
//     simulated first; a venue report the adapter would reject now is left out (the NAV still uses it), then
//     the priceData, before giving up. A registry without commitAndApply (old deployment) or
//     MARK_COMMIT_MODE=legacy falls back to commit + applyMark (two txs, flowNonce-guarded, bounded retries).
import { type DomainEventPayloads, type Logger, type MarkInput, type MarkPnl, VENUE } from "@bookrunner/shared";
import { type BookLookup, type BookRef, type DomainEventSink, describeRevert, sleep, usd6 } from "@bookrunner/waterfall";
import type { Hex } from "viem";
import { type SignedVenueReport, encodeVenueReport, reportIncludable } from "../../ops-venue/src/report712";
import { buildInventory } from "./domain/inventory";
import { RETIRE_TOKEN_DUST_USD, composeNav, navCrossChecks, type NavComposition, writeOffRetiringDust } from "./domain/nav";
import { buildMarkPnl, pnlJsonHash } from "./domain/pnl";
import { previewTranches, type TranchePreview } from "./domain/preview";
import { type SignedPrice, encodePriceData, newestByUnderlying } from "./domain/prices";
import { venueReportAge } from "./domain/readiness";
import type { MarkSnapshot } from "./domain/types";
import { applySignedVenueReport } from "./domain/venue";
import type { MarkAppliedEvent, MarkChain, MarkFeeds, MarkRow, MarkSignerPort, MarkStore, ReceiptsRootPort } from "./ports";
import type { MarkSpool } from "./spool";

export class RetryableMarkError extends Error {}

/** 4 x the default maxPriceAge (300s): MMMandate's freshness rule for Orderly reports. */
export const DEFAULT_MAX_VENUE_REPORT_AGE_SEC = 1200;

export type CommitMode = "auto" | "legacy";

export interface MarkPipelineDeps {
  books: BookLookup;
  chain: MarkChain;
  store: MarkStore;
  receipts: ReceiptsRootPort;
  signer: MarkSignerPort;
  events: DomainEventSink;
  log: Logger;
  maxRetries: number;
  /** Snapshot block = head - confirmations. */
  confirmations: bigint;
  /** How long to wait for the period's last receipts window to close. */
  receiptsWaitMs: number;
  /**
   * Orderly books: max age (seconds, at the snapshot block) of the venue valuation (the signed report used,
   * else the adapter's last on-chain report). Older -> RetryableMarkError, nothing committed. Default 1200; 0 disables.
   */
  maxVenueReportAgeSec?: number;
  /** Retiring books: desk token positions worth less than this are valued at 0 (domain/nav.ts). */
  retireTokenDustUsd?: bigint;
  spool?: MarkSpool;
  /** DB write retries after on-chain actions. */
  dbRetries?: number;
  dbRetryBaseMs?: number;
  /** Signed prices + venue reports (Redis). Absent: on-chain values only (pre-low-gas behaviour). */
  feeds?: MarkFeeds;
  /** Chain the signed venue reports must be for. */
  chainId?: number;
  /** auto (default): commitAndApply when the registry has it; legacy: commit + applyMark. */
  commitMode?: CommitMode;
}

/** What the mark tx carries besides the signed mark. */
export interface MarkTxPlan {
  /** abi.encode(PriceUpdate[], bytes[]) of the signed prices the NAV used that the chain has not stored ("0x" = none). */
  priceData: Hex;
  prices: SignedPrice[];
  /** the signed venue report the NAV used (null: valued from the adapter's on-chain report) */
  report: SignedVenueReport | null;
  /** abi.encode(...) of `report` ("0x" = none); whether it is relayed is decided at send time */
  venueReport: Hex;
}

export interface ComputedMark {
  snapshot: MarkSnapshot;
  nav: NavComposition;
  preview: TranchePreview;
  inventoryRoot: Hex;
  receipts: { root: Hex; complete: boolean; windows: number; receipts: number };
  pnl: MarkPnl;
  input: MarkInput;
  tx: MarkTxPlan;
}

export type MarkOutcome =
  | { status: "applied"; markId: bigint; commitTx: Hex | string; applyTx: Hex; input: MarkInput; event: MarkAppliedEvent; atomic?: boolean }
  | { status: "already"; reason: string }
  | { status: "dry_run"; computed: ComputedMark }
  | { status: "unmarkable"; reason: string };

export interface RunOptions {
  dryRun?: boolean;
  allowIncompleteReceipts?: boolean;
  signal?: AbortSignal;
}

export const markDedupeKey = (markId: bigint | number) => `mark.committed:${markId}`;

export function markCommittedPayload(bookId: number, markId: bigint, input: MarkInput, ev: MarkAppliedEvent, commitTx: string): DomainEventPayloads["mark.committed"] {
  return {
    bookId,
    markId: Number(markId),
    periodEnd: Number(input.periodEnd),
    navUsd: usd6(ev.navUsd),
    seniorNav: usd6(ev.seniorNav),
    juniorNav: usd6(ev.juniorNav),
    receiptsRoot: input.receiptsRoot,
    txHash: commitTx,
  };
}

type ApplyResult = { ok: true; hash: Hex; applied: MarkAppliedEvent } | { ok: false; reason: "flow_nonce" } | { ok: false; reason: "revert"; error: unknown };

type AtomicOutcome =
  | { kind: "applied"; hash: Hex; markId: bigint; committedAt: Date; applied: MarkAppliedEvent; priceData: Hex; venueReport: Hex }
  | { kind: "flow_nonce" }
  | { kind: "taken"; reason: string }
  | { kind: "unsupported" };

export class MarkPipeline {
  private atomicKnown: boolean | null = null;

  constructor(private readonly d: MarkPipelineDeps) {}

  async run(job: { bookId: number; periodEnd: number }, opts: RunOptions = {}): Promise<MarkOutcome> {
    const { bookId, periodEnd } = job;
    const log = this.d.log.child({ bookId, periodEnd });
    const ref = await this.d.books.get(bookId);
    if (!ref) return { status: "unmarkable", reason: `unknown book ${bookId}` };
    const interval = await this.d.chain.markInterval();
    if (periodEnd <= 0 || periodEnd % interval !== 0) return { status: "unmarkable", reason: `periodEnd ${periodEnd} is not a multiple of markInterval ${interval}` };

    if (!opts.dryRun) {
      if ((await this.d.chain.lastMarkPeriodEnd(ref)) >= periodEnd) return { status: "already", reason: "book already applied a mark for this period" };
      const latest = await this.d.chain.latestCommitted(ref);
      if (latest && latest.periodEnd > periodEnd) return { status: "already", reason: `newer mark ${latest.markId} committed` };
      if (latest && latest.periodEnd === periodEnd && !latest.applied) {
        log.info({ markId: latest.markId }, "resuming committed, unapplied mark");
        const stored = await this.d.store.markForPeriod(bookId, periodEnd);
        const res = await this.tryApply(ref, latest.markId, latest.input);
        if (res.ok) {
          const commitTx = stored?.commitTx ?? (await this.d.chain.commitTxOf(latest.markId).catch(() => null)) ?? "";
          return this.finalize(ref, latest.markId, commitTx, latest.input, res, null, log);
        }
        if (res.reason === "revert") throw res.error;
        log.warn({ markId: latest.markId }, "committed mark is stale (flowNonce moved); recomputing");
      }
    }

    for (let attempt = 1; attempt <= this.d.maxRetries; attempt++) {
      const c = await this.compute(ref, periodEnd, interval, opts);
      if (opts.dryRun) return { status: "dry_run", computed: c };

      // never sign a NAV built on a stale venue valuation: a stalled reporter would otherwise
      // keep committing pre-outage equity (redemptions at inflated prices, drawdown kill blind)
      const maxAge = this.d.maxVenueReportAgeSec ?? DEFAULT_MAX_VENUE_REPORT_AGE_SEC;
      const report = venueReportAge(ref.venue, c.snapshot.venue.valuationAt, c.snapshot.blockTimestamp, maxAge);
      if (report.stale) {
        log.error(
          { valuationAt: c.snapshot.venue.valuationAt, blockTimestamp: c.snapshot.blockTimestamp, ageSec: report.ageSec, maxAgeSec: maxAge, source: c.snapshot.venue.source ?? "adapter" },
          "venue report stale; refusing to commit the mark (retrying once ops-venue reports again)",
        );
        throw new RetryableMarkError(`venue report stale: valuationAt ${c.snapshot.venue.valuationAt} is ${report.ageSec}s old (max ${maxAge}s)`);
      }

      if ((await this.d.chain.flowNonce(ref)) !== c.input.flowNonce) {
        log.info({ attempt }, "capital flow since snapshot; recomputing before commit");
        continue;
      }
      const signature = await this.d.signer.sign(c.input);
      const recovered = await this.d.signer.recover(c.input, signature);
      if (recovered.toLowerCase() !== this.d.signer.address.toLowerCase()) throw new Error(`EIP-712 signature recovers to ${recovered}, expected ${this.d.signer.address}`);
      const onchainDigest = await this.d.chain.hashMark(c.input);
      if (onchainDigest && onchainDigest.toLowerCase() !== this.d.signer.digest(c.input).toLowerCase()) {
        throw new Error(`MarkRegistry.hashMark ${onchainDigest} != local EIP-712 digest ${this.d.signer.digest(c.input)} (domain/typehash drift)`);
      }

      if (await this.atomicAvailable(log)) {
        const a = await this.commitAtomic(ref, c, signature, log);
        if (a.kind === "applied") {
          log.info(
            { markId: a.markId, tx: a.hash, nav: usd6(c.input.navUsd), receiptsRoot: c.input.receiptsRoot, prices: a.priceData === "0x" ? 0 : c.tx.prices.length, venueReport: a.venueReport !== "0x" },
            "mark committed and applied (commitAndApply)",
          );
          await this.saveCommittedDurably(this.row(bookId, periodEnd, c, signature, a.markId, a.hash, a.committedAt), log);
          return this.finalize(ref, a.markId, a.hash, c.input, { hash: a.hash, applied: a.applied }, c.preview, log, true);
        }
        if (a.kind === "flow_nonce") {
          log.warn({ attempt }, "flowNonce changed under the mark tx; recomputing");
          continue;
        }
        if (a.kind === "taken") return { status: "unmarkable", reason: a.reason };
        log.warn("MarkRegistry has no commitAndApply; using commit + applyMark");
        this.atomicKnown = false;
      }

      let committed: { hash: Hex; markId: bigint; committedAt: Date };
      try {
        committed = await this.d.chain.commit(c.input, signature);
      } catch (err) {
        const latest = await this.d.chain.latestCommitted(ref);
        if (latest && latest.periodEnd >= periodEnd) {
          return { status: "unmarkable", reason: `MarkRegistry already holds mark ${latest.markId} for periodEnd ${latest.periodEnd}; next period will mark (${describeRevert(err).message})` };
        }
        throw err;
      }
      log.info({ markId: committed.markId, tx: committed.hash, nav: usd6(c.input.navUsd), receiptsRoot: c.input.receiptsRoot }, "mark committed");
      await this.saveCommittedDurably(this.row(bookId, periodEnd, c, signature, committed.markId, committed.hash, committed.committedAt), log);

      const res = await this.tryApply(ref, committed.markId, c.input);
      if (res.ok) return this.finalize(ref, committed.markId, committed.hash, c.input, res, c.preview, log);
      if (res.reason === "revert") throw res.error;
      log.warn({ attempt, markId: committed.markId }, "flowNonce changed between commit and applyMark; recomputing");
    }
    return { status: "unmarkable", reason: `flowNonce changed on each of ${this.d.maxRetries} attempts` };
  }

  /** Snapshot at one block + all derived mark data (no side effects besides receipts roots). */
  async compute(ref: BookRef, periodEnd: number, interval: number, opts: RunOptions = {}): Promise<ComputedMark> {
    const log = this.d.log.child({ bookId: ref.bookId, periodEnd });
    // signed inputs first: the snapshot block is then never older than what they were produced against
    const [signedPrices, reports] = await Promise.all([this.signedPrices(log), this.venueReports(ref, log)]);
    const head = await this.d.chain.head();
    const block = head.blockNumber > this.d.confirmations ? head.blockNumber - this.d.confirmations : head.blockNumber;
    const raw = await this.d.chain.snapshot(ref, block, signedPrices);
    const overlay = applySignedVenueReport(raw, reports, { venue: ref.venue, adapter: ref.components.adapter, chainId: this.d.chainId ?? reports[0]?.chainId ?? 0 });
    if (overlay.rejected.length) log.debug({ rejected: overlay.rejected }, "signed venue reports not used for the valuation");
    const { snapshot, writtenOff } = writeOffRetiringDust(overlay.snapshot, this.d.retireTokenDustUsd ?? RETIRE_TOKEN_DUST_USD);
    if (writtenOff.length) {
      log.warn(
        { positions: writtenOff.map((p) => ({ token: p.token, qtyRaw: p.qtyRaw.toString(), valueUsd: usd6(p.valueUsd) })) },
        "Retiring: desk token dust below the flatten floor valued at 0 (finalizeRetirement needs deployedValueUsd == 0)",
      );
    }
    const nav = composeNav(snapshot);
    for (const w of navCrossChecks(snapshot, nav)) log.warn({ block: block.toString() }, `nav cross-check: ${w}`);
    const preview = previewTranches(snapshot, nav.navUsd);
    const inventory = buildInventory(snapshot);

    let receipts = await this.d.receipts.periodRoot(ref.bookId, periodEnd - interval, periodEnd);
    const deadline = Date.now() + this.d.receiptsWaitMs;
    while (!receipts.complete && Date.now() < deadline && !opts.signal?.aborted) {
      await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())), opts.signal);
      receipts = await this.d.receipts.periodRoot(ref.bookId, periodEnd - interval, periodEnd);
    }
    if (!receipts.complete && !opts.allowIncompleteReceipts) throw new RetryableMarkError(`receipts windows of period ${periodEnd} not all closed yet`);

    const dist = await this.d.store.distribution(ref.bookId, periodEnd);
    const pnl = buildMarkPnl({
      snapshot,
      periodEnd,
      nav,
      preview,
      extras: {
        feeFlowUsd: dist ? dist.senior + dist.junior : 0n,
        fundingUsd: await this.d.store.fundingInPeriod(ref.bookId, periodEnd - interval, periodEnd),
        prevUnrealizedUsd: await this.d.store.prevUnrealized(ref.bookId, periodEnd),
        lastQuoteSkewBps: await this.d.store.lastQuoteSkewBps(ref.bookId, periodEnd),
      },
    });
    const input: MarkInput = {
      bookId: BigInt(ref.bookId),
      periodEnd: BigInt(periodEnd),
      navUsd: nav.navUsd,
      deployedValueUsd: nav.deployedValueUsd,
      flowNonce: snapshot.flowNonce,
      inventoryRoot: inventory.root,
      pnlJsonHash: pnlJsonHash(pnl),
      receiptsRoot: receipts.root,
    };
    const prices = snapshot.signedPrices ?? [];
    const tx: MarkTxPlan = {
      priceData: encodePriceData(prices),
      prices,
      report: overlay.report,
      venueReport: overlay.report ? encodeVenueReport(overlay.report) : "0x",
    };
    log.info(
      {
        block: block.toString(),
        nav: usd6(nav.navUsd),
        deployed: usd6(nav.deployedValueUsd),
        vaultIdle: usd6(snapshot.vaultIdle),
        unfunded: usd6(snapshot.unfundedClaims),
        flowNonce: snapshot.flowNonce.toString(),
        markPnl: usd6(preview.result.pnl),
        seniorNav: usd6(preview.result.seniorNav),
        juniorNav: usd6(preview.result.juniorNav),
        receipts: receipts.receipts,
        killAtMark: preview.killAtMark,
        venueSource: snapshot.venue.source ?? "adapter",
        valuationAt: snapshot.venue.valuationAt,
        signedPrices: prices.map((p) => p.priceId ?? p.underlying),
      },
      "mark computed",
    );
    return { snapshot, nav, preview, inventoryRoot: inventory.root, receipts, pnl, input, tx };
  }

  // ------------------------------------------------------------------ feeds

  private async signedPrices(log: Logger): Promise<Map<string, SignedPrice>> {
    if (!this.d.feeds) return new Map();
    try {
      return newestByUnderlying(await this.d.feeds.signedPrices());
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "signed price feed unavailable; valuing at the stored on-chain prices");
      return new Map();
    }
  }

  private async venueReports(ref: BookRef, log: Logger): Promise<SignedVenueReport[]> {
    if (!this.d.feeds || ref.venue !== VENUE.ORDERLY) return [];
    try {
      return await this.d.feeds.venueReports(ref);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "signed venue reports unavailable; valuing from the adapter's on-chain report");
      return [];
    }
  }

  // ------------------------------------------------------------------ one-tx path

  private async atomicAvailable(log: Logger): Promise<boolean> {
    if ((this.d.commitMode ?? "auto") === "legacy") return false;
    if (this.atomicKnown !== null) return this.atomicKnown;
    try {
      this.atomicKnown = await this.d.chain.supportsCommitAndApply();
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "could not check MarkRegistry for commitAndApply; trying it");
      return true; // an unsupported registry is detected again by the simulation
    }
    if (!this.atomicKnown) log.warn("MarkRegistry has no commitAndApply (pre-low-gas deployment): marking with commit + applyMark");
    return this.atomicKnown;
  }

  private async commitAtomic(ref: BookRef, c: ComputedMark, signature: Hex, log: Logger): Promise<AtomicOutcome> {
    const periodEnd = Number(c.input.periodEnd);
    let venueReport: Hex = c.tx.venueReport;
    if (venueReport !== "0x" && c.tx.report) {
      const [state, head] = await Promise.all([this.d.chain.adapterReportState(ref).catch(() => null), this.d.chain.head()]);
      const why = state ? reportIncludable(c.tx.report, state, BigInt(head.timestamp)) : "adapter report state unreadable";
      if (why) {
        log.info({ asOf: Number(c.tx.report.asOf), why }, "signed venue report not relayed in the mark tx (the NAV is valued from it all the same)");
        venueReport = "0x";
      }
    }
    // first variant that simulates: everything, then without the venue report, then without the prices
    const variants: Array<[Hex, Hex]> = [];
    const push = (v: [Hex, Hex]) => {
      if (!variants.some((x) => x[0] === v[0] && x[1] === v[1])) variants.push(v);
    };
    push([c.tx.priceData, venueReport]);
    push([c.tx.priceData, "0x"]);
    push(["0x", "0x"]);
    let chosen: [Hex, Hex] | null = null;
    const errors: string[] = [];
    for (const v of variants) {
      const sim = await this.d.chain.simulateCommitAndApply(ref, c.input, signature, v[0], v[1]);
      if (sim.ok) {
        chosen = v;
        break;
      }
      if (sim.unsupported) return { kind: "unsupported" };
      errors.push(sim.error);
      if ((await this.d.chain.flowNonce(ref)) !== c.input.flowNonce) return { kind: "flow_nonce" };
    }
    if (!chosen) {
      const taken = await this.periodTaken(ref, periodEnd);
      if (taken) return { kind: "taken", reason: `${taken} (${errors[0] ?? "simulation failed"})` };
      throw new Error(`commitAndApply simulation failed: ${errors.join(" | ")}`);
    }
    if (chosen[0] !== c.tx.priceData || chosen[1] !== venueReport) {
      log.warn({ errors, priceData: chosen[0] !== "0x", venueReport: chosen[1] !== "0x" }, "mark tx sent without the parts that would revert it");
    }
    try {
      const r = await this.d.chain.commitAndApply(ref, c.input, signature, chosen[0], chosen[1]);
      return { kind: "applied", ...r, priceData: chosen[0], venueReport: chosen[1] };
    } catch (err) {
      if ((await this.d.chain.flowNonce(ref)) !== c.input.flowNonce) return { kind: "flow_nonce" };
      const taken = await this.periodTaken(ref, periodEnd);
      if (taken) return { kind: "taken", reason: `${taken} (${describeRevert(err).message})` };
      throw err;
    }
  }

  /** Someone else committed / applied this period (or a later one) meanwhile. */
  private async periodTaken(ref: BookRef, periodEnd: number): Promise<string | null> {
    if ((await this.d.chain.lastMarkPeriodEnd(ref)) >= periodEnd) return `book already applied a mark for periodEnd ${periodEnd}`;
    const latest = await this.d.chain.latestCommitted(ref);
    if (latest && latest.periodEnd > periodEnd) return `MarkRegistry already holds newer mark ${latest.markId}`;
    return null;
  }

  // ------------------------------------------------------------------ helpers

  private row(bookId: number, periodEnd: number, c: ComputedMark, signature: Hex, markId: bigint, commitTx: Hex, committedAt: Date): MarkRow {
    return {
      markId: Number(markId),
      bookId,
      periodEnd,
      input: c.input,
      pnl: c.pnl,
      signer: this.d.signer.address,
      signature,
      commitTx,
      committedAt,
      preview: {
        seniorNav: c.preview.result.seniorNav,
        juniorNav: c.preview.result.juniorNav,
        seniorPrice: c.preview.seniorPrice,
        juniorPrice: c.preview.juniorPrice,
        pnlUsd: c.preview.result.pnl,
      },
    };
  }

  private async tryApply(ref: BookRef, markId: bigint, input: MarkInput): Promise<ApplyResult> {
    if ((await this.d.chain.flowNonce(ref)) !== input.flowNonce) return { ok: false, reason: "flow_nonce" };
    try {
      const r = await this.d.chain.applyMark(ref, markId);
      return { ok: true, hash: r.hash, applied: r.applied };
    } catch (error) {
      if ((await this.d.chain.flowNonce(ref)) !== input.flowNonce) return { ok: false, reason: "flow_nonce" };
      return { ok: false, reason: "revert", error };
    }
  }

  private async finalize(
    ref: BookRef,
    markId: bigint,
    commitTx: Hex | string,
    input: MarkInput,
    res: { hash: Hex; applied: MarkAppliedEvent },
    preview: TranchePreview | null,
    log: Logger,
    atomic = false,
  ): Promise<MarkOutcome> {
    const ev = res.applied;
    log.info({ markId, tx: res.hash, nav: usd6(ev.navUsd), seniorNav: usd6(ev.seniorNav), juniorNav: usd6(ev.juniorNav), pnl: usd6(ev.pnlUsd) }, "mark applied");
    if (preview && (preview.result.seniorNav !== ev.seniorNav || preview.result.juniorNav !== ev.juniorNav)) {
      log.warn(
        { preview: { seniorNav: usd6(preview.result.seniorNav), juniorNav: usd6(preview.result.juniorNav) }, applied: { seniorNav: usd6(ev.seniorNav), juniorNav: usd6(ev.juniorNav) } },
        "applied tranche NAVs differ from the applyMarkPnl preview",
      );
    }
    await this.withDbRetry("saveApplied", () => this.d.store.saveApplied(Number(markId), res.hash, ev), log);
    await this.withDbRetry("updateBookNav", () => this.d.store.updateBookNav(ref.bookId, Number(markId), ev), log);
    await this.withDbRetry("mark.committed", () => this.d.events.publish("mark.committed", ref.bookId, markCommittedPayload(ref.bookId, markId, input, ev, commitTx), markDedupeKey(markId)).then(() => undefined), log);
    return { status: "applied", markId, commitTx, applyTx: res.hash, input, event: ev, ...(atomic ? { atomic: true } : {}) };
  }

  private async saveCommittedDurably(row: MarkRow, log: Logger) {
    try {
      await this.withDbRetry("saveCommitted", () => this.d.store.saveCommitted(row), log, true);
    } catch (err) {
      if (!this.d.spool) throw err;
      const file = this.d.spool.write(row);
      log.error({ err, file, markId: row.markId }, "marks row spooled to disk; it is flushed into Postgres on the next tick");
    }
  }

  private async withDbRetry(what: string, fn: () => Promise<void>, log: Logger, rethrow = false) {
    const attempts = this.d.dbRetries ?? 5;
    const base = this.d.dbRetryBaseMs ?? 1_000;
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i >= attempts) {
          log.error({ err, what }, "db write failed after retries");
          if (rethrow) throw err;
          return;
        }
        await sleep(base * 2 ** (i - 1));
      }
    }
  }
}
