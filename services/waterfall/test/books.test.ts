// RPC budget (deploy/server/MAINNET.md): BookDirectory re-reads BookFactory.bookIds() at most every refreshMs
// (BOOKS_REFRESH_SECONDS; mainnet profile 60 s), 0 = every call (devnet / testnet, unchanged); an unknown id is
// always looked up.
import { describe, expect, test } from "bun:test";
import { createLogger } from "@bookrunner/shared";
import { type Address, getAddress } from "viem";
import { BookDirectory } from "../src/kit/books";

const FACTORY = getAddress("0x00000000000000000000000000000000000f0001");
const a = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

function fakeChain(ids: bigint[]) {
  const calls: string[] = [];
  const pc = {
    readContract: async (r: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      calls.push(r.functionName);
      if (r.functionName === "bookIds") return ids;
      if (r.functionName === "componentsOf") {
        const n = Number(r.args?.[0]);
        return { book: a(0x100 + n), senior: a(0x200 + n), junior: a(0x300 + n), vault: a(0x400 + n), router: a(0x500 + n), mandate: a(0x600 + n), adapter: a(0x700 + n), desk: a(0x800 + n) };
      }
      if (r.functionName === "venueKind") return 1;
      throw new Error(`unexpected ${r.functionName}`);
    },
  };
  return { pc, calls };
}

const dep = { contracts: { factory: FACTORY }, books: [] } as never;
const log = createLogger("t", "silent");

describe("BookDirectory refresh", () => {
  test("refreshMs 0: factory.bookIds() on every list() (unchanged)", async () => {
    const { pc, calls } = fakeChain([1n]);
    const d = new BookDirectory(pc as never, dep, log);
    await d.list();
    await d.list();
    expect(calls.filter((c) => c === "bookIds")).toHaveLength(2);
  });

  test("refreshMs > 0: cached in between; a new book appears at the next refresh; get() of an unknown id looks it up", async () => {
    const ids = [1n];
    const { pc, calls } = fakeChain(ids);
    let now = 1_000_000;
    const d = new BookDirectory(pc as never, dep, log, 60_000, () => now);
    expect((await d.list()).map((b) => b.bookId)).toEqual([1]);
    ids.push(2n);
    now += 59_000;
    expect((await d.list()).map((b) => b.bookId)).toEqual([1]);
    expect(calls.filter((c) => c === "bookIds")).toHaveLength(1);
    now += 1_000;
    expect((await d.list()).map((b) => b.bookId)).toEqual([1, 2]);
    expect(calls.filter((c) => c === "bookIds")).toHaveLength(2);
    ids.push(3n);
    expect((await d.get(3))?.bookId).toBe(3);
    expect(calls.filter((c) => c === "bookIds")).toHaveLength(3);
  });

  test("a failed factory read is retried at the next list()", async () => {
    const { pc, calls } = fakeChain([1n]);
    let fail = true;
    const flaky = {
      readContract: async (r: { functionName: string }) => {
        if (fail && r.functionName === "bookIds") {
          calls.push("bookIds!");
          throw new Error("rpc down");
        }
        return pc.readContract(r as never);
      },
    };
    const d = new BookDirectory(flaky as never, dep, log, 60_000, () => 0);
    expect(await d.list()).toEqual([]);
    fail = false;
    expect((await d.list()).map((b) => b.bookId)).toEqual([1]);
    expect(calls).toEqual(["bookIds!", "bookIds", "componentsOf", "venueKind"]);
  });
});
