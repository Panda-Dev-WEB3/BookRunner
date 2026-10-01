// Domain-event protocol: insert into events (ON CONFLICT (dedupe_key) DO NOTHING), then publish
// {id, type, createdAt, data} on CHANNELS.domainEvents. Publish failures are logged; the row stays.
import { CHANNELS, type Logger } from "@bookrunner/shared";
import type { PendingEvent } from "../jury/pipeline";

export interface EventSink {
  insertEvent(e: PendingEvent): Promise<{ id: number; createdAt: Date } | null>;
}

export interface Publisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export class EventBus {
  constructor(
    private readonly sink: EventSink,
    private readonly publisher: Publisher | null,
    private readonly logger: Logger,
  ) {}

  /** Returns true when the event was new (inserted + published). */
  async emit(e: PendingEvent): Promise<boolean> {
    const row = await this.sink.insertEvent(e);
    if (!row) return false;
    const msg = { id: row.id, type: e.type, createdAt: row.createdAt.toISOString(), data: e.payload };
    if (this.publisher) {
      try {
        await this.publisher.publish(CHANNELS.domainEvents, JSON.stringify(msg));
      } catch (err) {
        this.logger.warn({ err, eventId: row.id, type: e.type }, "domain event publish failed (row persisted)");
      }
    }
    this.logger.info({ eventId: row.id, type: e.type, bookId: e.bookId }, "domain event");
    return true;
  }
}
