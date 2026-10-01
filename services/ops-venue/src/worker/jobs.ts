// QUEUES.venueOps job dispatch (BullMQ). Payload: VenueOpsJob (packages/shared/src/queues.ts).
import type { VenueOpsJob } from "@bookrunner/shared";
import type { BookRegistry } from "./books";
import type { OpsContext } from "./context";
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
      return { bookId: book.bookId, symbol: book.symbol };
    case "fund_if": {
      // IF capital is deposited on-chain by the vault (closeWindow -> deployToVenue(IF)); verify it landed.
      const r = await d.ctx.builder.insuranceFund(book.symbol);
      const ok = r.balanceUsd >= book.ifTargetUsd;
      d.ctx.log[ok ? "info" : "warn"]({ bookId: book.bookId, balanceUsd: r.balanceUsd.toString(), targetUsd: book.ifTargetUsd.toString() }, "insurance fund check");
      return { balanceUsd: r.balanceUsd.toString(), targetUsd: book.ifTargetUsd.toString(), funded: ok };
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
      const tx = await d.reporter.report(book);
      return { tx };
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
