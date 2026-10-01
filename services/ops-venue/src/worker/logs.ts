// Chain log watcher for tracked Orderly books: adapter WithdrawRequested / FeesSwept and mandate
// Kill / Remandated, from a cursor persisted in chain_cursor ("ops-venue:logs"). Newly tracked books
// are backfilled from deployment.startBlock. Handlers must be idempotent (logs may be replayed).
import type { Address } from "viem";
import type { AdapterLog, MandateLog } from "../chain";
import { errMsg } from "../util";
import type { BookRegistry } from "./books";
import type { OpsContext, TrackedBook } from "./context";

export interface LogHandlers {
  onAdapterLog(l: AdapterLog): Promise<void> | void;
  onMandateLog(l: MandateLog, book: TrackedBook): Promise<void> | void;
}

export const LOG_CURSOR = "ops-venue:logs";

export class LogWatcher {
  private cursor: bigint | null = null;
  private readonly watched = new Set<number>();

  constructor(
    private readonly ctx: OpsContext,
    private readonly registry: BookRegistry,
    private readonly h: LogHandlers,
  ) {}

  private async loadCursor(): Promise<bigint> {
    if (this.cursor !== null) return this.cursor;
    let c: bigint | null = null;
    try {
      c = await this.ctx.store.getCursor(LOG_CURSOR);
    } catch (err) {
      this.ctx.log.warn({ err: errMsg(err) }, "cursor read failed; scanning from deployment start");
    }
    this.cursor = c ?? this.ctx.chain.startBlock;
    return this.cursor;
  }

  private async dispatch(adapterLogs: AdapterLog[], mandateLogs: MandateLog[]) {
    const items: Array<{ block: bigint; idx: number; run: () => Promise<void> | void }> = [];
    for (const l of adapterLogs) items.push({ block: l.block, idx: l.logIndex, run: () => this.h.onAdapterLog(l) });
    for (const l of mandateLogs) {
      const book = this.registry.byMandate(l.mandate);
      if (book) items.push({ block: l.block, idx: 0, run: () => this.h.onMandateLog(l, book) });
    }
    items.sort((a, b) => (a.block === b.block ? a.idx - b.idx : a.block < b.block ? -1 : 1));
    for (const it of items) await it.run();
  }

  private async scan(adapters: Address[], mandates: Address[], from: bigint, to: bigint) {
    const max = this.ctx.settings.logMaxRange;
    for (let a = from; a <= to; a += max) {
      const b = a + max - 1n < to ? a + max - 1n : to;
      const [al, ml] = await Promise.all([this.ctx.chain.adapterLogs(adapters, a, b), this.ctx.chain.mandateLogs(mandates, a, b)]);
      await this.dispatch(al, ml);
    }
  }

  async poll(): Promise<void> {
    const books = this.registry.list();
    if (books.length === 0) return;
    const cursor = await this.loadCursor();
    const head = await this.ctx.chain.blockNumber();
    // backfill books tracked since the last poll
    const fresh = books.filter((b) => !this.watched.has(b.bookId));
    if (fresh.length && cursor > this.ctx.chain.startBlock) {
      await this.scan(
        fresh.map((b) => b.adapter),
        fresh.map((b) => b.mandate),
        this.ctx.chain.startBlock,
        cursor - 1n < head ? cursor - 1n : head,
      );
    }
    for (const b of fresh) this.watched.add(b.bookId);
    if (cursor > head + 1n) {
      this.ctx.log.warn({ cursor: cursor.toString(), head: head.toString() }, "log cursor ahead of head (chain reset?) — rescanning from deployment start");
      this.cursor = this.ctx.chain.startBlock;
      return;
    }
    if (cursor > head) return;
    const to = cursor + this.ctx.settings.logMaxRange - 1n < head ? cursor + this.ctx.settings.logMaxRange - 1n : head;
    await this.scan(
      books.map((b) => b.adapter),
      books.map((b) => b.mandate),
      cursor,
      to,
    );
    this.cursor = to + 1n;
    try {
      await this.ctx.store.setCursor(LOG_CURSOR, this.cursor);
    } catch (err) {
      this.ctx.log.warn({ err: errMsg(err) }, "cursor persist failed (kept in memory)");
    }
  }
}
