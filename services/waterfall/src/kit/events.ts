// Domain events protocol (all producers): insert into events (dedupe_key unique, ON CONFLICT DO
// NOTHING), then publish {id, type, createdAt, data} on CHANNELS.domainEvents. The api turns these
// into webhooks. A conflicting insert means the event already exists: nothing is re-published.
import { type Db, events } from "@bookrunner/db";
import { CHANNELS, type DomainEvent, type DomainEventPayloads, type DomainEventType, type Logger } from "@bookrunner/shared";

export interface Publisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface DomainEventSink {
  publish<T extends DomainEventType>(type: T, bookId: number | null, data: DomainEventPayloads[T], dedupeKey: string): Promise<{ id: number | null; inserted: boolean }>;
}

export class PgRedisEventSink implements DomainEventSink {
  constructor(
    private readonly db: Db,
    private readonly redis: Publisher | null,
    private readonly log: Logger,
  ) {}

  async publish<T extends DomainEventType>(type: T, bookId: number | null, data: DomainEventPayloads[T], dedupeKey: string) {
    const rows = await this.db
      .insert(events)
      .values({ type, bookId, payload: data, dedupeKey })
      .onConflictDoNothing({ target: events.dedupeKey })
      .returning({ id: events.id, createdAt: events.createdAt });
    const row = rows[0];
    if (!row) {
      this.log.debug({ type, dedupeKey }, "domain event already recorded");
      return { id: null, inserted: false };
    }
    const msg: DomainEvent<T> = { id: row.id, type, createdAt: row.createdAt.toISOString(), data };
    if (this.redis) {
      try {
        await this.redis.publish(CHANNELS.domainEvents, JSON.stringify(msg));
      } catch (err) {
        this.log.warn({ err, type, id: row.id }, "domain event persisted but redis publish failed");
      }
    }
    this.log.info({ type, id: row.id, bookId }, "domain event");
    return { id: row.id, inserted: true };
  }
}

/** In-memory sink for tests. */
export class MemoryEventSink implements DomainEventSink {
  readonly events: Array<{ type: DomainEventType; bookId: number | null; data: unknown; dedupeKey: string }> = [];
  async publish<T extends DomainEventType>(type: T, bookId: number | null, data: DomainEventPayloads[T], dedupeKey: string) {
    if (this.events.some((e) => e.dedupeKey === dedupeKey)) return { id: null, inserted: false };
    this.events.push({ type, bookId, data, dedupeKey });
    return { id: this.events.length, inserted: true };
  }
}
