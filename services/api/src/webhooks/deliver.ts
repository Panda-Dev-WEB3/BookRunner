// One webhook delivery attempt. Pure orchestration over injected store/fetch/clock so it is unit
// testable; the BullMQ worker (queue.ts) maps "retry"/"failed" outcomes to thrown errors.
import type { Logger, WebhookJob } from "@bookrunner/shared";
import type { WebhookStore } from "../data/types";
import { isSuccessStatus, webhookBody } from "./policy";
import { SIGNATURE_HEADER, signatureHeader } from "./signature";
import { type ResolveHost, checkResolvedTarget, dnsResolveHost } from "./target";

export interface DeliverDeps {
  store: WebhookStore;
  fetch: typeof fetch;
  now: () => number; // unix ms
  timeoutMs: number;
  log: Logger;
  /** WEBHOOK_ALLOW_HOSTS (exempt from the SSRF address rules). */
  allowHosts?: ReadonlySet<string>;
  /** DNS answers of a host (default node:dns); every answer must be a public address. */
  resolveHost?: ResolveHost;
}

export type DeliveryOutcome =
  | { status: "delivered"; responseCode: number }
  | { status: "retry"; responseCode: number | null; error: string }
  | { status: "failed"; responseCode: number | null; error: string }
  | { status: "dropped"; error: string }
  | { status: "skipped" };

/** `attempt` is 1-based; the attempt equal to `maxAttempts` is final. */
export async function deliverWebhook(d: DeliverDeps, job: WebhookJob, attempt: number, maxAttempts: number): Promise<DeliveryOutcome> {
  const { subscriptionId, eventId } = job;
  const existing = await d.store.getDelivery(subscriptionId, eventId);
  if (existing?.status === "delivered") return { status: "skipped" };

  const drop = async (error: string): Promise<DeliveryOutcome> => {
    await d.store.updateDelivery(subscriptionId, eventId, { status: "failed", attempts: attempt, responseCode: null, lastError: error, deliveredAt: null });
    return { status: "dropped", error };
  };

  const sub = await d.store.getSubscription(subscriptionId);
  if (!sub || !sub.active) return drop("subscription inactive or deleted");
  const ev = await d.store.getEvent(eventId);
  if (!ev) return drop("event not found");

  // SSRF guard, re-checked at delivery: the URL's host may have been re-pointed since creation
  let target: Awaited<ReturnType<typeof checkResolvedTarget>>;
  try {
    target = await checkResolvedTarget(sub.url, d.allowHosts ?? new Set(), d.resolveHost ?? dnsResolveHost);
  } catch (err) {
    target = { ok: false, reason: `url host lookup failed: ${err instanceof Error ? err.message : String(err)}` };
    if (attempt < maxAttempts) {
      await d.store.updateDelivery(subscriptionId, eventId, { status: "pending", attempts: attempt, responseCode: null, lastError: target.reason.slice(0, 500), deliveredAt: null });
      return { status: "retry", responseCode: null, error: target.reason };
    }
  }
  if (!target.ok) {
    d.log.warn({ subscriptionId, eventId, reason: target.reason }, "webhook destination blocked (non-public address)");
    return drop(`blocked destination: ${target.reason}`);
  }

  const body = JSON.stringify(webhookBody(ev));
  const t = Math.floor(d.now() / 1000);
  let responseCode: number | null = null;
  let error: string;
  try {
    const res = await d.fetch(sub.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "bookrunner-webhooks/1",
        [SIGNATURE_HEADER]: signatureHeader(sub.secret, body, t),
        "x-bookrunner-event": ev.type,
        "x-bookrunner-delivery": `${subscriptionId}-${eventId}`,
      },
      body,
      signal: AbortSignal.timeout(d.timeoutMs),
      redirect: "manual",
    });
    responseCode = res.status;
    await res.body?.cancel().catch(() => {});
    if (isSuccessStatus(res.status)) {
      await d.store.updateDelivery(subscriptionId, eventId, {
        status: "delivered",
        attempts: attempt,
        responseCode,
        lastError: null,
        deliveredAt: new Date(d.now()),
      });
      return { status: "delivered", responseCode };
    }
    error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  const final = attempt >= maxAttempts;
  await d.store.updateDelivery(subscriptionId, eventId, {
    status: final ? "failed" : "pending",
    attempts: attempt,
    responseCode,
    lastError: error.slice(0, 500),
    deliveredAt: null,
  });
  d.log.warn({ subscriptionId, eventId, attempt, maxAttempts, responseCode, error }, final ? "webhook delivery failed permanently" : "webhook delivery failed; will retry");
  return final ? { status: "failed", responseCode, error } : { status: "retry", responseCode, error };
}
