// Domain events -> webhook deliveries. Low latency via the CHANNELS.domainEvents pub/sub; durability
// via a periodic sweep of the events table from a cursor (chain_cursor row "api:webhooks:events").
// Delivery rows are unique per (subscription, event), so every path is idempotent.
import { CHANNELS, type Logger, WEBHOOK_EVENTS, type WebhookJob } from "@bookrunner/shared";
import type { EventRow, WebhookStore } from "../data/types";
import { EVENTS_CURSOR, isWebhookEventType, matchesSubscription } from "./policy";

/** Re-scan this many ids below the cursor (producers may commit out of id order). */
export const CATCHUP_MARGIN = 200;
const BATCH = 500;
const STALE_PENDING_MS = 10 * 60_000;

export interface Subscriber {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: "message", cb: (channel: string, message: string) => void): unknown;
}

export interface DispatcherDeps {
  store: WebhookStore;
  enqueue: (job: WebhookJob) => Promise<void>;
  log: Logger;
  now: () => number;
  sweepIntervalMs?: number;
}

export class WebhookDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private sweeping = false;
  private subscriber: Subscriber | null = null;
  private stopped = false;

  constructor(private readonly d: DispatcherDeps) {}

  /** Creates pending deliveries for every matching subscription and enqueues the new ones. */
  async dispatch(ev: EventRow): Promise<number> {
    if (!isWebhookEventType(ev.type)) return 0;
    const subs = (await this.d.store.activeSubscriptions()).filter((s) => matchesSubscription(s, ev));
    if (subs.length === 0) return 0;
    const created = await this.d.store.createDeliveries(
      ev.id,
      subs.map((s) => s.id),
    );
    for (const row of created) await this.d.enqueue({ eventId: ev.id, subscriptionId: row.subscriptionId });
    if (created.length) this.d.log.info({ eventId: ev.id, type: ev.type, deliveries: created.length }, "webhook deliveries queued");
    return created.length;
  }

  /** Pub/sub message {id, type, createdAt, data}: the stored row is authoritative. */
  async onMessage(raw: string): Promise<number> {
    let msg: { id?: unknown; type?: unknown };
    try {
      msg = JSON.parse(raw) as { id?: unknown; type?: unknown };
    } catch {
      this.d.log.warn({ raw: raw.slice(0, 200) }, "malformed domain event message");
      return 0;
    }
    if (typeof msg.type !== "string" || !isWebhookEventType(msg.type)) return 0;
    const id = typeof msg.id === "number" ? msg.id : typeof msg.id === "string" && /^\d+$/.test(msg.id) ? Number(msg.id) : null;
    if (id === null) return 0; // the sweep picks it up from the table
    const ev = await this.d.store.getEvent(id);
    return ev ? this.dispatch(ev) : 0;
  }

  /** Sweeps events after the cursor (minus a margin), then advances the cursor. */
  async catchUp(): Promise<number> {
    const cursor = (await this.d.store.getCursor(EVENTS_CURSOR)) ?? 0;
    let after = Math.max(0, cursor - CATCHUP_MARGIN);
    let maxSeen = cursor;
    let total = 0;
    for (;;) {
      const batch = await this.d.store.eventsAfter(after, WEBHOOK_EVENTS, BATCH);
      for (const ev of batch) {
        total += await this.dispatch(ev);
        maxSeen = Math.max(maxSeen, ev.id);
      }
      const last = batch[batch.length - 1];
      if (!last || batch.length < BATCH) break;
      after = last.id;
    }
    if (maxSeen > cursor) await this.d.store.setCursor(EVENTS_CURSOR, maxSeen);
    return total;
  }

  /** Re-enqueues pending deliveries whose BullMQ job may have been lost (job ids dedupe). */
  async requeueStale(): Promise<number> {
    const rows = await this.d.store.stalePendingDeliveries(new Date(this.d.now() - STALE_PENDING_MS), 200);
    for (const r of rows) await this.d.enqueue({ eventId: r.eventId, subscriptionId: r.subscriptionId });
    return rows.length;
  }

  async sweep(): Promise<void> {
    if (this.sweeping || this.stopped) return;
    this.sweeping = true;
    try {
      await this.catchUp();
      await this.requeueStale();
    } catch (err) {
      this.d.log.warn({ err }, "webhook sweep failed; retrying next interval");
    } finally {
      this.sweeping = false;
    }
  }

  async start(subscriber: Subscriber | null): Promise<void> {
    this.stopped = false;
    if (subscriber) {
      this.subscriber = subscriber;
      subscriber.on("message", (channel, message) => {
        if (channel !== CHANNELS.domainEvents) return;
        // serialize handling; errors are logged, the sweep is the safety net
        this.chain = this.chain
          .then(() => this.onMessage(message))
          .catch((err) => this.d.log.warn({ err }, "domain event dispatch failed; sweep will retry"));
      });
      // Not awaited: with Redis down the client queues the command until it reconnects, and the
      // periodic sweep keeps deliveries flowing meanwhile.
      subscriber.subscribe(CHANNELS.domainEvents).catch((err) => this.d.log.warn({ err }, "subscribe to domain events failed; relying on the sweep"));
    }
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.d.sweepIntervalMs ?? 15_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.subscriber) await this.subscriber.unsubscribe(CHANNELS.domainEvents).catch(() => {});
    await this.chain.catch(() => {});
  }
}
