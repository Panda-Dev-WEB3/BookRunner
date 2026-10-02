// Chain log watcher for tracked Orderly books: adapter WithdrawRequested / FeesSwept and mandate
// Kill / Remandated, from a cursor persisted in chain_cursor ("ops-venue:logs"). A book that is not yet
// covered by the global scans (newly tracked, or every book after a restart) is backfilled from its own
// persisted cursor ("ops-venue:logs:<adapter>"; deployment.startBlock only the first time), so restarts
// do not replay the whole history. Handlers must still be idempotent (logs may be replayed): withdraw
// sagas act only on requests whose on-chain status is still Requested.
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
/** Next block to scan for one book (persisted; lower than the truth is safe, never higher). */
export const bookCursorName = (adapter: Address | string) => `${LOG_CURSOR}:${adapter.toLowerCase()}`;
const BOOK_CURSOR_PERSIST_MS = 30_000;

export class LogWatcher {
  private cursor: bigint | null = null;
  private readonly watched = new Set<number>();
  private bookCursorsAt = 0;

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

  private async bookCursor(b: TrackedBook, head: bigint): Promise<bigint> {
    let c: bigint | null = null;
    try {
      c = await this.ctx.store.getCursor(bookCursorName(b.adapter));
    } catch (err) {
      this.ctx.log.warn({ bookId: b.bookId, err: errMsg(err) }, "book log cursor read failed; backfilling from deployment start");
    }
    if (c === null || c < this.ctx.chain.startBlock || c > head + 1n) return this.ctx.chain.startBlock; // none yet / chain reset
    return c;
  }

  private async setBookCursors(books: TrackedBook[], next: bigint) {
    for (const b of books) {
      try {
        await this.ctx.store.setCursor(bookCursorName(b.adapter), next);
      } catch (err) {
        this.ctx.log.warn({ bookId: b.bookId, err: errMsg(err) }, "book log cursor persist failed (a restart rescans more)");
      }
    }
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
    // backfill books not covered by the global scans yet: [their own cursor, global cursor)
    const fresh = books.filter((b) => !this.watched.has(b.bookId));
    const upTo = cursor - 1n < head ? cursor - 1n : head;
    for (const b of fresh) {
      const from = await this.bookCursor(b, head);
      if (from <= upTo) await this.scan([b.adapter], [b.mandate], from, upTo);
      this.watched.add(b.bookId);
      await this.setBookCursors([b], upTo + 1n);
    }
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
    // every watched book is now scanned up to the global cursor (throttled: a stale-low book cursor only rescans more)
    const now = this.ctx.now();
    if (now - this.bookCursorsAt >= BOOK_CURSOR_PERSIST_MS) {
      this.bookCursorsAt = now;
      await this.setBookCursors(books, this.cursor);
    }
  }
}
