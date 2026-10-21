// InsurancePool (2026-10, docs/ARCHITECTURE.md §2.10) event handlers: deposits / withdrawals queued to epochs,
// epoch processing and fills, the per-book position (re-read at the event's block), value flows and one state
// snapshot per block (share price history). Writes are idempotent: natural ids, guarded transitions, and the
// additive totals (claims, fills, premiums) move only when their pool_flows row is new.
// Review I-3: a failed enrichment read never drops data. The event rows are written; the snapshot of that block is
// written with the previous good values and `stale`, the book position keeps its last good values marked `stale`, an
// epoch keeps a null end; backfillPool (runner, every pass) re-reads all of them until they succeed.
import type { Address, Hex } from "viem";
import type { IndexerChain, PoolStateLite } from "./chain";
import { arg, usdDb } from "./convert";
import type { DecodedLog } from "./decode";
import type { Handler, HandlerCtx } from "./handlers";
import type { IndexerStore, PoolFlowKind, PoolSnapshotRow } from "./store";

const pool = (l: DecodedLog) => l.address as Address;
const isZeroAddr = (a: string) => /^0x0{40}$/i.test(a);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

function snapshotRow(blockNumber: number, ts: Date, s: PoolStateLite): PoolSnapshotRow {
  return {
    blockNumber,
    ts,
    stale: false,
    poolAssets: usdDb(s.poolAssets),
    depositorAssets: usdDb(s.depositorAssets),
    totalSupplyRaw: s.totalSupply.toString(),
    sharePrice: usdDb(s.sharePrice),
    firstLoss: usdDb(s.firstLoss),
    freeLiquidity: usdDb(s.freeLiquidity),
    claims: usdDb(s.claims),
    utilisationBps: s.utilisationBps,
    premiumsTotal: usdDb(s.premiumsTotal),
    lossesTotal: usdDb(s.lossesTotal),
    depositsPending: usdDb(s.depositsPending),
    pendingSharesRaw: s.pendingShares.toString(),
  };
}

/** pool_snapshots row at the log's block (one read per block); a failed read writes a stale carry-forward row. */
async function snapshot({ log, ts, store, chain, logger }: HandlerCtx): Promise<void> {
  const block = Number(log.blockNumber);
  try {
    await store.upsertPoolSnapshot(snapshotRow(block, ts, await chain.poolState(pool(log), log.blockNumber)));
  } catch (err) {
    const prev = await store.poolSnapshotAtOrBefore(block);
    if (prev && prev.blockNumber === block && !prev.stale) return; // a good row of this block already exists
    logger.warn({ block, err: errText(err) }, "pool state unreadable at this block: stale row kept, backfilled later");
    const zero = usdDb(0n);
    await store.upsertPoolSnapshot(
      prev
        ? { ...prev, blockNumber: block, ts, stale: true }
        : { blockNumber: block, ts, stale: true, poolAssets: zero, depositorAssets: zero, totalSupplyRaw: "0", sharePrice: usdDb(1_000_000n), firstLoss: zero, freeLiquidity: zero, claims: zero, utilisationBps: 0, premiumsTotal: zero, lossesTotal: zero, depositsPending: zero, pendingSharesRaw: "0" },
    );
  }
}

/** Upserts the position read at `at`; false when the pool has none for the book. */
async function writePosition(store: IndexerStore, chain: IndexerChain, poolAddr: Address, bookId: number, at: bigint, allocatedAt: Date): Promise<boolean> {
  const p = await chain.poolBookPosition(poolAddr, BigInt(bookId), at);
  if (isZeroAddr(p.book)) return false;
  const prev = await store.getPoolBook(bookId);
  await store.upsertPoolBook({
    bookId,
    market: p.market.toLowerCase(),
    allocation: usdDb(p.allocation),
    claim: usdDb(p.claim),
    lossFirstLoss: usdDb(p.lossFirstLoss),
    lossDepositors: usdDb(p.lossDepositors),
    lastMarkAt: p.lastMarkAt > 0 ? new Date(p.lastMarkAt * 1000) : null,
    active: p.active,
    allocatedAt: prev?.allocatedAt ?? allocatedAt,
    stale: false,
  });
  return true;
}

/**
 * pool_books row from IInsurancePool.bookPosition at the log's block. A failed read keeps the last good row flagged
 * stale (or, on the Allocated event, writes the event's own figures, stale) for the backfill.
 */
async function position(ctx: HandlerCtx, bookId: number, allocated?: { amount: bigint; market: Hex }): Promise<void> {
  const { log, ts, store, chain, logger } = ctx;
  try {
    await writePosition(store, chain, pool(log), bookId, log.blockNumber, ts);
  } catch (err) {
    logger.warn({ bookId, block: Number(log.blockNumber), err: errText(err) }, "pool book position unreadable: last good row kept (stale), backfilled later");
    if (allocated && !(await store.getPoolBook(bookId))) {
      const a = usdDb(allocated.amount);
      await store.upsertPoolBook({ bookId, market: allocated.market.toLowerCase(), allocation: a, claim: a, lossFirstLoss: usdDb(0n), lossDepositors: usdDb(0n), lastMarkAt: ts, active: true, allocatedAt: ts, stale: true });
    } else {
      await store.markPoolBookStale(bookId);
    }
  }
}

/**
 * Review I-3 backfill, once per indexer pass (outside the range transaction): re-reads stale snapshot blocks (at their
 * own block), stale book positions (at `head`, the newest indexed block) and processed epochs without an end. Every
 * failure is logged and retried on the next pass; nothing here throws.
 */
export async function backfillPool(d: { store: IndexerStore; chain: IndexerChain; pool: Address; head: bigint; logger: HandlerCtx["logger"]; limit?: number }): Promise<{ snapshots: number; books: number; epochs: number }> {
  const out = { snapshots: 0, books: 0, epochs: 0 };
  const limit = d.limit ?? 50;
  for (const block of await d.store.stalePoolSnapshots(limit)) {
    try {
      const prev = await d.store.poolSnapshotAtOrBefore(block);
      const s = await d.chain.poolState(d.pool, BigInt(block));
      await d.store.upsertPoolSnapshot(snapshotRow(block, prev?.ts ?? new Date((await d.chain.blockTimestamp(BigInt(block))) * 1000), s));
      out.snapshots++;
    } catch (err) {
      d.logger.debug({ block, err: errText(err) }, "pool snapshot backfill failed (retrying next pass)");
    }
  }
  for (const bookId of await d.store.stalePoolBooks()) {
    try {
      if (await writePosition(d.store, d.chain, d.pool, bookId, d.head, new Date())) out.books++;
    } catch (err) {
      d.logger.debug({ bookId, err: errText(err) }, "pool book backfill failed (retrying next pass)");
    }
  }
  for (const epoch of await d.store.poolEpochsWithoutEnd(limit)) {
    try {
      const endsAt = await d.chain.poolEpochEnd(d.pool, BigInt(epoch), d.head);
      if (endsAt > 0) {
        await d.store.upsertPoolEpoch(epoch, { endsAt: new Date(endsAt * 1000) });
        out.epochs++;
      }
    } catch (err) {
      d.logger.debug({ epoch, err: errText(err) }, "pool epoch end backfill failed (retrying next pass)");
    }
  }
  return out;
}

function flow(ctx: HandlerCtx, kind: PoolFlowKind, bookId: number | null, amount: bigint, firstLossPart = 0n): Promise<boolean> {
  return ctx.store.insertPoolFlow({
    ts: ctx.ts,
    kind,
    bookId,
    amount: usdDb(amount),
    firstLossPart: usdDb(firstLossPart),
    txHash: ctx.log.txHash,
    logIndex: ctx.log.logIndex,
  });
}

// ---------------------------------------------------------------- depositors

const depositRequested: Handler = async (ctx) => {
  const { log, ts, store } = ctx;
  await store.insertPoolDeposit({
    id: arg.num(log.args, "depositId"),
    owner: arg.addr(log.args, "owner"),
    assets: usdDb(arg.big(log.args, "assets")),
    epoch: arg.num(log.args, "epoch"),
    requestedAt: ts,
    requestTx: log.txHash,
  });
  await snapshot(ctx);
};

const depositCancelled: Handler = async (ctx) => {
  const { log, ts, store } = ctx;
  await store.closePoolDeposit({ id: arg.num(log.args, "depositId"), status: "cancelled", at: ts, txHash: log.txHash });
  await snapshot(ctx);
};

// shares move from the pool's escrow to the owner: the pool's value does not change (no snapshot)
const depositClaimed: Handler = async ({ log, ts, store }) => {
  await store.closePoolDeposit({
    id: arg.num(log.args, "depositId"),
    status: "claimed",
    sharesRaw: arg.big(log.args, "shares").toString(),
    at: ts,
    txHash: log.txHash,
  });
};

const withdrawRequested: Handler = async (ctx) => {
  const { log, ts, store } = ctx;
  await store.insertPoolWithdrawal({
    id: arg.num(log.args, "requestId"),
    owner: arg.addr(log.args, "owner"),
    sharesRaw: arg.big(log.args, "shares").toString(),
    epoch: arg.num(log.args, "epoch"),
    epochEndsAt: new Date(arg.num(log.args, "epochEndsAt") * 1000),
    requestedAt: ts,
    requestTx: log.txHash,
  });
  await snapshot(ctx);
};

const claimed: Handler = async (ctx) => {
  const { log, ts, store } = ctx;
  const assets = arg.big(log.args, "assets");
  if (await flow(ctx, "withdraw_claim", null, assets)) {
    await store.addPoolWithdrawalClaim({ id: arg.num(log.args, "requestId"), assets: usdDb(assets), at: ts });
  }
  await snapshot(ctx);
};

// ---------------------------------------------------------------- epochs

const epochProcessed: Handler = async (ctx) => {
  const { log, ts, store, chain, emit } = ctx;
  const epoch = arg.num(log.args, "epoch");
  // a failed read leaves the end null: the backfill re-reads it
  const endsAt = await chain.poolEpochEnd(pool(log), BigInt(epoch), log.blockNumber).catch(() => 0);
  const stale = arg.bool(log.args, "stale");
  const depositAssets = usdDb(arg.big(log.args, "depositAssets"));
  await store.upsertPoolEpoch(epoch, {
    endsAt: endsAt > 0 ? new Date(endsAt * 1000) : null,
    processedAt: ts,
    processTx: log.txHash,
    depositAssets,
    depositSharesRaw: arg.big(log.args, "depositShares").toString(),
    stale,
  });
  await snapshot(ctx);
  await emit({ type: "pool.epoch_processed", bookId: null, dedupeKey: `pool.epoch_processed:${epoch}`, payload: { epoch, stale, depositAssets, txHash: log.txHash } });
};

const epochProcessedStale: Handler = async ({ log, store }) => {
  await store.upsertPoolEpoch(arg.num(log.args, "epoch"), { stale: true, staleBooks: arg.num(log.args, "staleBooks") });
};

const epochFilled: Handler = async (ctx) => {
  const { log, store } = ctx;
  const epoch = arg.num(log.args, "epoch");
  const assets = arg.big(log.args, "assets");
  const complete = arg.bool(log.args, "complete");
  if (await flow(ctx, "epoch_fill", null, assets)) {
    await store.upsertPoolEpoch(epoch, {
      addFilledSharesRaw: arg.big(log.args, "shares").toString(),
      addFilledAssets: usdDb(assets),
      ...(complete ? { complete: true } : {}),
    });
  } else if (complete) {
    await store.upsertPoolEpoch(epoch, { complete: true });
  }
  await snapshot(ctx);
};

// ---------------------------------------------------------------- books

const allocated: Handler = async (ctx) => {
  const bookId = arg.num(ctx.log.args, "bookId");
  await flow(ctx, "allocated", bookId, arg.big(ctx.log.args, "amount"));
  await position(ctx, bookId, { amount: arg.big(ctx.log.args, "amount"), market: arg.hex(ctx.log.args, "market") });
  await snapshot(ctx);
};

const bookMarked: Handler = async (ctx) => {
  await position(ctx, arg.num(ctx.log.args, "bookId"));
  await snapshot(ctx);
};

// The pool's loss on a book is PROVISIONAL while the book is active (its claim is restored first by later marks, review
// round 3) and final only with the book's final mark (finalizeRetirement): the event says which.
const lossReported: Handler = async (ctx) => {
  const { log, emit } = ctx;
  const bookId = arg.num(log.args, "bookId");
  const amount = arg.big(log.args, "amount");
  const fl = arg.big(log.args, "firstLossAbsorbed");
  await flow(ctx, "loss", bookId, amount, fl);
  await position(ctx, bookId);
  await snapshot(ctx);
  // the book's position after this event (read above; the last good / stale row when the read failed)
  const p = await ctx.store.getPoolBook(bookId);
  await emit({
    type: "pool.loss_reported",
    bookId,
    dedupeKey: `pool.loss_reported:${log.txHash}:${log.logIndex}`,
    payload: {
      bookId,
      amountUsd: usdDb(amount),
      firstLossAbsorbedUsd: usdDb(fl),
      depositorsAbsorbedUsd: usdDb(arg.big(log.args, "depositorsAbsorbed")),
      claimUsd: usdDb(arg.big(log.args, "claim")),
      provisional: p ? p.active : true,
      txHash: log.txHash,
    },
  });
};

const lossRecovered: Handler = async (ctx) => {
  const bookId = arg.num(ctx.log.args, "bookId");
  await flow(ctx, "recovery", bookId, arg.big(ctx.log.args, "amount"), arg.big(ctx.log.args, "firstLossRestored"));
  await position(ctx, bookId);
  await snapshot(ctx);
};

const repaid: Handler = async (ctx) => {
  const bookId = arg.num(ctx.log.args, "bookId");
  await flow(ctx, "repaid", bookId, arg.big(ctx.log.args, "amount"));
  await position(ctx, bookId);
  await snapshot(ctx);
};

const premiumReceived: Handler = async (ctx) => {
  const { log, store } = ctx;
  const bookId = arg.num(log.args, "bookId");
  const amount = arg.big(log.args, "amount");
  if (await flow(ctx, "premium", bookId, amount, arg.big(log.args, "firstLossShare"))) await store.addPoolBookPremium(bookId, usdDb(amount));
  await snapshot(ctx);
};

// ---------------------------------------------------------------- first-loss slice

const firstLossDeposited: Handler = async (ctx) => {
  const amount = arg.big(ctx.log.args, "amount");
  await flow(ctx, "first_loss_deposit", null, amount, amount);
  await snapshot(ctx);
};

const firstLossWithdrawn: Handler = async (ctx) => {
  const amount = arg.big(ctx.log.args, "amount");
  await flow(ctx, "first_loss_withdraw", null, amount, amount);
  await snapshot(ctx);
};

export const POOL_HANDLERS: Record<string, Handler> = {
  "pool.DepositRequested": depositRequested,
  "pool.DepositCancelled": depositCancelled,
  "pool.DepositClaimed": depositClaimed,
  "pool.WithdrawRequested": withdrawRequested,
  "pool.Claimed": claimed,
  "pool.EpochProcessed": epochProcessed,
  "pool.EpochProcessedStale": epochProcessedStale,
  "pool.EpochFilled": epochFilled,
  "pool.Allocated": allocated,
  "pool.BookMarked": bookMarked,
  "pool.LossReported": lossReported,
  "pool.LossRecovered": lossRecovered,
  "pool.Repaid": repaid,
  "pool.PremiumReceived": premiumReceived,
  "pool.FirstLossDeposited": firstLossDeposited,
  "pool.FirstLossWithdrawn": firstLossWithdrawn,
};
