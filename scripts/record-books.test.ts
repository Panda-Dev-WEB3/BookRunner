// scripts/record-books.ts: naming and merging of on-chain books into the deployment file (mainnet launch).
import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { indexUnderlying, strToBytes32, tokenUnderlying } from "../packages/shared/src/bytes32";
import type { BookComponents, Deployment } from "../packages/shared/src/types";
import { bookName, mergeBooks } from "./record-books";

const NVDA = "0x00000000000000000000000000000000000E0001" as Address;
const dep = { stockTokens: { NVDA: { token: NVDA, priceId: strToBytes32("NVDA"), multiplierWad: "1000000000000000000" } } };
const comps = (n: number): BookComponents => {
  const a = `0x${n.toString(16).padStart(40, "0")}` as Address;
  return { book: a, senior: a, junior: a, vault: a, mandate: a, router: a, desk: a, adapter: a };
};

describe("record-books", () => {
  test("names a Stock Token book by its ticker and an index book by its price id", () => {
    expect(bookName(dep, 1, tokenUnderlying(NVDA), null)).toBe("NVDA");
    expect(bookName(dep, 3, indexUnderlying("BKRN.INDEX.RHX5"), strToBytes32("RHX5"))).toBe("RHX5");
    expect(bookName(dep, 4, tokenUnderlying("0x00000000000000000000000000000000000e0009"), null)).toBe("BOOK4");
  });

  test("appends only unknown ids, sorted, keeping existing entries", () => {
    const base = { books: [{ bookId: 2, name: "TSLA", symbol: "PERP_TSLA_USDC", venue: 0, components: comps(2) }] } as unknown as Deployment;
    const out = mergeBooks(base, [
      { bookId: 2, name: "X", symbol: "X", venue: 0, components: comps(9) },
      { bookId: 1, name: "NVDA", symbol: "PERP_NVDA_USDC", venue: 0, components: comps(1) },
    ] as Deployment["books"]);
    expect(out.books.map((b) => [b.bookId, b.name])).toEqual([
      [1, "NVDA"],
      [2, "TSLA"],
    ]);
  });
});
