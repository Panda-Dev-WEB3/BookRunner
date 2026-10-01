// KILL SEQUENCE (ARCHITECTURE §3 flow 4), executed strictly in this order:
//   (1) broadcast   PUBLISH CHANNELS.kill (agents cancel + stop)  ── and ──
//       cancel_all  QuotingVenue.cancelAll() directly
//   (2) reduce_only engine books: IPoolEngineAdapter.setReduceOnly(true) (RISK)
//       flatten     desk.execute(Flatten) (RISK; reduce-only kind) for Stock Tokens the desk holds,
//                   minAmountOut = oracle value - slippage
//   (3) revoke_venue_key  enqueue QUEUES.venueOps {kind:"revoke_key", bookId} (Orderly books)
//   (4) mandate_kill      IMMMandate.kill(reason) with roleAccount("risk") — revokes desk keys
//   (5) record_*          kill_events row, receipts DECISION leaf, domain event kill.executed
//
// The journal makes the sequence resumable and idempotent: completed steps are never repeated;
// steps (1)-(3) are best-effort (a failure is retried on a later run until (4) is done, then
// recorded as "<step>:failed"); (4) and (5) are critical (a failure aborts the run, the monitor
// resumes it next tick). (4) is skipped when the mandate is already killed.
import { HEDGE_VENUES, type Logger, type QuotingVenue, RECEIPT_KIND, VENUE } from "@bookrunner/shared";
import type { RiskSettings } from "../config";
import { type FlattenOrder, planFlatten } from "../domain/flatten";
import { jsonSafe, receiptRow, usdStr } from "../domain/records";
import { KILL_STEPS, isJournalComplete } from "../domain/transitions";
import { dedupe, emitDomainEvent } from "../events";
import type { BusPort, ChainPort, Clock, QueuePort, StorePort } from "../ports";
import type { BookRef, KillJournal, KillStep } from "../types";
import { type Sleep, errMsg, withRetry, withTimeout } from "../util/async";

export interface KillPorts {
  chain: Pick<ChainPort, "isKilled" | "latestKill" | "setReduceOnly" | "deskHoldings" | "flatten" | "mandateKill" | "riskAddress">;
  store: Pick<StorePort, "insertKillEvent" | "insertReceipt" | "insertEvent" | "insertHedge">;
  bus: Pick<BusPort, "publishKill" | "publishDomainEvent">;
  queue: QueuePort;
  venue: QuotingVenue | null;
  clock: Clock;
  sleep?: Sleep;
}

export interface KillContext {
  ref: BookRef;
  /** Venue net exposure and signed desk hedge from the current tick (for net-mode flatten). */
  netExposureUsd: bigint;
  deskHedgeUsd: bigint;
  settings: Pick<
    RiskSettings,
    "flattenMode" | "flattenSlippageBps" | "flattenPoolFee" | "stepAttempts" | "stepRetryMs" | "venueTimeoutMs" | "receiptsIntervalSec"
  >;
  log: Logger;
}

export interface KillRunResult {
  journal: KillJournal;
  complete: boolean;
  error?: string;
}

const CRITICAL: ReadonlySet<KillStep> = new Set(["mandate_kill", "record_kill_event", "record_receipt", "record_event"]);

export async function runKillSequence(journal: KillJournal, ctx: KillContext, ports: KillPorts): Promise<KillRunResult> {
  const j: KillJournal = {
    ...journal,
    done: [...journal.done],
    failed: { ...journal.failed },
    actions: [...journal.actions],
    txHashes: [...journal.txHashes],
    runs: journal.runs + 1,
  };
  const { ref, log } = ctx;
  const bookId = ref.bookId;
  const s = ctx.settings;
  const retry = <T>(label: string, fn: () => Promise<T>) =>
    withRetry(fn, {
      attempts: s.stepAttempts,
      baseDelayMs: s.stepRetryMs,
      sleep: ports.sleep,
      onError: (err, attempt) => log.warn({ bookId, step: label, attempt, err: errMsg(err) }, "kill step attempt failed"),
    });
  const addTx = (h: string) => {
    if (!j.txHashes.includes(h)) j.txHashes.push(h);
  };

  const steps: Record<KillStep, () => Promise<void>> = {
    broadcast: async () => {
      await retry("broadcast", () =>
        ports.bus.publishKill(bookId, { bookId, ts: ports.clock.nowMs(), reason: j.reason, breaches: j.breaches }),
      );
      j.actions.push("kill_broadcast");
    },

    cancel_all: async () => {
      const venue = ports.venue;
      if (!venue) {
        j.actions.push(ref.venue === VENUE.POOL_ENGINE ? "cancel_all:engine_reduce_only" : "cancel_all:no_venue_client");
        return;
      }
      await retry("cancel_all", () => withTimeout(venue.cancelAll(), s.venueTimeoutMs, "venue.cancelAll"));
      j.actions.push("cancel_all");
    },

    reduce_only: async () => {
      if (ref.venue !== VENUE.POOL_ENGINE) return;
      const tx = await retry("reduce_only", () => ports.chain.setReduceOnly(ref));
      addTx(tx);
      j.actions.push("reduce_only");
      log.info({ bookId, tx }, "engine market set reduce-only");
    },

    flatten: async () => {
      const holdings = await retry("flatten.holdings", () => ports.chain.deskHoldings(ref));
      const plan = planFlatten({
        holdings,
        netBookExposureUsd: ctx.netExposureUsd + ctx.deskHedgeUsd,
        mode: s.flattenMode,
        slippageBps: s.flattenSlippageBps,
      });
      for (const sk of plan.skipped) j.actions.push(`flatten:${sk.token.toLowerCase()}:${sk.reason}`);
      if (plan.orders.length === 0) {
        if (!j.actions.some((a) => a.startsWith("flatten"))) j.actions.push("flatten:none");
        return;
      }
      const failures: string[] = [];
      for (const o of plan.orders) {
        try {
          // each order is sent once per attempt; holdings are re-read on the next run, never here
          const tx = await retry(`flatten.${o.token}`, () => ports.chain.flatten(ref, o, s.flattenPoolFee));
          addTx(tx);
          j.actions.push(`flatten:${o.token.toLowerCase()}`);
          log.info({ bookId, token: o.token, amountIn: o.amountIn.toString(), minAmountOut: o.minAmountOut.toString(), tx }, "desk flattened");
          await recordFlatten(ctx, ports, o, tx).catch((err) => log.warn({ bookId, err: errMsg(err) }, "flatten bookkeeping failed"));
        } catch (err) {
          failures.push(`${o.token}: ${errMsg(err)}`);
        }
      }
      if (failures.length) throw new Error(`flatten failed for ${failures.join("; ")}`);
    },

    revoke_venue_key: async () => {
      if (ref.venue !== VENUE.ORDERLY) return;
      await retry("revoke_venue_key", () =>
        ports.queue.enqueueVenueOp({ kind: "revoke_key", bookId }, `revoke_key-${bookId}-${j.episodeId}`),
      );
      j.actions.push("revoke_venue_key");
    },

    mandate_kill: async () => {
      if (await retry("mandate_kill.check", () => ports.chain.isKilled(ref))) {
        const k = await ports.chain.latestKill(ref).catch(() => null);
        if (k) {
          j.killTx = k.txHash;
          addTx(k.txHash);
        }
        j.actions.push("mandate_kill:already_killed");
        log.warn({ bookId, killTx: j.killTx }, "mandate already killed; skipping mandate.kill");
        return;
      }
      const tx = await retry("mandate_kill", () => ports.chain.mandateKill(ref, j.reason));
      j.killTx = tx;
      addTx(tx);
      j.actions.push("mandate_kill", "revoke_desk_keys");
      log.warn({ bookId, reason: j.reason, tx }, "mandate killed");
    },

    record_kill_event: async () => {
      await retry("record_kill_event", () =>
        ports.store.insertKillEvent({
          bookId,
          ts: new Date(ports.clock.nowMs()),
          reason: j.reason,
          breaches: j.breaches,
          actions: finalActions(j),
          txHashes: j.txHashes,
        }),
      );
    },

    record_receipt: async () => {
      const payload = jsonSafe({
        type: "kill",
        bookId,
        episodeId: j.episodeId,
        mode: j.mode,
        reason: j.reason,
        breaches: j.breaches,
        actions: finalActions(j),
        txHashes: j.txHashes,
        killTx: j.killTx,
        startedAt: j.startedAt,
        snapshot: j.snapshot,
      });
      const row = receiptRow(bookId, RECEIPT_KIND.DECISION, Math.floor(ports.clock.nowMs() / 1000), payload, s.receiptsIntervalSec);
      await retry("record_receipt", () => ports.store.insertReceipt(row));
    },

    record_event: async () => {
      await retry("record_event", () =>
        emitDomainEvent(
          ports.store,
          ports.bus,
          "kill.executed",
          bookId,
          { bookId, reason: j.reason, actions: finalActions(j), txHashes: j.txHashes },
          dedupe.killExecuted(bookId, j.killTx ?? j.episodeId),
          { republishExisting: true },
        ),
      );
      log.warn({ bookId, reason: j.reason, actions: finalActions(j), txHashes: j.txHashes }, "kill executed");
    },
  };

  for (const step of KILL_STEPS) {
    if (j.done.includes(step)) continue;
    try {
      await steps[step]();
      j.done.push(step);
    } catch (err) {
      j.failed[step] = (j.failed[step] ?? 0) + 1;
      log.error({ bookId, step, err: errMsg(err), episodeId: j.episodeId }, "kill step failed");
      if (CRITICAL.has(step)) return { journal: j, complete: false, error: `${step}: ${errMsg(err)}` };
    }
  }
  return { journal: j, complete: isJournalComplete(j) };
}

/** Actions as recorded: the executed ones plus "<step>:failed" for best-effort steps that never succeeded. */
export function finalActions(j: KillJournal): string[] {
  const failed = KILL_STEPS.filter((st) => !CRITICAL.has(st) && !j.done.includes(st) && (j.failed[st] ?? 0) > 0).map(
    (st) => `${st}:failed`,
  );
  return [...j.actions, ...failed];
}

/** hedges row + HEDGE receipt for a risk-initiated Flatten (best effort; never blocks the kill). */
async function recordFlatten(ctx: KillContext, ports: KillPorts, o: FlattenOrder, tx: string): Promise<void> {
  const nowSec = Math.floor(ports.clock.nowMs() / 1000);
  await ports.store.insertHedge({
    bookId: ctx.ref.bookId,
    ts: new Date(nowSec * 1000),
    asset: o.token.toLowerCase(),
    qtyRaw: (-o.amountIn).toString(),
    px: Number(o.priceWad) / 1e18,
    mult: Number(o.multiplierWad) / 1e18,
    txHash: tx,
    venue: "UNIV3",
    valueUsd: usdStr(o.expectedOutUsd),
  });
  const payload = jsonSafe({
    type: "flatten",
    by: "risk",
    bookId: ctx.ref.bookId,
    token: o.token.toLowerCase(),
    amountIn: o.amountIn,
    minAmountOut: o.minAmountOut,
    expectedOutUsd: usdStr(o.expectedOutUsd),
    priceWad: o.priceWad,
    multiplierWad: o.multiplierWad,
    venue: HEDGE_VENUES.UNIV3,
    txHash: tx,
  });
  await ports.store.insertReceipt(receiptRow(ctx.ref.bookId, RECEIPT_KIND.HEDGE, nowSec, payload, ctx.settings.receiptsIntervalSec));
}
