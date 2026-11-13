// Indexing loop: plan range -> fetch protocol logs -> extend watch set with BookCreated ->
// fetch book-component logs for the same range -> order -> apply handlers + advance both cursors in
// ONE transaction -> publish the domain events that were newly inserted.
// A range that keeps failing (INDEXER_POISON_ATTEMPTS) is re-applied log by log in savepoints;
// failing logs are logged and skipped so one bad log cannot stall the indexer.
import { CHANNELS, type Deployment, type Logger, busJson } from "@bookrunner/shared";
import type { IndexerChain } from "./chain";
import { CURSORS } from "./config";
import { type DecodeSkip, type DecodedLog, decodeLog, orderLogs } from "./decode";
import { type Handler, type HandlerCtx, booksCreatedIn, handlerFor } from "./handlers";
import { ENGINE_EVENT_HANDLERS } from "./engineEvents";
import { ENGINE_HANDLERS } from "./engineHandlers";
import { backfillPool } from "./poolHandlers";
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
    // the engine is indexed with the protocol group: a fresh index (no cursor yet) from the start, and an index whose
    // engine backfill caught up stays in sync; only an older index has a backfill to run (backfillEngine)
    const fresh = async (name: string) => {
      const cur = await store.getCursor(name);
      return (cursors.protocol === null && cur === null) || (cur !== null && cursors.protocol !== null && cur >= cursors.protocol);
    };
    const freshEngine = await fresh(CURSORS.engineBackfill);
    const freshEvents = await fresh(CURSORS.engineEventsBackfill);
    if (!range) {
      await this.backfill(BigInt(cursors.protocol ?? 0));
      return { status: "idle", head };
    }

    const { logs, skips } = await this.fetch(range);
    this.reportSkips(skips);

    const key = `${range.from}-${range.to}`;
    const isolated = this.failure.key === key && this.failure.count >= config.poisonAttempts;
    try {
      const r = await this.apply(range, logs, isolated, freshEngine, freshEvents);
      this.failure = { key: "", count: 0 };
      await this.publish(r.events);
      await this.backfill(range.to);
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
    // RPC budget: protocol + already-watched books in ONE eth_getLogs (75 CU each on the mainnet RPC); only books
    // created inside this range need a second call for the same range (their addresses were not in the filter)
    const known = new Set(watch.bookAddresses().map((a) => a.toLowerCase()));
    const first = decodeAll(await chain.getLogs([...watch.protocolAddresses(), ...watch.bookAddresses()], range.from, range.to));
    for (const b of booksCreatedIn(first.filter((l) => l.group === "protocol"))) {
      if (watch.addBook(b.bookId, b.components)) this.d.logger.info({ bookId: b.bookId, book: b.components.book }, "watching new book");
    }
    const added = watch.bookAddresses().filter((a) => !known.has(a.toLowerCase()));
    const newBookLogs = added.length ? decodeAll(await chain.getLogs(added, range.from, range.to)) : [];
    return { logs: orderLogs([...first, ...newBookLogs]), skips };
  }

  async apply(range: Range, logs: DecodedLog[], isolated: boolean, freshEngine = false, freshEvents = false): Promise<{ applied: number; skipped: number; events: PublishedEvent[] }> {
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
      if (freshEngine) await tx.setCursor(CURSORS.engineBackfill, Math.max(to, Number(range.done.protocol)));
      if (freshEvents) await tx.setCursor(CURSORS.engineEventsBackfill, Math.max(to, Number(range.done.protocol)));
    });
    return { applied, skipped, events: published };
  }

  /**
   * Review I-5: an index that existed before the PoolEngine was watched has no engine_positions for positions opened
   * before. One batch per step: the engine's logs only (engine-only eth_getLogs), position handlers only (idempotent:
   * a row is only replaced by a later log), from the deployment's start block up to the protocol cursor. Never throws.
   */
  backfillEngine(): Promise<{ from: number; to: number; logs: number } | null> {
    return this.backfillEngineLogs(CURSORS.engineBackfill, ENGINE_HANDLERS, false, "engine positions backfill");
  }

  /**
   * Trading page v2: the same for engine_trader_events (an index older than those rows), with each log's block
   * timestamp (one cached block read per block holding engine events). Inserts are idempotent per (tx, logIndex).
   */
  backfillEngineEvents(): Promise<{ from: number; to: number; logs: number } | null> {
    return this.backfillEngineLogs(CURSORS.engineEventsBackfill, ENGINE_EVENT_HANDLERS, true, "engine trader events backfill");
  }

  private async backfillEngineLogs(cursor: string, handlers: Record<string, Handler>, blockTime: boolean, what: string): Promise<{ from: number; to: number; logs: number } | null> {
    const { store, chain, watch, config, logger } = this.d;
    const engine = watch.engineAddress();
    if (!engine) return null;
    try {
      const target = await store.getCursor(CURSORS.protocol);
      if (target === null) return null;
      let cur = await store.getCursor(cursor);
      if (cur === null) {
        cur = config.startBlock - 1;
        logger.info({ from: config.startBlock, to: target }, `${what}: indexing the PoolEngine's history`);
      }
      if (cur >= target) return null;
      const from = cur + 1;
      const to = Math.min(target, cur + config.batchBlocks);
      const raws = await chain.getLogs([engine], BigInt(from), BigInt(to));
      const logs = orderLogs(
        raws.flatMap((raw) => {
          if (raw.removed) return [];
          const d = decodeLog(raw, "engine", null);
          return d.ok && handlers[`engine.${d.log.eventName}`] ? [d.log] : [];
        }),
      );
      const times = new Map<bigint, Date>();
      if (blockTime) for (const log of logs) if (!times.has(log.blockNumber)) times.set(log.blockNumber, new Date((await chain.blockTimestamp(log.blockNumber)) * 1000));
      await store.transaction(async (tx) => {
        for (const log of logs) {
          const ctx = { log, ts: times.get(log.blockNumber) ?? new Date(0), store: tx, chain, watch, deployment: this.d.deployment, batch: logs, logger, emit: async () => undefined } as unknown as HandlerCtx;
          await handlers[`engine.${log.eventName}`]!(ctx);
        }
        await tx.setCursor(cursor, to);
      });
      if (to >= target) logger.info({ to }, `${what} complete`);
      return { from, to, logs: logs.length };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, `${what} failed (retrying next pass)`);
      return null;
    }
  }

  /** Review I-3: re-reads pool rows a failed read left stale (best effort, every pass; never throws). */
  private async backfill(head: bigint): Promise<void> {
    await this.backfillEngine();
    await this.backfillEngineEvents();
    const pool = this.d.watch.poolAddress();
    if (!pool || head <= 0n) return;
    try {
      const r = await backfillPool({ store: this.d.store, chain: this.d.chain, pool, head, logger: this.d.logger });
      if (r.snapshots || r.books || r.epochs) this.d.logger.info(r, "pool rows backfilled");
    } catch (err) {
      this.d.logger.warn({ err: (err as Error).message }, "pool backfill failed (retrying next pass)");
    }
  }

  private async publish(events: PublishedEvent[]): Promise<void> {
    if (!this.d.publisher) return;
    for (const e of events) {
      try {
        await this.d.publisher.publish(CHANNELS.domainEvents, busJson(e));
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
