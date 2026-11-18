// RPC budget (deploy/server/MAINNET.md): BookDirectory re-reads BookFactory.bookIds() at most every refreshMs
// (BOOKS_REFRESH_SECONDS; mainnet profile 60 s), 0 = every call (devnet / testnet, unchanged); an unknown id is
// always looked up.
import { describe, expect, test } from "bun:test";
import { ChainWake, createLogger } from "@bookrunner/shared";
import { type Address, getAddress } from "viem";
import { BookDirectory, factoryWake } from "../src/kit/books";

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

describe("BookDirectory with a log subscription (RPC budget)", () => {
  class FakeWs {
    readyState = 1;
    private fns: Record<string, Array<(ev: { data?: unknown }) => void>> = {};
    send() {}
    close() {
      this.readyState = 3;
    }
    addEventListener(t: string, fn: (ev: { data?: unknown }) => void) {
      (this.fns[t] ??= []).push(fn);
    }
    emit(t: string, data?: unknown) {
      for (const f of this.fns[t] ?? []) f({ data });
    }
  }

  test("factoryWake: off without a WebSocket URL or with safetySeconds 0", () => {
    expect(factoryWake({ wsUrl: undefined, safetySeconds: 600, refreshSeconds: 60, deployment: dep, label: "t", log })).toBeUndefined();
    expect(factoryWake({ wsUrl: "wss://x/ws", safetySeconds: 0, refreshSeconds: 60, deployment: dep, label: "t", log })).toBeUndefined();
    expect(factoryWake({ wsUrl: "wss://x/ws", safetySeconds: 600, refreshSeconds: 0, deployment: dep, label: "t", log })).toBeUndefined();
  });

  test("subscribed: bookIds() is read on a factory log and at the safety poll, not every refreshMs; down: every refreshMs", async () => {
    const ids = [1n];
    const { pc, calls } = fakeChain(ids);
    let now = 1_000_000;
    const sockets: FakeWs[] = [];
    const wake = new ChainWake({
      url: "wss://x/ws",
      label: "t",
      filter: () => ({ address: [FACTORY] }),
      pollMs: 60_000,
      safetyMs: 600_000,
      now: () => now,
      ws: () => {
        const s = new FakeWs();
        sockets.push(s);
        return s as never;
      },
    });
    wake.start();
    const d = new BookDirectory(pc as never, dep, log, 60_000, () => now, wake);
    const reads = () => calls.filter((c) => c === "bookIds").length;
    expect((await d.list()).map((b) => b.bookId)).toEqual([1]); // first call: read
    now += 10_000;
    await d.list(); // not subscribed yet: polling cadence, 10 s < 60 s
    expect(reads()).toBe(1);
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", JSON.stringify({ id: 1, result: "0xsub" }));
    now += 10_000;
    await d.list(); // catch-up read on coming up
    expect(reads()).toBe(2);
    now += 120_000;
    await d.list(); // subscribed: idle although refreshMs passed twice
    expect(reads()).toBe(2);
    ids.push(2n);
    sockets[0]!.emit("message", JSON.stringify({ method: "eth_subscription", params: { subscription: "0xsub", result: { address: FACTORY, topics: ["0x01"], data: "0x", blockNumber: "0x10", logIndex: "0x0", transactionHash: "0x02" } } }));
    expect((await d.list()).map((b) => b.bookId)).toEqual([1, 2]); // BookCreated: read at once
    expect(reads()).toBe(3);
    now += 600_000;
    await d.list(); // safety poll
    expect(reads()).toBe(4);
    wake.stop();
  });
});
