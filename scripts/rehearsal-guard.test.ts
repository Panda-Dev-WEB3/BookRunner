import { describe, expect, test } from "bun:test";
import type { Deployment } from "../packages/shared/src/types";
import { recordBooks, redeployVerdict, supervisorRunning } from "./rehearsal-guard";

const empty = [0n, 0n, 0n, 0n, 0n];

describe("rehearsal REDEPLOY guard (VERIFY O17)", () => {
  test("safe only when every book is Retired / Cancelled and every Orderly adapter is empty", () => {
    expect(redeployVerdict([])).toEqual({ safe: true, problems: [] });
    expect(redeployVerdict([{ bookId: 1, name: "NVDA", venue: 0, state: 4, amounts: empty }, { bookId: 2, name: "TSLA", venue: 0, state: 1, amounts: empty }]).safe).toBe(true);
    const live = redeployVerdict([{ bookId: 1, name: "NVDA", venue: 0, state: 2, amounts: [150_000_000n, 500_000_000n, 0n, 0n, 0n] }]);
    expect(live.safe).toBe(false);
    expect(live.problems).toEqual(["book 1 NVDA: Live (retire it first)", "book 1 NVDA: adapter not empty (IF / MM / in transit / pending: 150 / 500 / 0 / 0 / 0 USDG)"]);
    // Retired but money still in transit, or nothing readable: not safe
    expect(redeployVerdict([{ bookId: 1, name: "NVDA", venue: 0, state: 4, amounts: [0n, 0n, 1n, 0n, 0n] }]).safe).toBe(false);
    expect(redeployVerdict([{ bookId: 1, name: "NVDA", venue: 0, state: null, amounts: null }]).problems).toEqual(["book 1 NVDA: state unreadable", "book 1 NVDA: adapter balances unreadable"]);
    // a PoolEngine book: only its state
    expect(redeployVerdict([{ bookId: 3, name: "RHX5", venue: 1, state: 4, amounts: null }]).safe).toBe(true);
  });

  test("the record's books include an unfinished launch's", () => {
    const b = (bookId: number) => ({ bookId, name: `B${bookId}`, symbol: "PERP_NVDA_USDC", venue: 0 as const, components: {} as never });
    expect(recordBooks({ books: [], launch: { complete: false, launched: [b(1)] } } as Pick<Deployment, "books" | "launch">).map((x) => x.bookId)).toEqual([1]);
    expect(recordBooks({ books: [b(1), b(2)], launch: { complete: true } }).map((x) => x.bookId)).toEqual([1, 2]);
    expect(recordBooks({ books: [b(1)], launch: { complete: false, launched: [b(1), b(2)] } }).map((x) => x.bookId)).toEqual([1, 2]);
  });

  test("--supervisor: a fresh testnet-live supervisor status means the stack runs (deploy-testnet.sh refuses to archive)", () => {
    const st = (ts: number) => JSON.stringify({ v: 1, ts, network: "testnet-live", startedAt: 0, procs: [] });
    expect(supervisorRunning(st(1_000_000), 1_010_000)).toBe(true);
    expect(supervisorRunning(st(1_000_000), 1_000_000 + 91_000)).toBe(false);
    expect(supervisorRunning(null, 1)).toBe(false);
    expect(supervisorRunning("garbage", 1)).toBe(false);
  });
});
