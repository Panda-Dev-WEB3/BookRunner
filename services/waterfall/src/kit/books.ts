// Book discovery: BookFactory.bookIds() + componentsOf(id) (books chartered after launch included),
// falling back to the deployment file's launch books when the factory is unreachable.
import { type BookComponents, BOOK_STATE, type BookState, type Deployment, type Logger, VENUE, type VenueId } from "@bookrunner/shared";
import { bookAbi, bookFactoryAbi, orderlyAdapterAbi } from "@bookrunner/shared/abi";
import type { PublicClient } from "viem";

export interface BookRef {
  bookId: number;
  venue: VenueId;
  components: BookComponents;
  name?: string;
  symbol?: string;
}

export const bookStateName = (n: number): BookState => BOOK_STATE[n] ?? "Subscription";

export class BookDirectory {
  private cache = new Map<number, BookRef>();
  private lastFactoryError = "";

  constructor(
    private readonly pc: PublicClient,
    private readonly deployment: Deployment,
    private readonly log: Logger,
  ) {
    for (const b of deployment.books) {
      this.cache.set(b.bookId, { bookId: b.bookId, venue: b.venue, components: b.components, name: b.name, symbol: b.symbol });
    }
  }

  async list(): Promise<BookRef[]> {
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
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err);
      if (msg !== this.lastFactoryError) this.log.warn({ err: msg }, "factory.bookIds() failed; using known books");
      this.lastFactoryError = msg;
    }
    return [...this.cache.values()].sort((a, b) => a.bookId - b.bookId);
  }

  async get(bookId: number): Promise<BookRef | undefined> {
    if (!this.cache.has(bookId)) await this.list();
    return this.cache.get(bookId);
  }

  async state(ref: BookRef): Promise<BookState> {
    return bookStateName(Number(await this.pc.readContract({ address: ref.components.book, abi: bookAbi, functionName: "state" })));
  }
}
