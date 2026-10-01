// Mark pipeline for one (book, periodEnd): snapshot at one block -> NAV, inventory root, receipts root,
// MarkPnl + hash -> EIP-712 sign -> MarkRegistry.commit -> Book.applyMark (flowNonce-guarded, bounded
// retries) -> persist marks row + books NAV -> mark.committed.
import type { DomainEventPayloads, Logger, MarkInput, MarkPnl } from "@bookrunner/shared";
import { type BookLookup, type BookRef, type DomainEventSink, describeRevert, sleep, usd6 } from "@bookrunner/waterfall";
import type { Hex } from "viem";
import { buildInventory } from "./domain/inventory";
import { composeNav, navCrossChecks, type NavComposition } from "./domain/nav";
import { buildMarkPnl, pnlJsonHash } from "./domain/pnl";
import { previewTranches, type TranchePreview } from "./domain/preview";
import type { MarkSnapshot } from "./domain/types";
import type { MarkAppliedEvent, MarkChain, MarkRow, MarkSignerPort, MarkStore, ReceiptsRootPort } from "./ports";
import type { MarkSpool } from "./spool";

export class RetryableMarkError extends Error {}

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
  spool?: MarkSpool;
  /** DB write retries after on-chain actions. */
  dbRetries?: number;
  dbRetryBaseMs?: number;
}

export interface ComputedMark {
  snapshot: MarkSnapshot;
  nav: NavComposition;
  preview: TranchePreview;
  inventoryRoot: Hex;
  receipts: { root: Hex; complete: boolean; windows: number; receipts: number };
  pnl: MarkPnl;
  input: MarkInput;
}

export type MarkOutcome =
  | { status: "applied"; markId: bigint; commitTx: Hex | string; applyTx: Hex; input: MarkInput; event: MarkAppliedEvent }
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

export class MarkPipeline {
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

      const row: MarkRow = {
        markId: Number(committed.markId),
        bookId,
        periodEnd,
        input: c.input,
        pnl: c.pnl,
        signer: this.d.signer.address,
        signature,
        commitTx: committed.hash,
        committedAt: committed.committedAt,
        preview: {
          seniorNav: c.preview.result.seniorNav,
          juniorNav: c.preview.result.juniorNav,
          seniorPrice: c.preview.seniorPrice,
          juniorPrice: c.preview.juniorPrice,
          pnlUsd: c.preview.result.pnl,
        },
      };
      await this.saveCommittedDurably(row, log);

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
    const head = await this.d.chain.head();
    const block = head.blockNumber > this.d.confirmations ? head.blockNumber - this.d.confirmations : head.blockNumber;
    const snapshot = await this.d.chain.snapshot(ref, block);
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
      },
      "mark computed",
    );
    return { snapshot, nav, preview, inventoryRoot: inventory.root, receipts, pnl, input };
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

  private async finalize(ref: BookRef, markId: bigint, commitTx: Hex | string, input: MarkInput, res: { hash: Hex; applied: MarkAppliedEvent }, preview: TranchePreview | null, log: Logger): Promise<MarkOutcome> {
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
    return { status: "applied", markId, commitTx, applyTx: res.hash, input, event: ev };
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
