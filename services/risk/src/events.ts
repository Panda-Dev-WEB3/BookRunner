// Domain events protocol (all producers): INSERT INTO events ... ON CONFLICT (dedupe_key) DO NOTHING,
// then PUBLISH CHANNELS.domainEvents {id, type, createdAt, data}.
//
// A newly inserted event is always published. An already existing one is re-published only when
// the caller cannot know whether its earlier publish went out (`republishExisting`, used by the
// journaled kill sequence); the api delivers webhooks once per (subscription, event id), so a
// re-publish of the same id never produces a second webhook.
import type { DomainEventPayloads, DomainEventType } from "@bookrunner/shared";
import type { BusPort, StorePort } from "./ports";

export async function emitDomainEvent<T extends DomainEventType>(
  store: Pick<StorePort, "insertEvent">,
  bus: Pick<BusPort, "publishDomainEvent">,
  type: T,
  bookId: number,
  data: DomainEventPayloads[T],
  dedupeKey: string,
  opts: { republishExisting?: boolean } = {},
): Promise<{ id: number; inserted: boolean; published: boolean }> {
  const row = await store.insertEvent({ type, bookId, payload: data as unknown as Record<string, unknown>, dedupeKey });
  const publish = row.inserted || !!opts.republishExisting;
  if (publish) await bus.publishDomainEvent({ id: row.id, type, createdAt: row.createdAt.toISOString(), data });
  return { id: row.id, inserted: row.inserted, published: publish };
}

export const dedupe = {
  limitBreached: (bookId: number, episodeId: string) => `limit.breached:${bookId}:${episodeId}`,
  killExecuted: (bookId: number, killTxOrEpisode: string) => `kill.executed:${bookId}:${killTxOrEpisode.toLowerCase()}`,
};
