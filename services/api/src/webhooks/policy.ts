// Pure webhook rules: which events reach which subscription, the wire body, and the retry policy.
import { WEBHOOK_EVENTS, type WebhookEventType } from "@bookrunner/shared";
import type { EventRow, WebhookSubscriptionRow } from "../data/types";

export const WEBHOOK_MAX_ATTEMPTS = 8;
export const DEFAULT_BACKOFF_MS = 5_000;
export const EVENTS_CURSOR = "api:webhooks:events";

export const isWebhookEventType = (t: string): t is WebhookEventType => (WEBHOOK_EVENTS as readonly string[]).includes(t);

/** Event's book: the events.book_id column, else data.bookId, else data.charterId (bookId == charterId). */
export function eventBookId(ev: Pick<EventRow, "bookId" | "payload">): number | null {
  if (ev.bookId != null) return ev.bookId;
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const v = p.bookId ?? p.charterId;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null;
  return n !== null && Number.isFinite(n) ? n : null;
}

/**
 * A subscription receives an event when it is active, the type is webhook-subscribable and listed in
 * the subscription, the book filter (if any) matches, and the event was created after the
 * subscription (no back-fill of history to new subscribers).
 */
export function matchesSubscription(sub: WebhookSubscriptionRow, ev: Pick<EventRow, "type" | "bookId" | "payload" | "createdAt">): boolean {
  if (!sub.active || !isWebhookEventType(ev.type)) return false;
  if (!sub.eventTypes.includes(ev.type)) return false;
  if (sub.bookId != null && eventBookId(ev) !== sub.bookId) return false;
  return ev.createdAt.getTime() >= sub.createdAt.getTime();
}

export interface WebhookBody {
  id: number;
  type: string;
  createdAt: string;
  data: unknown;
}

export const webhookBody = (ev: EventRow): WebhookBody => ({ id: ev.id, type: ev.type, createdAt: ev.createdAt.toISOString(), data: ev.payload });

/** BullMQ job options: exponential backoff, at most WEBHOOK_MAX_ATTEMPTS attempts. */
export function webhookJobOptions(backoffMs = DEFAULT_BACKOFF_MS, maxAttempts = WEBHOOK_MAX_ATTEMPTS) {
  return {
    attempts: maxAttempts,
    backoff: { type: "exponential" as const, delay: backoffMs },
    removeOnComplete: { age: 86_400, count: 5_000 },
    removeOnFail: { age: 7 * 86_400 },
  };
}

/** Delay before the next attempt after `attemptsMade` failures (BullMQ exponential: 2^(n-1) * delay). */
export const backoffDelayMs = (attemptsMade: number, baseMs = DEFAULT_BACKOFF_MS): number => Math.round(2 ** (attemptsMade - 1) * baseMs);

/** Full retry schedule: delays between consecutive attempts (length maxAttempts - 1). */
export function retrySchedule(baseMs = DEFAULT_BACKOFF_MS, maxAttempts = WEBHOOK_MAX_ATTEMPTS): number[] {
  return Array.from({ length: maxAttempts - 1 }, (_, i) => backoffDelayMs(i + 1, baseMs));
}

/** Deterministic BullMQ job id per (subscription, event) so re-enqueueing is idempotent. */
export const deliveryJobId = (subscriptionId: number, eventId: number) => `wh-${subscriptionId}-${eventId}`;

export const isSuccessStatus = (status: number) => status >= 200 && status < 300;
