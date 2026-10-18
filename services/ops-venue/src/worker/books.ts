// Book discovery (poll): Orderly-venue books from deployment.books + BookFactory.bookIds(), their
// adapter account ids and lifecycle state. Non-Orderly books are remembered and skipped. Each book's charter symbol is
// mapped once here to its venue symbol (@bookrunner/shared venueSymbol: ORDERLY_MODE + ORDERLY_BROKER_ID).
import { type BookState, venueSymbol } from "@bookrunner/shared";
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
        let symbol: string;
        try {
          symbol = venueSymbol({ charterSymbol: b.charterSymbol, mode: this.ctx.settings.mode, brokerId: this.ctx.settings.brokerId });
        } catch (err) {
          // the charter symbol is immutable: this book can never trade on this venue; other books are unaffected
          this.skipped.add(id);
          this.ctx.log.error({ bookId: id, charterSymbol: b.charterSymbol, err: errMsg(err) }, "Orderly book skipped: no venue symbol for its charter symbol");
          continue;
        }
        const [state, accounts, owners] = await Promise.all([this.ctx.chain.bookState(b.book), this.ctx.chain.accountIds(b.adapter), this.ctx.chain.accountOwners(b.adapter)]);
        const tb: TrackedBook = { ...b, symbol, state, accounts, owners };
        this.books.set(id, tb);
        delta.added.push(tb);
        this.ctx.log.info({ bookId: id, symbol, charterSymbol: b.charterSymbol, state, adapter: b.adapter }, "tracking Orderly book");
      } catch (err) {
        this.ctx.log.warn({ bookId: id, err: errMsg(err) }, "book load failed (will retry)");
      }
    }
    return delta;
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
