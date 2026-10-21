// Insurance pool (2026-10): pool events -> pool_deposits / pool_withdrawals / pool_epochs / pool_books / pool_flows /
// pool_snapshots, the premium of a pool-funded book's distribution, and idempotent re-application.
import { describe, expect, test } from "bun:test";
import { createLogger, dbUsd } from "@bookrunner/shared";
import { bookAbi, insurancePoolAbi, revenueRouterAbi } from "@bookrunner/shared/abi";
import type { Abi, Address, Hex } from "viem";
import type { PoolStateLite } from "../src/chain";
import { CURSORS } from "../src/config";
import { Indexer } from "../src/runner";
import { WatchSet } from "../src/watch";
import { FakeChain, MemoryIndexerStore, makeLog, txHash } from "./helpers";
import { ADDR, COMPONENTS, DEPLOYMENT } from "./scenario";

const logger = createLogger("indexer-pool-test", "silent");
const POOL = "0x00000000000000000000000000000000000000c5" as Address;
const OWNER = "0x0000000000000000000000000000000000000a11" as Address;
const MARKET = `0x${"0".repeat(24)}${"aa".repeat(20)}` as Hex;
const U = (n: number) => BigInt(n) * 1_000_000n;
const D = (n: number) => dbUsd.toDb(U(n)); // the DB form of a whole-dollar amount
const S = (n: number) => BigInt(n) * 10n ** 12n; // whole pool shares (12 decimals)
const WEEK = 604_800;
const END0 = 1_790_208_000; // epoch 0's end (a weekly grid point)

const state = (o: Partial<PoolStateLite>): PoolStateLite => ({
  poolAssets: 0n,
  depositorAssets: 0n,
  totalSupply: 0n,
  sharePrice: 1_000_000n,
  firstLoss: 0n,
  freeLiquidity: 0n,
  claims: 0n,
  utilisationBps: 0,
  premiumsTotal: 0n,
  lossesTotal: 0n,
  depositsPending: 0n,
  pendingShares: 0n,
  ...o,
});

function world() {
  const chain = new FakeChain();
  const L = (abi: Abi, address: Address, name: string, args: Record<string, unknown>, block: number, logIndex: number, tx: number) =>
    chain.logs.push(makeLog(abi, name, args, { address, block, logIndex, tx }));
  const deployment = { ...DEPLOYMENT, contracts: { ...(DEPLOYMENT.contracts as object), insurancePool: POOL } as never };
  const watch = new WatchSet(deployment);
  watch.addBook(1, COMPONENTS);
  const store = new MemoryIndexerStore();
  const make = () =>
    new Indexer({ store, chain, watch, deployment, publisher: null, logger, config: { confirmations: 0, batchBlocks: 2000, poisonAttempts: 3, startBlock: 1 } });

  // block 1: the treasury seeds the slice; a depositor queues 90,000 for epoch 0
  L(insurancePoolAbi, POOL, "FirstLossDeposited", { from: ADDR.sponsor, amount: U(10_000) }, 1, 0, 101);
  L(insurancePoolAbi, POOL, "DepositRequested", { depositId: 1n, owner: OWNER, assets: U(90_000), epoch: 0n }, 1, 1, 102);
  L(insurancePoolAbi, POOL, "DepositRequested", { depositId: 2n, owner: OWNER, assets: U(5_000), epoch: 0n }, 1, 2, 103);
  chain.poolStates.set(1, state({ poolAssets: U(10_000), firstLoss: U(10_000), freeLiquidity: U(10_000), depositsPending: U(95_000) }));
  // block 2: the second deposit is cancelled before the epoch is processed
  L(insurancePoolAbi, POOL, "DepositCancelled", { depositId: 2n, owner: OWNER, assets: U(5_000) }, 2, 0, 104);
  // block 3: epoch 0 processed (stale: one book had not marked), deposit claimed
  L(insurancePoolAbi, POOL, "EpochProcessedStale", { epoch: 0n, staleBooks: 1n }, 3, 0, 105);
  L(insurancePoolAbi, POOL, "EpochProcessed", { epoch: 0n, depositAssets: U(90_000), depositShares: S(90_000), stale: true }, 3, 1, 105);
  L(insurancePoolAbi, POOL, "DepositClaimed", { depositId: 1n, owner: OWNER, shares: S(90_000) }, 3, 2, 106);
  chain.poolEpochEnds.set(0, END0);
  chain.poolStates.set(3, state({ poolAssets: U(100_000), depositorAssets: U(90_000), totalSupply: S(90_000), firstLoss: U(10_000), freeLiquidity: U(100_000) }));
  // block 4: book 1 draws its IF (25,000) from the pool
  L(insurancePoolAbi, POOL, "Allocated", { bookId: 1n, book: ADDR.book, vault: ADDR.vault, market: MARKET, amount: U(25_000) }, 4, 0, 107);
  chain.poolPositions.set(1, {
    book: ADDR.book,
    market: MARKET,
    allocation: U(25_000),
    claim: U(25_000),
    lossFirstLoss: 0n,
    lossDepositors: 0n,
    lastMarkAt: END0 + 10,
    active: true,
  });
  chain.poolStates.set(4, state({ poolAssets: U(100_000), depositorAssets: U(90_000), totalSupply: S(90_000), firstLoss: U(10_000), freeLiquidity: U(75_000), claims: U(25_000), utilisationBps: 2500 }));
  // block 5: a distribution of 100 pays a 12 premium first (router), received by the pool in the same tx
  L(revenueRouterAbi, ADDR.router, "Distributed", { bookId: 1n, period: 1_790_300_000n, amounts: [U(100), U(4), U(8), U(46), U(30)] }, 5, 0, 108);
  L(revenueRouterAbi, ADDR.router, "PremiumPaid", { bookId: 1n, period: 1_790_300_000n, pool: POOL, amount: U(12), premiumBps: 1200n }, 5, 1, 108);
  L(insurancePoolAbi, POOL, "PremiumReceived", { bookId: 1n, amount: U(12), firstLossShare: 1_200_000n }, 5, 2, 108);
  // block 6: a withdrawal request for epoch 1
  L(insurancePoolAbi, POOL, "WithdrawRequested", { requestId: 1n, owner: OWNER, shares: S(9_000), epoch: 1n, epochEndsAt: BigInt(END0 + WEEK) }, 6, 0, 109);
  // block 7: epoch 1 fills it in two parts, then the owner claims twice
  L(insurancePoolAbi, POOL, "EpochProcessed", { epoch: 1n, depositAssets: 0n, depositShares: 0n, stale: false }, 7, 0, 110);
  L(insurancePoolAbi, POOL, "EpochFilled", { epoch: 1n, shares: S(4_000), assets: U(4_000), complete: false }, 7, 1, 110);
  L(insurancePoolAbi, POOL, "Claimed", { requestId: 1n, owner: OWNER, assets: U(4_000) }, 7, 2, 111);
  L(insurancePoolAbi, POOL, "EpochFilled", { epoch: 1n, shares: S(5_000), assets: U(5_000), complete: true }, 8, 0, 112);
  L(insurancePoolAbi, POOL, "Claimed", { requestId: 1n, owner: OWNER, assets: U(5_000) }, 8, 1, 113);
  // block 9: the book is exhausted: the pool marks 2,000 down (slice first)
  L(insurancePoolAbi, POOL, "BookMarked", { bookId: 1n, value: U(23_000), periodEnd: BigInt(END0 + WEEK), final_: false }, 9, 0, 114);
  L(insurancePoolAbi, POOL, "LossReported", { bookId: 1n, amount: U(2_000), firstLossAbsorbed: U(2_000), depositorsAbsorbed: 0n, claim: U(23_000) }, 9, 1, 114);
  // the book's side of the same mark: a provisional shortfall; at retirement (block 10) the final write-off
  L(bookAbi, ADDR.book, "InsuranceShortfall", { bookId: 1n, shortfall: U(2_000) }, 9, 2, 114);
  // the next mark is still short by the same amount: no second event
  L(bookAbi, ADDR.book, "InsuranceShortfall", { bookId: 1n, shortfall: U(2_000) }, 9, 3, 116);
  L(bookAbi, ADDR.book, "InsuranceShortfall", { bookId: 1n, shortfall: U(1_500) }, 10, 0, 115);
  L(bookAbi, ADDR.book, "InsuranceWrittenOff", { bookId: 1n, amount: U(1_500) }, 10, 1, 115);
  chain.head = 10n;
  return { chain, store, make };
}

async function drain(ix: Indexer) {
  for (let i = 0; i < 20; i++) if ((await ix.step()).status === "idle") return;
}

describe("insurance pool indexing", () => {
  test("deposits, epochs, fills, claims, book position, premium, loss and snapshots", async () => {
    const { chain, store, make } = world();
    await drain(make());
    const s = store.s;

    expect(s.poolDeposits[1]).toMatchObject({ owner: OWNER.toLowerCase(), assets: D(90000), epoch: 0, status: "claimed", sharesRaw: S(90_000).toString() });
    expect(s.poolDeposits[2]).toMatchObject({ status: "cancelled" });

    expect(s.poolEpochs[0]).toMatchObject({ depositAssets: D(90000), depositSharesRaw: S(90_000).toString(), stale: true, staleBooks: 1, processTx: txHash(105) });
    expect(new Date(String(s.poolEpochs[0]?.endsAt)).getTime()).toBe(END0 * 1000);
    expect(s.poolEpochs[1]).toMatchObject({ filledSharesRaw: S(9_000).toString(), filledAssets: D(9000), complete: true, stale: false });

    expect(s.poolWithdrawals[1]).toMatchObject({ sharesRaw: S(9_000).toString(), epoch: 1, claimedAssets: D(9000) });

    expect(s.poolBooks[1]).toMatchObject({ market: MARKET.toLowerCase(), allocation: D(25000), active: true, premiumsUsd: D(12) });

    // the distribution row carries the premium of its own tx: premium + split == gross
    const dist = Object.values(s.settlements).find((r) => r.source === "distribution");
    expect(dist).toMatchObject({ grossUsd: D(100), premiumUsd: D(12), seniorUsd: D(46) });

    const kinds = Object.values(s.poolFlows).map((f) => f.kind).sort();
    expect(kinds).toEqual(["allocated", "epoch_fill", "epoch_fill", "first_loss_deposit", "loss", "premium", "withdraw_claim", "withdraw_claim"]);
    expect(Object.values(s.poolFlows).find((f) => f.kind === "loss")).toMatchObject({ bookId: 1, amount: D(2000), firstLossPart: D(2000) });

    expect(s.poolSnapshots[4]).toMatchObject({ claims: D(25000), utilisationBps: 2500, sharePrice: D(1), totalSupplyRaw: S(90_000).toString() });
    // the book is still active: the pool's loss is provisional (recovered first by later marks, final at retirement)
    expect(Object.values(s.events).find((e) => e.type === "pool.loss_reported" && e.bookId === 1)?.payload).toMatchObject({ provisional: true, amountUsd: D(2000) });
    const shortfalls = Object.values(s.events).filter((e) => e.type === "book.insurance_shortfall").map((e) => e.payload);
    expect(shortfalls).toHaveLength(2);
    expect(shortfalls[0]).toMatchObject({ bookId: 1, shortfallUsd: D(2000), provisional: true });
    expect(shortfalls[1]).toMatchObject({ bookId: 1, shortfallUsd: D(1500), provisional: false }); // retirement tx
    expect(Object.values(s.events).find((e) => e.type === "book.insurance_written_off")?.payload).toMatchObject({ bookId: 1, amountUsd: D(1500), provisional: false });
    expect(Object.values(s.events).filter((e) => e.type === "pool.epoch_processed")).toHaveLength(2);
    expect(chain.poolStateCalls).toBeGreaterThan(0);
  });

  test("re-applying the same range changes nothing (claims, fills and premiums are not counted twice)", async () => {
    const { store, make } = world();
    await drain(make());
    const before = JSON.stringify(store.s);
    await store.setCursor(CURSORS.protocol, 0);
    await store.setCursor(CURSORS.books, 0);
    await drain(make());
    const after = JSON.parse(JSON.stringify(store.s));
    const was = JSON.parse(before);
    expect(after.poolWithdrawals).toEqual(was.poolWithdrawals);
    expect(after.poolEpochs).toEqual(was.poolEpochs);
    expect(after.poolBooks).toEqual(was.poolBooks);
    expect(after.poolFlows).toEqual(was.poolFlows);
    expect(after.poolDeposits).toEqual(was.poolDeposits);
  });

  test("review I-3: failed pool reads keep the event rows, write stale rows, and the next pass backfills them", async () => {
    const { chain, store, make } = world();
    chain.poolDown = true;
    const ix = make();
    await drain(ix);
    const s = store.s;
    // the events themselves are all recorded
    expect(s.poolDeposits[1]?.status).toBe("claimed");
    expect(s.poolWithdrawals[1]?.claimedAssets).toBe(D(9000));
    // positions: the Allocated event's own figures, stale; snapshots: one stale row per block, never dropped
    expect(s.poolBooks[1]).toMatchObject({ allocation: D(25000), claim: D(25000), active: true, stale: true });
    expect(Object.keys(s.poolSnapshots).length).toBeGreaterThan(0);
    expect(Object.values(s.poolSnapshots).every((r) => r.stale)).toBe(true);
    expect(s.poolEpochs[0]?.endsAt ?? null).toBeNull();
    // the read failure was not cached: the RPC comes back, the next pass re-reads everything
    chain.poolDown = false;
    await ix.step();
    expect(s.poolBooks[1]).toMatchObject({ allocation: D(25000), stale: false });
    expect(Object.values(s.poolSnapshots).some((r) => r.stale)).toBe(false);
    expect(s.poolSnapshots[4]).toMatchObject({ claims: D(25000), utilisationBps: 2500 });
    expect(new Date(String(s.poolEpochs[0]?.endsAt)).getTime()).toBe(END0 * 1000);
  });

  test("a deployment without a pool watches no pool address", () => {
    const w = new WatchSet(DEPLOYMENT);
    expect(w.protocolAddresses()).not.toContain(POOL);
    const withPool = new WatchSet({ contracts: { ...(DEPLOYMENT.contracts as object), insurancePool: POOL } as never });
    expect(withPool.lookup(POOL)).toEqual({ kind: "pool", bookId: null });
  });
});
