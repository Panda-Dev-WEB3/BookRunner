// Indexing loop: plan range -> fetch protocol logs -> extend watch set with BookCreated ->
// fetch book-component logs for the same range -> order -> apply handlers + advance both cursors in
// ONE transaction -> publish the domain events that were newly inserted.
// A range that keeps failing (INDEXER_POISON_ATTEMPTS) is re-applied log by log in savepoints;
// failing logs are logged and skipped so one bad log cannot stall the indexer.
import { CHANNELS, type Deployment, type Logger } from "@bookrunner/shared";
import type { IndexerChain } from "./chain";
import { CURSORS } from "./config";
import { type DecodeSkip, type DecodedLog, decodeLog, orderLogs } from "./decode";
import { type HandlerCtx, booksCreatedIn, handlerFor } from "./handlers";
import { type Range, planRange } from "./range";
import type { IndexerStore, PendingEvent } from "./store";
import type { WatchSet } from "./watch";

export interface Publisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface IndexerConfig {
  confirmations: number;
  batchBlocks: number;
  poisonAttempts: number;
  startBlock: number;
}

export interface PublishedEvent {
  id: number;
  type: string;
  createdAt: string;
  data: Record<string, unknown>;
}

export type StepResult =
  | { status: "idle"; head: bigint }
  | { status: "indexed"; from: bigint; to: bigint; logs: number; applied: number; skipped: number; events: PublishedEvent[]; isolated: boolean };

export class Indexer {
  private failure = { key: "", count: 0 };
  private readonly warned = new Set<string>();

  constructor(
    private readonly d: {
      store: IndexerStore;
      chain: IndexerChain;
      watch: WatchSet;
      deployment: Pick<Deployment, "books">;
      publisher: Publisher | null;
      logger: Logger;
      config: IndexerConfig;
    },
  ) {}

  /** Seeds the watch set with books already in the DB (restart without replaying BookCreated). */
  async init(): Promise<void> {
    for (const b of await this.d.store.loadBooks()) this.d.watch.addBook(b.bookId, b.components);
    this.d.logger.info({ books: this.d.watch.bookCount() }, "indexer watch set loaded");
  }

  async step(): Promise<StepResult> {
    const { store, chain, config } = this.d;
    const head = await chain.headBlock();
    const cursors = { protocol: await store.getCursor(CURSORS.protocol), books: await store.getCursor(CURSORS.books) };
    const range = planRange(cursors, config.startBlock, head, config.confirmations, config.batchBlocks);
    if (!range) return { status: "idle", head };

    const { logs, skips } = await this.fetch(range);
    this.reportSkips(skips);

    const key = `${range.from}-${range.to}`;
    const isolated = this.failure.key === key && this.failure.count >= config.poisonAttempts;
    try {
      const r = await this.apply(range, logs, isolated);
      this.failure = { key: "", count: 0 };
      await this.publish(r.events);
      return { status: "indexed", from: range.from, to: range.to, logs: logs.length, applied: r.applied, skipped: skips.length + r.skipped, events: r.events, isolated };
    } catch (err) {
      this.failure = this.failure.key === key ? { key, count: this.failure.count + 1 } : { key, count: 1 };
      throw err;
    }
  }

  async fetch(range: Range): Promise<{ logs: DecodedLog[]; skips: DecodeSkip[] }> {
    const { chain, watch } = this.d;
    const skips: DecodeSkip[] = [];
    const decodeAll = (raws: Awaited<ReturnType<IndexerChain["getLogs"]>>) => {
      const out: DecodedLog[] = [];
      for (const raw of raws) {
        if (raw.removed) continue;
        const entry = watch.lookup(raw.address);
        if (!entry) continue;
        const r = decodeLog(raw, entry.kind, entry.bookId);
        if (r.ok) out.push(r.log);
        else skips.push(r.skip);
      }
      return out;
    };
    const protocol = decodeAll(await chain.getLogs(watch.protocolAddresses(), range.from, range.to));
    for (const b of booksCreatedIn(protocol)) {
      if (watch.addBook(b.bookId, b.components)) this.d.logger.info({ bookId: b.bookId, book: b.components.book }, "watching new book");
    }
    const bookAddrs = watch.bookAddresses();
    const bookLogs = bookAddrs.length ? decodeAll(await chain.getLogs(bookAddrs, range.from, range.to)) : [];
    return { logs: orderLogs([...protocol, ...bookLogs]), skips };
  }

  async apply(range: Range, logs: DecodedLog[], isolated: boolean): Promise<{ applied: number; skipped: number; events: PublishedEvent[] }> {
    const { chain, watch, deployment, logger } = this.d;
    const published: PublishedEvent[] = [];
    let applied = 0;
    let skipped = 0;
    await this.d.store.transaction(async (tx) => {
      for (const log of logs) {
        const done = log.group === "protocol" ? range.done.protocol : range.done.books;
        if (log.blockNumber <= done) continue;
        const handler = handlerFor(log);
        if (!handler) {
          logger.debug({ kind: log.kind, event: log.eventName, block: Number(log.blockNumber) }, "event has no handler (tolerated)");
          continue;
        }
        const ts = new Date((await chain.blockTimestamp(log.blockNumber)) * 1000);
        const run = async (s: IndexerStore) => {
          const local: PublishedEvent[] = [];
          const ctx: HandlerCtx = {
            log,
            ts,
            store: s,
            chain,
            watch,
            deployment,
            batch: logs,
            logger,
            emit: async (e: PendingEvent) => {
              const row = await s.insertEvent(e);
              if (row) local.push({ id: row.id, type: e.type, createdAt: row.createdAt.toISOString(), data: e.payload });
            },
          };
          await handler(ctx);
          return local;
        };
        if (!isolated) {
          published.push(...(await run(tx)));
          applied++;
          continue;
        }
        try {
          published.push(...(await tx.savepoint(run)));
          applied++;
        } catch (err) {
          skipped++;
          logger.error(
            { err, kind: log.kind, event: log.eventName, block: Number(log.blockNumber), tx: log.txHash, logIndex: log.logIndex },
            "poison log skipped after repeated range failures",
          );
        }
      }
      const to = Number(range.to);
      await tx.setCursor(CURSORS.protocol, Math.max(to, Number(range.done.protocol)));
      await tx.setCursor(CURSORS.books, Math.max(to, Number(range.done.books)));
    });
    return { applied, skipped, events: published };
  }

  private async publish(events: PublishedEvent[]): Promise<void> {
    if (!this.d.publisher) return;
    for (const e of events) {
      try {
        await this.d.publisher.publish(CHANNELS.domainEvents, JSON.stringify(e));
      } catch (err) {
        this.d.logger.warn({ err: (err as Error).message, eventId: e.id }, "domain event publish failed (row persisted)");
      }
    }
  }

  private reportSkips(skips: DecodeSkip[]): void {
    for (const s of skips) {
      const k = `${s.kind}:${s.topic0}:${s.reason}`;
      const ctx = { kind: s.kind, address: s.address, topic0: s.topic0, block: Number(s.blockNumber), logIndex: s.logIndex, reason: s.reason, error: s.error };
      if (s.reason === "known_extra" || s.reason === "pending" || this.warned.has(k)) this.d.logger.debug(ctx, "log skipped");
      else {
        this.warned.add(k);
        this.d.logger.warn(ctx, "log could not be decoded with the shared ABI; skipped (cursor advances)");
      }
    }
  }
}
