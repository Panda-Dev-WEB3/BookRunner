// Book discovery: BookFactory.bookIds() + componentsOf(id) (books chartered after launch included),
// falling back to the deployment file's launch books when the factory is unreachable.
import { type BookComponents, BOOK_STATE, type BookState, ChainWake, type Deployment, type Logger, VENUE, type VenueId } from "@bookrunner/shared";
import { bookAbi, bookFactoryAbi, orderlyAdapterAbi } from "@bookrunner/shared/abi";
import type { PublicClient } from "viem";

export interface BookRef {
  bookId: number;
  venue: VenueId;
  components: BookComponents;
  name?: string;
  symbol?: string;
}

/**
 * RPC budget: with a WebSocket endpoint, factory.bookIds() is read when the BookFactory emits a log (BookCreated) and at
 * least every `safetySeconds`, instead of every refreshMs. undefined (no endpoint, or safetySeconds 0): the polling of
 * BOOKS_REFRESH_SECONDS, as before. While the subscription is down, or the primary RPC fails, it polls again.
 */
export function factoryWake(o: { wsUrl: string | undefined; safetySeconds: number; refreshSeconds: number; deployment: Deployment; label: string; log: Logger }): ChainWake | undefined {
  if (!o.wsUrl || o.safetySeconds <= 0 || o.refreshSeconds <= 0) return undefined;
  const wake = new ChainWake({
    url: o.wsUrl,
    label: o.label,
    filter: () => ({ address: [o.deployment.contracts.factory] }),
    pollMs: o.refreshSeconds * 1000,
    safetyMs: o.safetySeconds * 1000,
    log: o.log,
  });
  wake.start();
  return wake;
}

export const bookStateName = (n: number): BookState => BOOK_STATE[n] ?? "Subscription";

export class BookDirectory {
  private cache = new Map<number, BookRef>();
  private lastFactoryError = "";
  /** wall clock (ms) of the last successful factory.bookIds() read */
  private listedAt: number | null = null;

  /**
   * `refreshMs` (RPC budget, BOOKS_REFRESH_SECONDS): factory.bookIds() is re-read at most this often; in between
   * list() serves the known books (a book chartered meanwhile is picked up at the next refresh, or by get()). 0 = every
   * call (devnet / testnet default).
   */
  constructor(
    private readonly pc: PublicClient,
    private readonly deployment: Deployment,
    private readonly log: Logger,
    private readonly refreshMs = 0,
    private readonly now: () => number = Date.now,
    /** factoryWake(): when set, it decides when bookIds() is read (refreshMs is then its polling fallback) */
    private readonly wake?: ChainWake,
  ) {
    for (const b of deployment.books) {
      this.cache.set(b.bookId, { bookId: b.bookId, venue: b.venue, components: b.components, name: b.name, symbol: b.symbol });
    }
  }

  async list(): Promise<BookRef[]> {
    if (this.wake) {
      const t0 = this.now();
      if (this.listedAt !== null && !this.wake.due(t0)) return this.known();
      this.wake.begin(t0);
      const books = await this.refresh();
      if (this.listedAt === null || this.listedAt < t0) this.wake.failed(); // the read failed: due again at once
      return books;
    }
    if (this.refreshMs > 0 && this.listedAt !== null && this.now() - this.listedAt < this.refreshMs) return this.known();
    return this.refresh();
  }

  private known(): BookRef[] {
    return [...this.cache.values()].sort((a, b) => a.bookId - b.bookId);
  }

  private async refresh(): Promise<BookRef[]> {
    try {
      const ids = await this.pc.readContract({ address: this.deployment.contracts.factory, abi: bookFactoryAbi, functionName: "bookIds" });
      for (const raw of ids) {
        const id = Number(raw);
        if (this.cache.has(id)) continue;
        const c = await this.pc.readContract({ address: this.deployment.contracts.factory, abi: bookFactoryAbi, functionName: "componentsOf", args: [raw] });
        const venue = Number(await this.pc.readContract({ address: c.adapter, abi: orderlyAdapterAbi, functionName: "venueKind" })) as VenueId;
        this.cache.set(id, { bookId: id, venue: venue === VENUE.POOL_ENGINE ? VENUE.POOL_ENGINE : VENUE.ORDERLY, components: { ...c } });
        this.log.info({ bookId: id, book: c.book, venue }, "book discovered");
      }
      this.lastFactoryError = "";
      this.listedAt = this.now();
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err);
      if (msg !== this.lastFactoryError) this.log.warn({ err: msg }, "factory.bookIds() failed; using known books");
      this.lastFactoryError = msg;
    }
    return this.known();
  }

  async get(bookId: number): Promise<BookRef | undefined> {
    if (!this.cache.has(bookId)) await this.refresh(); // an unknown id is always looked up
    return this.cache.get(bookId);
  }

  async state(ref: BookRef): Promise<BookState> {
    return bookStateName(Number(await this.pc.readContract({ address: ref.components.book, abi: bookAbi, functionName: "state" })));
  }
}
