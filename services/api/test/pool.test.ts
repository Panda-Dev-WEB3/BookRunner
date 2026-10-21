// Insurance pool router (2026-10): overview (live / snapshot fallback / no pool), queue phases, a wallet's position,
// processed epochs, history, per-market exposure, and the prepared transactions (verified like the web does).
import { describe, expect, test } from "bun:test";
import { tokenUnderlying } from "@bookrunner/shared";
import { verifyPreparedTxs } from "@bookrunner/shared/preparedTx";
import { insurancePoolAbi } from "@bookrunner/shared/abi";
import { TRPCError } from "@trpc/server";
import { decodeFunctionData, getAddress } from "viem";
import type { PoolChainState } from "../src/chain/gateway";
import { effectiveQueue, openEpochFor, parseShares, queueStatus, withdrawalStatus } from "../src/domain/pool";
import { A } from "./fakes";
import { ALICE, NOW, type World, makeWorld, seedBook } from "./fixtures";

const POOL = A(0xd0);
const U = (n: number) => BigInt(Math.round(n * 1e6));
const S = (n: number) => BigInt(n) * 10n ** 12n;
const DAY = 86_400;
const WEEK = 7 * DAY;
const nowSec = Math.floor(NOW / 1000);
/** epoch 3 ends at the next weekly grid point after NOW */
const END = (Math.floor(nowSec / WEEK) + 1) * WEEK;
const NVDA = tokenUnderlying(A(0x1001));

function poolState(o: Partial<PoolChainState> = {}): PoolChainState {
  return {
    address: POOL,
    nowSec,
    poolAssets: U(1_000_000),
    depositorAssets: U(900_000),
    totalSupply: S(900_000),
    sharePrice: 1_000_000n,
    firstLoss: U(100_000),
    firstLossBps: 1000,
    freeLiquidity: U(750_000),
    claims: U(250_000),
    utilisationBps: 2500,
    premiumsTotal: U(1_200),
    lossesTotal: 0n,
    depositsPending: U(5_000),
    params: { premiumFloorBps: 1200, marketCapBps: 3000, bufferBps: 2000, firstLossTargetBps: 1000, cooldown: WEEK, epochLength: WEEK, processGrace: DAY, pendingEpochLength: 0 },
    paused: { deposits: false, allocations: false },
    queue: { procEpoch: 3, procEndsAt: END, fillEpoch: 3, pendingShares: S(1_000), reserved: 0n },
    openEpoch: { depositAssets: U(5_000), withdrawShares: S(1_000) },
    staleBooks: 0,
    activeBooks: [1],
    ...o,
  };
}

function world(o: Partial<PoolChainState> = {}): World {
  const w = makeWorld();
  w.chain.pool = poolState(o);
  return w;
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof TRPCError ? e.code : String(e);
  }
};

describe("pool domain", () => {
  test("open epoch and cooldown on the weekly grid", () => {
    const s = poolState();
    expect(openEpochFor(s, nowSec, nowSec + 1)).toEqual({ epoch: 3, endsAt: END });
    // cooldown until after the epoch's end: the request lands one epoch later
    expect(openEpochFor(s, nowSec, END + 1)).toEqual({ epoch: 4, endsAt: END + WEEK });
    expect(openEpochFor(s, nowSec, END)).toEqual({ epoch: 3, endsAt: END });
  });

  test("an idle queue whose epoch ended jumps to the current grid epoch (contract _skipIdleEpochs)", () => {
    const s = poolState({ queue: { procEpoch: 1, procEndsAt: END - 2 * WEEK, fillEpoch: 1, pendingShares: 0n, reserved: 0n }, depositsPending: 0n });
    expect(effectiveQueue(s, nowSec)).toEqual({ procEpoch: 3, procEndsAt: END, len: WEEK });
    expect(queueStatus(s).phase).toBe("open");
  });

  test("queue phases: open, awaiting marks in the grace, processable", () => {
    expect(queueStatus(poolState()).phase).toBe("open");
    const ended = { nowSec: END + 60 };
    expect(queueStatus(poolState({ ...ended, staleBooks: 1 }))).toMatchObject({ phase: "awaiting_marks", staleBooks: 1, graceEndsAt: END + DAY });
    expect(queueStatus(poolState({ ...ended, staleBooks: 0 })).phase).toBe("processable");
    expect(queueStatus(poolState({ nowSec: END + DAY, staleBooks: 1 })).phase).toBe("processable");
    // nothing in this epoch (requests only in later ones): processed without waiting for marks
    expect(queueStatus(poolState({ ...ended, staleBooks: 2, openEpoch: { depositAssets: 0n, withdrawShares: 0n } })).phase).toBe("processable");
  });

  test("withdrawal status is the pro-rata share of what its epoch filled", () => {
    const ep = { shares: S(100), filledShares: S(40), assets: U(40), depositAssets: 0n, depositShares: 0n, endsAt: END, processed: true };
    expect(withdrawalStatus(S(10), 0n, ep)).toEqual({ status: "filling", entitled: U(4), filledShares: S(4) });
    expect(withdrawalStatus(S(10), U(10), { ...ep, filledShares: S(100), assets: U(100) }).status).toBe("claimed");
    expect(withdrawalStatus(S(10), 0n, null).status).toBe("queued");
  });

  test("shares parse with up to 12 decimals", () => {
    expect(parseShares("1.5")).toBe(1_500_000_000_000n);
    expect(parseShares("0")).toBeNull();
    expect(parseShares("1.0000000000001")).toBeNull();
  });
});

describe("pool router: reads", () => {
  test("overview from the chain", async () => {
    const w = world();
    const o = await w.caller.pool.overview();
    expect(o).toMatchObject({
      available: true,
      live: true,
      address: POOL,
      poolAssetsUsd: "1000000.000000",
      firstLossBps: 1000,
      utilisationBps: 2500,
      sharePriceUsd: "1.000000",
      queue: { epoch: 3, phase: "open", ended: false, depositsUsd: "5000.000000", withdrawShares: "1000.0" },
      params: { marketCapBps: 3000, premiumFloorBps: 1200, cooldownSeconds: WEEK },
    });
  });

  test("overview falls back to the newest snapshot when the chain read fails, and says when there is no pool", async () => {
    const w = world();
    w.chain.failAll = true;
    w.data.poolSnapshotRows.push({
      blockNumber: 10,
      ts: new Date(NOW - 60_000),
      poolAssets: "500000",
      depositorAssets: "450000",
      totalSupplyRaw: S(450_000).toString(),
      sharePrice: "1",
      firstLoss: "50000",
      freeLiquidity: "500000",
      claims: "0",
      utilisationBps: 0,
      premiumsTotal: "0",
      lossesTotal: "0",
      depositsPending: "0",
      pendingSharesRaw: "0",
    });
    expect(await w.caller.pool.overview()).toMatchObject({ available: true, live: false, poolAssetsUsd: "500000.000000", firstLossBps: 1000, queue: null });

    const none = makeWorld();
    none.chain.deployment.contracts.insurancePool = undefined;
    expect(await none.caller.pool.overview()).toMatchObject({ available: false, live: false });
  });

  test("position: shares, cooldown, deposits (queued / ready / cancellable) and withdrawals (filling, claimable)", async () => {
    const w = world();
    const owner = ALICE.toLowerCase();
    w.chain.poolWallets.set(owner, { shares: S(2_000), value: U(2_000), cooldownEnds: nowSec + DAY, usdcBalance: U(10_000), usdcAllowance: 0n });
    w.data.poolDepositRows.push(
      { id: 1, owner, assets: "1000", epoch: 2, status: "queued", sharesRaw: null, requestedAt: new Date(NOW - 8 * DAY * 1000), requestTx: "0x01", closedAt: null, closeTx: null },
      { id: 2, owner, assets: "500", epoch: 3, status: "queued", sharesRaw: null, requestedAt: new Date(NOW - 1000), requestTx: "0x02", closedAt: null, closeTx: null },
    );
    w.data.poolWithdrawalRows.push({ id: 7, owner, sharesRaw: S(100).toString(), epoch: 2, epochEndsAt: new Date((END - WEEK) * 1000), requestedAt: new Date(NOW - 9 * DAY * 1000), requestTx: "0x07", claimedAssets: "0", lastClaimAt: null });
    w.chain.poolEpochInfo.set(2, { shares: S(200), filledShares: S(100), assets: U(100), depositAssets: U(1_000), depositShares: S(1_000), endsAt: END - WEEK, processed: true });
    w.chain.poolClaimable.set(7, U(50));
    const p = await w.caller.pool.position({ wallet: ALICE });
    expect(p).toMatchObject({ live: true, shares: "2000.0", valueUsd: "2000.000000", inCooldown: true, usdcBalance: "10000.000000" });
    expect(p.deposits.find((d) => d.depositId === 1)).toMatchObject({ status: "ready", shares: "1000.0", cancellable: false });
    expect(p.deposits.find((d) => d.depositId === 2)).toMatchObject({ status: "queued", cancellable: true, epochEndsAt: new Date(END * 1000).toISOString() });
    expect(p.withdrawals[0]).toMatchObject({ requestId: 7, status: "filling", filledUsd: "50.000000", claimableUsd: "50.000000", filledShares: "50.0" });
  });

  test("epochs, history (observed share price change) and per-market exposure", async () => {
    const w = world();
    seedBook(w);
    w.data.poolEpochRows.push(
      { epoch: 1, endsAt: new Date(0), processedAt: new Date(0), processTx: "0x1", depositAssets: "100", depositSharesRaw: S(100).toString(), stale: false, staleBooks: 0, filledSharesRaw: "0", filledAssets: "0", complete: false },
      { epoch: 2, endsAt: new Date(0), processedAt: new Date(0), processTx: "0x2", depositAssets: "0", depositSharesRaw: "0", stale: true, staleBooks: 1, filledSharesRaw: S(10).toString(), filledAssets: "10", complete: true },
    );
    const ep = await w.caller.pool.epochs({ limit: 1 });
    expect(ep.items).toHaveLength(1);
    expect(ep.items[0]).toMatchObject({ epoch: 2, stale: true, staleBooks: 1, withdrawUsd: "10.000000", complete: true });
    expect(ep.nextCursor).toBe(2);
    expect((await w.caller.pool.epochs({ limit: 5, cursor: 2 })).items.map((e) => e.epoch)).toEqual([1]);

    const snap = (block: number, msAgo: number, price: string) => ({
      blockNumber: block,
      ts: new Date(NOW - msAgo),
      poolAssets: "1000000",
      depositorAssets: "900000",
      totalSupplyRaw: S(900_000).toString(),
      sharePrice: price,
      firstLoss: "100000",
      freeLiquidity: "750000",
      claims: "250000",
      utilisationBps: 2500,
      premiumsTotal: "0",
      lossesTotal: "0",
      depositsPending: "0",
      pendingSharesRaw: "0",
    });
    w.data.poolSnapshotRows.push(snap(1, 40 * DAY * 1000, "1"), snap(2, 10 * DAY * 1000, "1.002"), snap(3, 1000, "1.004"));
    w.data.poolFlowDayRows.push({ day: new Date(NOW - 2 * DAY * 1000), premiumUsd: "12", lossUsd: "0", recoveryUsd: "0" });
    const h = await w.caller.pool.history({ days: 30 });
    expect(h.points.map((p) => p.sharePriceUsd)).toEqual(["1.002000", "1.004000"]);
    expect(h.sharePriceChange).toMatchObject({ startUsd: "1.000000", endUsd: "1.004000", changeBps: 40 });
    expect(h.flows[0]).toMatchObject({ premiumUsd: "12.000000" });

    w.data.poolBookRows.push(
      { bookId: 1, market: NVDA.toLowerCase(), allocation: "250000", claim: "248000", lossFirstLoss: "2000", lossDepositors: "0", premiumsUsd: "12", lastMarkAt: new Date(NOW), active: true, allocatedAt: new Date(NOW), updatedAt: new Date(NOW) },
    );
    const x = await w.caller.pool.exposure();
    expect(x.marketCapBps).toBe(3000);
    expect(x.capUsd).toBe("300000.000000");
    expect(x.markets[0]).toMatchObject({ label: "NVDA", allocatedUsd: "250000.000000", provisionalLossUsd: "2000.000000", writtenOffUsd: "0.000000", capUsedBps: 8333, shareOfPoolBps: 2500 });
    expect(x.markets[0]!.books[0]).toMatchObject({ bookId: 1, symbol: "PERP_NVDA_USDC", premiumsUsd: "12.000000", lossUsd: "2000.000000", lossStatus: "provisional" });
    // the book retires (final mark): what it could not repay is written off for good
    w.data.poolBookRows[0]!.active = false;
    const y = await w.caller.pool.exposure();
    expect(y.markets[0]).toMatchObject({ allocatedUsd: "0.000000", provisionalLossUsd: "0.000000", writtenOffUsd: "2000.000000" });
    expect(y.markets[0]!.books[0]).toMatchObject({ lossStatus: "written_off" });
  });
});

describe("pool router: prepared transactions", () => {
  const check = (w: World) => ({ chainId: 31337, targets: [POOL, w.chain.deployment.contracts.usdc], account: ALICE });

  test("deposit: [approve, requestDeposit] for the open epoch, verified like the web does", async () => {
    const w = world();
    w.chain.poolWallets.set(ALICE.toLowerCase(), { shares: 0n, value: 0n, cooldownEnds: WEEK, usdcBalance: U(10_000), usdcAllowance: 0n });
    const r = await w.caller.pool.deposit({ wallet: ALICE, amountUsd: "2500.5" });
    expect(r.epoch).toBe(3);
    const steps = verifyPreparedTxs(r.txs, { ...check(w), amount: U(2_500.5) });
    expect(steps.map((s) => s.functionName)).toEqual(["approve", "requestDeposit"]);
    expect(steps[0]!.args).toEqual([getAddress(POOL), U(2_500.5)]);
    // allowance already in place: one step
    w.chain.poolWallets.set(ALICE.toLowerCase(), { shares: 0n, value: 0n, cooldownEnds: WEEK, usdcBalance: U(10_000), usdcAllowance: U(1e6) });
    expect((await w.caller.pool.deposit({ wallet: ALICE, amountUsd: "10" })).txs).toHaveLength(1);
  });

  test("deposit refused while paused, without a pool, or for zero", async () => {
    expect(await code(world({ paused: { deposits: true, allocations: false } }).caller.pool.deposit({ wallet: ALICE, amountUsd: "10" }))).toBe("PRECONDITION_FAILED");
    const none = makeWorld();
    expect(await code(none.caller.pool.deposit({ wallet: ALICE, amountUsd: "10" }))).toBe("PRECONDITION_FAILED");
    expect(await code(world().caller.pool.deposit({ wallet: ALICE, amountUsd: "0" }))).toBe("BAD_REQUEST");
  });

  test("cancel only the owner's queued deposit, and only before its epoch ends", async () => {
    const w = world();
    w.chain.poolDepositInfo.set(5, { owner: ALICE, epoch: 3, done: false, assets: U(500) });
    const r = await w.caller.pool.cancelDeposit({ wallet: ALICE, depositId: 5 });
    expect(decodeFunctionData({ abi: insurancePoolAbi, data: r.txs[0]!.data })).toMatchObject({ functionName: "cancelDeposit", args: [5n] });
    verifyPreparedTxs(r.txs, check(w));
    expect(await code(w.caller.pool.cancelDeposit({ wallet: A(0xbad), depositId: 5 }))).toBe("FORBIDDEN");
    expect(await code(w.caller.pool.cancelDeposit({ wallet: ALICE, depositId: 99 }))).toBe("NOT_FOUND");
    // the epoch has ended (not processed yet): no cancellation
    w.chain.pool = poolState({ nowSec: END + 1 });
    expect(await code(w.caller.pool.cancelDeposit({ wallet: ALICE, depositId: 5 }))).toBe("PRECONDITION_FAILED");
  });

  test("claimDeposit once the epoch is processed; claim only what was filled", async () => {
    const w = world();
    w.chain.poolDepositInfo.set(5, { owner: ALICE, epoch: 2, done: false, assets: U(500) });
    expect(await code(w.caller.pool.claimDeposit({ wallet: ALICE, depositId: 5 }))).toBe("PRECONDITION_FAILED");
    w.chain.poolEpochInfo.set(2, { shares: 0n, filledShares: 0n, assets: 0n, depositAssets: U(1_000), depositShares: S(990), endsAt: END - WEEK, processed: true });
    const r = await w.caller.pool.claimDeposit({ wallet: ALICE, depositId: 5 });
    expect(r.txs[0]!.description).toContain("495");
    verifyPreparedTxs(r.txs, check(w));

    expect(await code(w.caller.pool.claim({ wallet: ALICE, requestId: 7 }))).toBe("PRECONDITION_FAILED");
    w.chain.poolClaimable.set(7, U(40));
    const c = await w.caller.pool.claim({ wallet: ALICE, requestId: 7 });
    expect(c.amountUsd).toBe("40.000000");
    verifyPreparedTxs(c.txs, check(w));
  });

  test("withdraw: never refused by state, but bounded by the wallet's shares; queued after the cooldown", async () => {
    const w = world({ paused: { deposits: true, allocations: true } });
    w.chain.poolWallets.set(ALICE.toLowerCase(), { shares: S(1_000), value: U(1_000), cooldownEnds: END + 10, usdcBalance: 0n, usdcAllowance: 0n });
    const r = await w.caller.pool.withdraw({ wallet: ALICE, shares: "250.5" });
    expect(r.epoch).toBe(4); // the cooldown ends after epoch 3's end
    const steps = verifyPreparedTxs(r.txs, { ...check(w), amount: 250_500_000_000_000n });
    expect(steps.map((s) => s.functionName)).toEqual(["requestWithdraw"]);
    expect(await code(w.caller.pool.withdraw({ wallet: ALICE, shares: "1000.000000000001" }))).toBe("PRECONDITION_FAILED");
    expect(await code(w.caller.pool.withdraw({ wallet: ALICE, shares: "abc" }))).toBe("BAD_REQUEST");
  });
});
