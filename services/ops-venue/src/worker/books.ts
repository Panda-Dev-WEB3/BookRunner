// Book discovery (poll): Orderly-venue books from deployment.books + BookFactory.bookIds(), their
// adapter account ids and lifecycle state. Non-Orderly books are remembered and skipped. Each book's charter symbol is
// mapped once here to its venue symbol (@bookrunner/shared resolveVenueSymbol: ORDERLY_MODE + ORDERLY_BROKER_ID). A
// live book without an Orderly market stays tracked for its non-trading duties (TrackedBook.venueSymbolError); the
// set of such books is published every pass (KEYS.venueSymbolIssues) for alerts.
import { type BookState, resolveVenueSymbol, type VenueSymbolIssuesMsg } from "@bookrunner/shared";
import { errMsg } from "../util";
import { lc, type OpsContext, type TrackedBook } from "./context";

export interface RegistryDelta {
  added: TrackedBook[];
  changed: Array<{ book: TrackedBook; from: BookState }>;
}

export class BookRegistry {
  readonly books = new Map<number, TrackedBook>();
  private readonly skipped = new Set<number>();

  constructor(private readonly ctx: OpsContext) {}

  async refresh(): Promise<RegistryDelta> {
    const delta: RegistryDelta = { added: [], changed: [] };
    const ids = await this.ctx.chain.listBookIds();
    for (const id of ids) {
      if (this.skipped.has(id)) continue;
      const known = this.books.get(id);
      if (known) {
        try {
          const state = await this.ctx.chain.bookState(known.book);
          if (state !== known.state) {
            const from = known.state;
            known.state = state;
            delta.changed.push({ book: known, from });
            this.ctx.log.info({ bookId: id, from, to: state }, "book state changed");
          }
        } catch (err) {
          this.ctx.log.warn({ bookId: id, err: errMsg(err) }, "book state read failed");
        }
        continue;
      }
      try {
        const b = await this.ctx.chain.loadOrderlyBook(id);
        if (!b) {
          this.skipped.add(id);
          continue;
        }
        const r = resolveVenueSymbol({ charterSymbol: b.charterSymbol, mode: this.ctx.settings.mode, brokerId: this.ctx.settings.brokerId });
        const [state, accounts, owners] = await Promise.all([this.ctx.chain.bookState(b.book), this.ctx.chain.accountIds(b.adapter), this.ctx.chain.accountOwners(b.adapter)]);
        const tb: TrackedBook = { ...b, symbol: r.symbol ?? b.charterSymbol, venueSymbolError: r.error, state, accounts, owners };
        this.books.set(id, tb);
        delta.added.push(tb);
        if (r.error !== null) {
          // the charter symbol is immutable: never listed / traded; its capital is still reported and withdrawable
          this.ctx.log.error({ bookId: id, charterSymbol: b.charterSymbol, state, err: r.error }, "Orderly book tracked WITHOUT listing or trading: no venue symbol for its charter symbol");
        } else {
          if (r.warning) this.ctx.log.warn({ bookId: id, charterSymbol: b.charterSymbol, warning: r.warning }, "Orderly book charter symbol breaks the charter rule");
          this.ctx.log.info({ bookId: id, symbol: r.symbol, charterSymbol: b.charterSymbol, state, adapter: b.adapter }, "tracking Orderly book");
        }
      } catch (err) {
        this.ctx.log.warn({ bookId: id, err: errMsg(err) }, "book load failed (will retry)");
      }
    }
    await this.publishStatus();
    return delta;
  }

  /** Books tracked without listing / trading (live mode, no Orderly market for the charter symbol). */
  untradable(): TrackedBook[] {
    return this.list().filter((b) => b.venueSymbolError !== null);
  }

  private async publishStatus(): Promise<void> {
    if (!this.ctx.status) return;
    const msg: VenueSymbolIssuesMsg = {
      v: 1,
      ts: this.ctx.now(),
      mode: this.ctx.settings.mode,
      builderPush: this.ctx.settings.builderPush === true,
      books: this.untradable().map((b) => ({ bookId: b.bookId, charterSymbol: b.charterSymbol, error: b.venueSymbolError as string })),
    };
    try {
      await this.ctx.status.venueSymbolIssues(msg);
    } catch (err) {
      this.ctx.log.debug({ err: errMsg(err) }, "venue symbol status publish failed");
    }
  }

  get(bookId: number): TrackedBook | undefined {
    return this.books.get(bookId);
  }

  byAdapter(adapter: string): TrackedBook | undefined {
    for (const b of this.books.values()) if (lc(b.adapter) === lc(adapter)) return b;
    return undefined;
  }

  byMandate(mandate: string): TrackedBook | undefined {
    for (const b of this.books.values()) if (lc(b.mandate) === lc(mandate)) return b;
    return undefined;
  }

  list(): TrackedBook[] {
    return [...this.books.values()];
  }
}
