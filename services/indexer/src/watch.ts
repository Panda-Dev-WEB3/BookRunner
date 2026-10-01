// Watched address set: static protocol contracts from the deployment + each book's components,
// added dynamically when BookFactory.BookCreated is seen (or loaded from the books table on start).
import type { BookComponents, Deployment } from "@bookrunner/shared";
import type { Address } from "viem";
import type { ContractKind } from "./decode";

export interface WatchEntry {
  kind: ContractKind;
  bookId: number | null;
}

const BOOK_COMPONENT_KINDS: Array<[keyof BookComponents, ContractKind]> = [
  ["book", "book"],
  ["senior", "senior"],
  ["junior", "junior"],
  ["router", "router"],
  ["mandate", "mandate"],
];

const lc = (a: string) => a.toLowerCase() as Address;
const isZero = (a: string) => /^0x0{40}$/i.test(a);

export class WatchSet {
  private readonly protocol = new Map<Address, WatchEntry>();
  private readonly bookAddrs = new Map<Address, WatchEntry>();
  private readonly comps = new Map<number, BookComponents>();

  constructor(d: Pick<Deployment, "contracts">) {
    const c = d.contracts;
    const add = (a: Address | undefined, kind: ContractKind) => {
      if (a && !isZero(a)) this.protocol.set(lc(a), { kind, bookId: null });
    };
    add(c.charter, "charter");
    add(c.committee, "committee");
    add(c.factory, "factory");
    add(c.markRegistry, "markRegistry");
  }

  /** Returns true when the book was not known before. */
  addBook(bookId: number, components: BookComponents): boolean {
    const isNew = !this.comps.has(bookId);
    this.comps.set(bookId, components);
    for (const [key, kind] of BOOK_COMPONENT_KINDS) {
      const a = components[key];
      if (a && !isZero(a)) this.bookAddrs.set(lc(a), { kind, bookId });
    }
    return isNew;
  }

  lookup(address: string): WatchEntry | undefined {
    const a = lc(address);
    return this.protocol.get(a) ?? this.bookAddrs.get(a);
  }

  components(bookId: number): BookComponents | undefined {
    return this.comps.get(bookId);
  }

  protocolAddresses(): Address[] {
    return [...this.protocol.keys()];
  }

  bookAddresses(): Address[] {
    return [...this.bookAddrs.keys()];
  }

  bookCount(): number {
    return this.comps.size;
  }
}
