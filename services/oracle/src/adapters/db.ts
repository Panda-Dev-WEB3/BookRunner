// Postgres adapter: oracle_prices rows (one per pushed update, with pushed_tx) and the charter /
// book reads used by discovery.
import { type Db, books, charters, oraclePrices } from "@bookrunner/db";
import type { OraclePriceMsg } from "@bookrunner/shared";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import type { DbBook, DbReader } from "../discovery";

export interface PriceStore {
  insertPrices(rows: ReadonlyArray<{ msg: OraclePriceMsg; pushedTx: Hex | null }>): Promise<void>;
}

export class DrizzlePriceStore implements PriceStore, DbReader {
  constructor(private readonly db: Db) {}

  async insertPrices(rows: ReadonlyArray<{ msg: OraclePriceMsg; pushedTx: Hex | null }>): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(oraclePrices).values(
      rows.map(({ msg, pushedTx }) => ({
        priceId: msg.priceId,
        ts: new Date(msg.publishedAt * 1000),
        price: msg.price,
        held: msg.held,
        sourceCount: msg.sourceCount,
        sources: msg.sources,
        sourcesHash: msg.sourcesHash,
        signature: msg.signature,
        pushedTx,
      })),
    );
  }

  async charterSessions(bookId: number): Promise<Hex | null> {
    const rows = await this.db.select({ structJson: charters.structJson }).from(charters).where(eq(charters.id, bookId)).limit(1);
    const s = (rows[0]?.structJson as { sessions?: unknown } | undefined)?.sessions;
    return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s) ? (s.toLowerCase() as Hex) : null;
  }

  async books(): Promise<DbBook[]> {
    const rows = await this.db
      .select({ bookId: books.id, bookAddr: books.bookAddr, underlying: books.underlying, venue: books.venue, symbol: books.symbol, name: books.name })
      .from(books);
    return rows;
  }
}
