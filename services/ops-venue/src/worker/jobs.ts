// QUEUES.venueOps job dispatch (BullMQ). Payload: VenueOpsJob (packages/shared/src/queues.ts).
import type { VenueOpsJob } from "@bookrunner/shared";
import { ifAboveRequirement } from "../domain/ifAccount";
import type { BookRegistry } from "./books";
import { type OpsContext, tradable } from "./context";
import type { FeeSweeper } from "./fees";
import type { Provisioner } from "./provision";
import type { Reporter } from "./reporter";
import type { Revoker } from "./revoke";
import type { WithdrawProcessor } from "./withdrawals";

export interface JobDeps {
  ctx: OpsContext;
  registry: BookRegistry;
  provisioner: Provisioner;
  reporter: Reporter;
  withdrawals: WithdrawProcessor;
  fees: FeeSweeper;
  revoker: Revoker;
}

export async function handleVenueOpsJob(job: VenueOpsJob, d: JobDeps): Promise<Record<string, unknown>> {
  if (job.kind === "revoke_key") {
    const r = await d.revoker.revoke(job.bookId, "RISK_KILL", "job");
    return { ...r };
  }
  let book = d.registry.get(job.bookId);
  if (!book) {
    await d.registry.refresh();
    book = d.registry.get(job.bookId);
  }
  if (!book) throw new Error(`book ${job.bookId} is not an Orderly book known to ops-venue`);
  switch (job.kind) {
    case "create_symbol":
      await d.provisioner.ensure(book, true);
      // listed: the book has an Orderly market symbol; listing: what /v1/public/info shows for it (manual mode: Orderly One)
      return {
        bookId: book.bookId,
        symbol: book.symbol,
        listed: tradable(book),
        listingMode: d.ctx.settings.listingMode ?? "api",
        ...(book.listing ? { listing: book.listing.phase, venueStatus: book.listing.venueStatus, openForRisk: book.listing.openForRisk, ...(book.listing.error ? { listingError: book.listing.error } : {}) } : {}),
        ...(book.venueSymbolError ? { error: book.venueSymbolError } : {}),
      };
    case "fund_if": {
      if (!tradable(book)) {
        // no symbol, so no per-symbol IF row: report the IF account's own equity instead
        const acct = await d.ctx.readAccount(book.accounts.if, book.symbol, await d.ctx.keys.opsKey(book.bookId, "if"));
        return { balanceUsd: acct.equityUsd.toString(), targetUsd: book.ifTargetUsd.toString(), funded: acct.equityUsd >= book.ifTargetUsd, listed: false };
      }
      // IF capital is deposited on-chain by the vault (closeWindow -> deployToVenue(IF)); verify it landed, at or above the
      // charter target and strictly above Orderly's per-market requirement (one market per book IF account, VERIFY O10)
      const r = await d.ctx.builder.insuranceFund(book.symbol);
      const req = d.ctx.settings.ifRequirementUsd ?? null;
      const above = req === null ? null : ifAboveRequirement(r.balanceUsd, req);
      const ok = r.balanceUsd >= book.ifTargetUsd && above !== false && !book.ifAccountError;
      const ifInfo = { ifMode: d.ctx.settings.ifMode ?? "contract", ifAccountId: book.accounts.if, ...(book.ifAccountError ? { ifAccountError: book.ifAccountError } : {}) };
      d.ctx.log[ok ? "info" : "warn"]({ bookId: book.bookId, balanceUsd: r.balanceUsd.toString(), targetUsd: book.ifTargetUsd.toString(), requirementUsd: req?.toString() ?? null, ...ifInfo }, "insurance fund check");
      return { balanceUsd: r.balanceUsd.toString(), targetUsd: book.ifTargetUsd.toString(), funded: ok, ...(req !== null ? { requirementUsd: req.toString(), aboveRequirement: above } : {}), ...ifInfo };
    }
    case "deposit_mm": {
      const acct = await d.ctx.readAccount(book.accounts.mm, book.symbol, await d.ctx.keys.opsKey(book.bookId, "mm"));
      return { equityUsd: acct.equityUsd.toString(), mmInventoryUsd: book.mmInventoryUsd.toString() };
    }
    case "execute_withdraw": {
      if (!job.requestNonce) throw new Error("execute_withdraw needs requestNonce");
      const s = await d.withdrawals.processNonce(book.bookId, job.requestNonce);
      return { stage: s.stage, attempts: s.attempts, ...(s.lastError ? { lastError: s.lastError } : {}) };
    }
    case "report": {
      // follows OPS_REPORT_MODE: signed -> signature published (tx only on an adapter without reportSigned)
      const r = await d.reporter.reportDetailed(book);
      return { mode: d.ctx.settings.reportMode, tx: r?.tx ?? null, ...(r?.signature ? { signature: r.signature, asOf: Number(r.asOf) } : {}) };
    }
    case "sweep_fees": {
      if (job.period === undefined) throw new Error("sweep_fees needs period");
      const s = await d.fees.sweep(book.bookId, job.period);
      return { stage: s.stage, amount: s.amount, ...(s.sweepTx ? { tx: s.sweepTx } : {}) };
    }
    default:
      throw new Error(`unknown venue-ops job kind ${(job as { kind: string }).kind}`);
  }
}
