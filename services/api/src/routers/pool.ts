// Insurance pool (2026-10, docs/ARCHITECTURE.md §2.10): protocol-wide pool that funds the insurance fund of every
// pool-funded book. Reads: overview (live views, the newest indexed snapshot when the chain is unreachable), a
// wallet's position (indexed requests + live claimable / epoch state), processed epochs, share price history and
// per-market exposure. Mutations return prepared transactions: queue a deposit, cancel it (before its epoch ends),
// collect its shares, queue a withdrawal (never refused), collect what an epoch filled.
import { isTokenUnderlying, underlyingToToken } from "@bookrunner/shared/bytes32";
import { dbUsd } from "@bookrunner/shared/units";
import { type Address, type Hex, getAddress } from "viem";
import { z } from "zod";
import type { PoolChainState, PoolWalletState } from "../chain/gateway";
import type { PoolBookRow, PoolSnapshotRow } from "../data/types";
import type { ApiDeps } from "../deps";
import { usdInput } from "../domain/charter";
import {
  type ChainEpoch,
  depositStatus,
  openEpochFor,
  parseShares,
  projectedEpochEnd,
  effectiveQueue,
  queueStatus,
  sharesStr,
  withdrawalStatus,
} from "../domain/pool";
import {
  type PreparedTx,
  approveUsdcTx,
  poolCancelDepositTx,
  poolClaimDepositTx,
  poolClaimTx,
  poolRequestDepositTx,
  poolRequestWithdrawTx,
} from "../domain/txs";
import { dbUsdStr, iso, parseUsd, usdStr } from "../format";
import { fail, hardChain, publicProcedure, requireChain, router, softChain } from "../trpc";
import { intLike, limitInput, stockTokens, walletInput } from "./common";

const BPS = 10_000n;

/** 604800 -> "7 d", 3600 -> "1 h", 90 -> "90 s" (review m-5: a 1 h demo cooldown is not "0 d"). */
export function durText(sec: number): string {
  if (sec >= 86_400 && sec % 86_400 === 0) return `${sec / 86_400} d`;
  if (sec >= 3_600 && sec % 3_600 === 0) return `${sec / 3_600} h`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}
const isoSec = (s: number) => new Date(s * 1000).toISOString();
const usdOf = (v: string | null | undefined) => dbUsdStr(v) ?? "0.000000";

/** The pool of the deployment or PRECONDITION_FAILED (no pool, or the chain read failed). */
async function requirePool(deps: ApiDeps): Promise<PoolChainState> {
  const s = await hardChain(deps, "pool.state", (g) => g.poolState());
  if (!s) fail("PRECONDITION_FAILED", "This deployment has no insurance pool");
  return s;
}

async function requireWallet(deps: ApiDeps, wallet: Address, q: { requestIds: number[]; depositIds: number[]; epochs: number[] }): Promise<PoolWalletState> {
  const w = await hardChain(deps, "pool.wallet", (g) => g.poolWallet(wallet, q));
  if (!w) fail("PRECONDITION_FAILED", "This deployment has no insurance pool");
  return w;
}

function paramsView(s: PoolChainState) {
  const p = s.params;
  return {
    premiumFloorBps: p.premiumFloorBps,
    marketCapBps: p.marketCapBps,
    bufferBps: p.bufferBps,
    firstLossTargetBps: p.firstLossTargetBps,
    cooldownSeconds: p.cooldown,
    epochLengthSeconds: p.epochLength,
    processGraceSeconds: p.processGrace,
    pendingEpochLengthSeconds: p.pendingEpochLength || null,
  };
}

function liveOverview(s: PoolChainState) {
  const qs = queueStatus(s);
  const q = effectiveQueue(s, s.nowSec);
  return {
    available: true as const,
    live: true,
    address: s.address,
    asOf: isoSec(s.nowSec),
    poolAssetsUsd: usdStr(s.poolAssets),
    depositorAssetsUsd: usdStr(s.depositorAssets),
    firstLossUsd: usdStr(s.firstLoss),
    firstLossBps: s.firstLossBps,
    freeLiquidityUsd: usdStr(s.freeLiquidity),
    /** the books' claims at their last marks (what they can repay), not the allocation (review m-8) */
    repayableUsd: usdStr(s.claims),
    utilisationBps: s.utilisationBps,
    sharePriceUsd: usdStr(s.sharePrice),
    totalShares: sharesStr(s.totalSupply),
    premiumsTotalUsd: usdStr(s.premiumsTotal),
    lossesTotalUsd: usdStr(s.lossesTotal),
    depositsQueuedUsd: usdStr(s.depositsPending),
    withdrawSharesQueued: sharesStr(s.queue.pendingShares),
    reservedForClaimsUsd: usdStr(s.queue.reserved),
    activeBooks: s.activeBooks.length,
    paused: s.paused,
    params: paramsView(s),
    queue: {
      epoch: qs.epoch,
      endsAt: isoSec(qs.endsAt),
      ended: qs.ended,
      phase: qs.phase,
      hasWork: qs.hasWork,
      staleBooks: qs.staleBooks,
      graceEndsAt: isoSec(qs.graceEndsAt),
      depositsUsd: usdStr(qs.depositAssets),
      withdrawShares: sharesStr(qs.withdrawShares),
      nextEpochEndsAt: isoSec(projectedEpochEnd(q, qs.epoch + 1)),
    },
  };
}

function snapshotOverview(r: PoolSnapshotRow | null) {
  return {
    available: r !== null,
    live: false as const,
    address: null,
    asOf: iso(r?.ts),
    poolAssetsUsd: usdOf(r?.poolAssets),
    depositorAssetsUsd: usdOf(r?.depositorAssets),
    firstLossUsd: usdOf(r?.firstLoss),
    firstLossBps: r && dbUsd.fromDb(r.poolAssets) > 0n ? Number((dbUsd.fromDb(r.firstLoss) * BPS) / dbUsd.fromDb(r.poolAssets)) : 0,
    freeLiquidityUsd: usdOf(r?.freeLiquidity),
    repayableUsd: usdOf(r?.claims),
    utilisationBps: r?.utilisationBps ?? 0,
    sharePriceUsd: usdOf(r?.sharePrice ?? "1"),
    totalShares: sharesStr(BigInt(r?.totalSupplyRaw ?? "0")),
    premiumsTotalUsd: usdOf(r?.premiumsTotal),
    lossesTotalUsd: usdOf(r?.lossesTotal),
    depositsQueuedUsd: usdOf(r?.depositsPending),
    withdrawSharesQueued: sharesStr(BigInt(r?.pendingSharesRaw ?? "0")),
    reservedForClaimsUsd: null,
    activeBooks: null,
    paused: null,
    params: null,
    queue: null,
  };
}

/** Market label: the Stock Token's ticker, else the symbol / name of a book on that underlying, else the hex. */
function marketLabel(deps: ApiDeps, market: string, books: Array<{ underlying: string; symbol: string; name: string | null }>): string {
  const m = market.toLowerCase() as Hex;
  if (isTokenUnderlying(m)) {
    try {
      const token = underlyingToToken(m).toLowerCase();
      const t = Object.entries(stockTokens(deps)).find(([, v]) => v.token.toLowerCase() === token)?.[0];
      if (t) return t;
    } catch {
      // not an address: fall through
    }
  }
  const b = books.find((x) => x.underlying.toLowerCase() === m);
  return b ? (b.name ?? b.symbol) : `${m.slice(0, 10)}…`;
}

function exposureView(deps: ApiDeps, rows: PoolBookRow[], books: Array<{ id: number; underlying: string; symbol: string; name: string | null }>, poolAssets: bigint | null, marketCapBps: number | null) {
  const byMarket = new Map<string, PoolBookRow[]>();
  for (const r of rows) byMarket.set(r.market, [...(byMarket.get(r.market) ?? []), r]);
  const cap = poolAssets !== null && marketCapBps !== null ? (poolAssets * BigInt(marketCapBps)) / BPS : null;
  const markets = [...byMarket.entries()].map(([market, rs]) => {
    const active = rs.filter((r) => r.active);
    const allocated = active.reduce((a, r) => a + dbUsd.fromDb(r.allocation), 0n);
    // review round 3: while a book is active the pool's loss on it is PROVISIONAL (later marks restore the claim
    // first); it is final (written off) only with the book's final mark at retirement (the position turns inactive)
    const provisional = active.reduce((a, r) => a + lossOf(r), 0n);
    const writtenOff = rs.filter((r) => !r.active).reduce((a, r) => a + lossOf(r), 0n);
    return {
      market,
      label: marketLabel(deps, market, books),
      allocatedUsd: usdStr(allocated),
      /** active books: the claim marked below the debt (the book exhausted at its last mark); recovered first, not final */
      provisionalLossUsd: usdStr(provisional),
      /** retired books: what their final mark could not repay, the pool's loss for good */
      writtenOffUsd: usdStr(writtenOff),
      capUsd: cap === null ? null : usdStr(cap),
      capUsedBps: cap === null || cap === 0n ? null : Number((allocated * BPS) / cap),
      shareOfPoolBps: poolAssets === null || poolAssets === 0n ? null : Number((allocated * BPS) / poolAssets),
      books: rs.map((r) => {
        const b = books.find((x) => x.id === r.bookId);
        return {
          bookId: r.bookId,
          symbol: b?.symbol ?? null,
          name: b?.name ?? null,
          active: r.active,
          allocationUsd: usdOf(r.allocation),
          claimUsd: usdOf(r.claim),
          lossFirstLossUsd: usdOf(r.lossFirstLoss),
          lossDepositorsUsd: usdOf(r.lossDepositors),
          /** allocation - claim: provisional while active, written off once retired */
          lossUsd: usdStr(lossOf(r)),
          lossStatus: lossOf(r) === 0n ? ("none" as const) : r.active ? ("provisional" as const) : ("written_off" as const),
          premiumsUsd: usdOf(r.premiumsUsd),
          lastMarkAt: iso(r.lastMarkAt),
          /** the last read failed: last good values until the indexer re-reads */
          stale: r.stale,
        };
      }),
    };
  });
  markets.sort((a, b) => (dbUsd.fromDb(b.allocatedUsd) > dbUsd.fromDb(a.allocatedUsd) ? 1 : -1));
  return { markets, marketCapBps, capUsd: cap === null ? null : usdStr(cap) };
}

/** The pool's loss on a book position: allocation - claim (0 when fully repayable). */
function lossOf(r: PoolBookRow): bigint {
  const d = dbUsd.fromDb(r.allocation) - dbUsd.fromDb(r.claim);
  return d > 0n ? d : 0n;
}

/** At most this many open deposits / unsettled withdrawals are read live per position call (review m-2). */
const LIVE_READS = 50;

const depositIdInput = intLike(1);
const requestIdInput = intLike(1);

export const poolRouter = router({
  /** Pool totals, parameters and the queue (live; the newest indexed snapshot while the chain is unreachable). */
  overview: publicProcedure.query(async ({ ctx: { deps } }) => {
    const live = await softChain(deps, "pool.state", (g) => g.poolState(), null);
    if (live) return liveOverview(live);
    if (deps.chain() && !deps.chain()?.deployment.contracts.insurancePool) return snapshotOverview(null);
    return snapshotOverview(await deps.data.latestPoolSnapshot());
  }),

  /** A wallet's shares, value, cooldown, deposit requests and withdrawal requests. */
  position: publicProcedure.input(z.object({ wallet: walletInput })).query(async ({ ctx: { deps }, input }) => {
    const [deps_, wds] = await Promise.all([deps.data.poolDeposits(input.wallet), deps.data.poolWithdrawals(input.wallet)]);
    // review m-2 (public, uncached endpoint): live reads only for what can still change, at most LIVE_READS of each.
    // A withdrawal whose epoch filled completely and that claimed all it was entitled to (indexed) is settled.
    const dbEpochs = new Map((await deps.data.poolEpochsIn([...new Set(wds.map((w) => w.epoch))])).map((e) => [e.epoch, e]));
    const settled = (r: (typeof wds)[number]) => {
      const e = dbEpochs.get(r.epoch);
      if (!e?.complete || BigInt(e.filledSharesRaw) === 0n) return false;
      const entitled = (BigInt(r.sharesRaw) * dbUsd.fromDb(e.filledAssets)) / BigInt(e.filledSharesRaw);
      return dbUsd.fromDb(r.claimedAssets) >= entitled;
    };
    const open = deps_.filter((d) => d.status === "queued").slice(0, LIVE_READS);
    const unclaimed = wds.filter((r) => !settled(r)).slice(0, LIVE_READS);
    const epochs = [...new Set([...open.map((d) => d.epoch), ...unclaimed.map((r) => r.epoch)])];
    const [state, w] = await Promise.all([
      softChain(deps, "pool.state", (g) => g.poolState(), null),
      softChain(deps, "pool.wallet", (g) => g.poolWallet(input.wallet, { requestIds: unclaimed.map((r) => r.id), depositIds: open.map((d) => d.id), epochs }), null),
    ]);
    const nowSec = state?.nowSec ?? Math.floor(deps.now() / 1000);
    const q = state ? effectiveQueue(state, nowSec) : null;
    // live epoch when read; else a completely filled indexed epoch (settled requests are not read live)
    const epochOf = (e: number): ChainEpoch | null => {
      const live = w?.epochs.get(e);
      if (live) return live;
      const x = dbEpochs.get(e);
      if (!x?.complete) return null;
      const filled = BigInt(x.filledSharesRaw);
      const endsAt = x.endsAt ? Math.floor(x.endsAt.getTime() / 1000) : 0;
      return { shares: filled, filledShares: filled, assets: dbUsd.fromDb(x.filledAssets), depositAssets: dbUsd.fromDb(x.depositAssets), depositShares: BigInt(x.depositSharesRaw), endsAt, processed: true };
    };
    const endOf = (e: number, fallback: Date | null) => {
      const ep = epochOf(e);
      if (ep?.processed) return ep.endsAt;
      if (q && e >= q.procEpoch) return projectedEpochEnd(q, e);
      return fallback ? Math.floor(fallback.getTime() / 1000) : null;
    };
    const deposits = deps_.map((d) => {
      const assets = dbUsd.fromDb(d.assets);
      const chainD = w?.deposits.get(d.id);
      const ep = epochOf(d.epoch);
      const { status, shares } = depositStatus({ done: chainD?.done ?? d.status !== "queued", dbStatus: d.status, assets }, ep);
      const endsAt = endOf(d.epoch, null);
      return {
        depositId: d.id,
        epoch: d.epoch,
        epochEndsAt: endsAt === null ? null : isoSec(endsAt),
        assetsUsd: usdStr(assets),
        status,
        /** shares ready to collect (status ready) */
        shares: shares === null ? null : sharesStr(shares),
        /** cancellable until the epoch ends (InsurancePool.cancelDeposit: EpochEnded after it) */
        cancellable: status === "queued" && endsAt !== null && nowSec < endsAt,
        requestedAt: d.requestedAt.toISOString(),
        requestTx: d.requestTx,
      };
    });
    const withdrawals = wds.map((r) => {
      const shares = BigInt(r.sharesRaw);
      const claimed = dbUsd.fromDb(r.claimedAssets);
      const ep = epochOf(r.epoch);
      const st = withdrawalStatus(shares, claimed, ep);
      const claimable = w?.claimable.get(r.id) ?? (st.entitled > claimed ? st.entitled - claimed : 0n);
      const endsAt = endOf(r.epoch, r.epochEndsAt);
      return {
        requestId: r.id,
        epoch: r.epoch,
        epochEndsAt: endsAt === null ? null : isoSec(endsAt),
        shares: sharesStr(shares),
        filledShares: sharesStr(st.filledShares),
        status: claimable > 0n && st.status === "claimed" ? ("filled" as const) : st.status,
        /** USDC this request's shares fetched at the epoch's processing (pro-rata, so far) */
        filledUsd: usdStr(st.entitled),
        claimedUsd: usdStr(claimed),
        claimableUsd: usdStr(claimable),
        requestedAt: r.requestedAt.toISOString(),
        requestTx: r.requestTx,
      };
    });
    return {
      wallet: input.wallet,
      live: w !== null,
      shares: w ? sharesStr(w.shares) : null,
      valueUsd: w ? usdStr(w.value) : null,
      cooldownEnds: w && w.cooldownEnds > (state?.params.cooldown ?? 0) ? isoSec(w.cooldownEnds) : null,
      inCooldown: w ? nowSec < w.cooldownEnds : null,
      usdcBalance: w ? usdStr(w.usdcBalance) : null,
      deposits,
      withdrawals,
    };
  }),

  /** Processed epochs, newest first (cursor = the oldest epoch of the previous page). */
  epochs: publicProcedure
    .input(z.object({ limit: limitInput(20, 100), cursor: intLike(0).optional() }).default({ limit: 20 }))
    .query(async ({ ctx: { deps }, input }) => {
      const rows = await deps.data.poolEpochs({ limit: input.limit, beforeEpoch: input.cursor });
      const items = rows.map((e) => ({
        epoch: e.epoch,
        endsAt: iso(e.endsAt),
        processedAt: iso(e.processedAt),
        processTx: e.processTx,
        depositsUsd: usdOf(e.depositAssets),
        depositShares: sharesStr(BigInt(e.depositSharesRaw)),
        withdrawShares: sharesStr(BigInt(e.filledSharesRaw)),
        withdrawUsd: usdOf(e.filledAssets),
        complete: e.complete,
        /** processed after the grace with books not marked since its end */
        stale: e.stale,
        staleBooks: e.staleBooks,
      }));
      const last = items[items.length - 1];
      return { items, nextCursor: items.length === input.limit && last ? last.epoch : null };
    }),

  /** Share price and pool value over time, with premiums / losses per day (observed accrual, never a forecast). */
  history: publicProcedure.input(z.object({ days: intLike(1, 730).default(90) }).default({ days: 90 })).query(async ({ ctx: { deps }, input }) => {
    const to = new Date(deps.now());
    const from = new Date(to.getTime() - input.days * 86_400_000);
    const [snaps, days, before] = await Promise.all([deps.data.poolSnapshots(from, to, 1000), deps.data.poolFlowDays(from), deps.data.poolSnapshots(new Date(0), from, 1)]);
    const points = snaps.map((s) => ({
      ts: s.ts.toISOString(),
      sharePriceUsd: usdOf(s.sharePrice),
      poolAssetsUsd: usdOf(s.poolAssets),
      depositorAssetsUsd: usdOf(s.depositorAssets),
      firstLossUsd: usdOf(s.firstLoss),
      repayableUsd: usdOf(s.claims),
      utilisationBps: s.utilisationBps,
      /** the indexer could not read this block yet: the previous point's values (backfilled later) */
      stale: s.stale,
    }));
    // observed change of the share price over the window (from the last point before it when there is one)
    const start = before[0] ?? snaps[0];
    const end = snaps[snaps.length - 1];
    const startPrice = start ? dbUsd.fromDb(start.sharePrice) : null;
    const endPrice = end ? dbUsd.fromDb(end.sharePrice) : null;
    return {
      days: input.days,
      points,
      flows: days.map((d) => ({ day: d.day.toISOString().slice(0, 10), premiumUsd: usdOf(d.premiumUsd), lossUsd: usdOf(d.lossUsd), recoveryUsd: usdOf(d.recoveryUsd) })),
      sharePriceChange:
        startPrice !== null && endPrice !== null && startPrice > 0n && start && end
          ? { from: start.ts.toISOString(), to: end.ts.toISOString(), startUsd: usdStr(startPrice), endUsd: usdStr(endPrice), changeBps: Number(((endPrice - startPrice) * BPS) / startPrice) }
          : null,
    };
  }),

  /** Allocations per market (underlying) against the per-market cap, with each book's position. */
  exposure: publicProcedure.query(async ({ ctx: { deps } }) => {
    const [rows, books, state] = await Promise.all([deps.data.poolBooks(), deps.data.listBooks(), softChain(deps, "pool.state", (g) => g.poolState(), null)]);
    const snap = state ? null : await deps.data.latestPoolSnapshot();
    const poolAssets = state ? state.poolAssets : snap ? dbUsd.fromDb(snap.poolAssets) : null;
    return exposureView(deps, rows, books, poolAssets, state ? state.params.marketCapBps : null);
  }),

  /** Prepared [USDC approve, requestDeposit]: queued for the open epoch, priced when it is processed. */
  deposit: publicProcedure.input(z.object({ wallet: walletInput, amountUsd: usdInput })).mutation(async ({ ctx: { deps }, input }) => {
    const chain = requireChain(deps);
    const amount = parseUsd(input.amountUsd);
    if (amount <= 0n) fail("BAD_REQUEST", "Amount must be above 0");
    const s = await requirePool(deps);
    if (s.paused.deposits) fail("PRECONDITION_FAILED", "New deposits into the insurance pool are paused by the guardian (withdrawals and claims are unaffected)");
    const w = await requireWallet(deps, input.wallet, { requestIds: [], depositIds: [], epochs: [] });
    const { epoch, endsAt } = openEpochFor(s, s.nowSec, s.nowSec + 1);
    const txs: PreparedTx[] = [];
    if (w.usdcAllowance < amount) txs.push(approveUsdcTx(chain.chainId, chain.deployment.contracts.usdc, s.address, amount, "the insurance pool"));
    txs.push(poolRequestDepositTx(chain.chainId, s.address, amount, epoch, endsAt));
    const warnings: string[] = [];
    if (w.usdcBalance < amount) warnings.push(`Wallet USDC balance ${usdStr(w.usdcBalance)} is below the amount`);
    warnings.push(
      `Shares are minted at the share price of epoch ${epoch}'s processing: after its end (${isoSec(endsAt)}), once every pool-funded book has marked after it, or ${durText(s.params.processGrace)} after the end at the latest`,
    );
    warnings.push(`Collected shares stay in this wallet for the cooldown (${durText(s.params.cooldown)} from the epoch's end); a withdrawal request then queues to the first epoch after it`);
    return { txs, warnings, epoch, epochEndsAt: isoSec(endsAt) };
  }),

  /** Prepared cancelDeposit: refunds a queued deposit before its epoch ends. */
  cancelDeposit: publicProcedure.input(z.object({ wallet: walletInput, depositId: depositIdInput })).mutation(async ({ ctx: { deps }, input }) => {
    const chain = requireChain(deps);
    const s = await requirePool(deps);
    const probe = await requireWallet(deps, input.wallet, { requestIds: [], depositIds: [input.depositId], epochs: [] });
    const d = probe.deposits.get(input.depositId);
    if (!d || d.assets === 0n) fail("NOT_FOUND", `deposit #${input.depositId} not found`);
    if (getAddress(d.owner) !== getAddress(input.wallet)) fail("FORBIDDEN", `deposit #${input.depositId} belongs to another wallet`);
    if (d.done) fail("PRECONDITION_FAILED", `deposit #${input.depositId} was already collected or cancelled`);
    const w = await requireWallet(deps, input.wallet, { requestIds: [], depositIds: [], epochs: [d.epoch] });
    const ep = w.epochs.get(d.epoch);
    if (ep?.processed) fail("PRECONDITION_FAILED", `epoch ${d.epoch} was processed: collect the shares instead`);
    const endsAt = projectedEpochEnd(effectiveQueue(s, s.nowSec), d.epoch);
    if (s.nowSec >= endsAt) fail("PRECONDITION_FAILED", `epoch ${d.epoch} ended at ${isoSec(endsAt)}: the deposit is priced when the epoch is processed`);
    return { txs: [poolCancelDepositTx(chain.chainId, s.address, input.depositId, d.assets)], warnings: [] as string[] };
  }),

  /** Prepared claimDeposit: transfers a processed deposit's shares (starts the cooldown). */
  claimDeposit: publicProcedure.input(z.object({ wallet: walletInput, depositId: depositIdInput })).mutation(async ({ ctx: { deps }, input }) => {
    const chain = requireChain(deps);
    const s = await requirePool(deps);
    const probe = await requireWallet(deps, input.wallet, { requestIds: [], depositIds: [input.depositId], epochs: [] });
    const d = probe.deposits.get(input.depositId);
    if (!d || d.assets === 0n) fail("NOT_FOUND", `deposit #${input.depositId} not found`);
    if (d.done) fail("PRECONDITION_FAILED", `deposit #${input.depositId} was already collected or cancelled`);
    const w = await requireWallet(deps, input.wallet, { requestIds: [], depositIds: [], epochs: [d.epoch] });
    const ep = w.epochs.get(d.epoch) ?? null;
    const st = depositStatus({ done: d.done, dbStatus: "queued", assets: d.assets }, ep);
    if (st.status !== "ready" || st.shares === null) fail("PRECONDITION_FAILED", `epoch ${d.epoch} is not processed yet: the shares are minted at its processing`);
    const warnings = getAddress(d.owner) !== getAddress(input.wallet) ? [`The shares go to the deposit's owner ${getAddress(d.owner)}, not this wallet`] : [];
    return { txs: [poolClaimDepositTx(chain.chainId, s.address, input.depositId, st.shares)], warnings };
  }),

  /** Prepared requestWithdraw (never refused): queued for the first epoch ending after now and after the cooldown. */
  withdraw: publicProcedure.input(z.object({ wallet: walletInput, shares: z.string().max(40) })).mutation(async ({ ctx: { deps }, input }) => {
    const chain = requireChain(deps);
    const shares = parseShares(input.shares);
    if (shares === null) fail("BAD_REQUEST", "Shares must be a positive amount with at most 12 decimals");
    const s = await requirePool(deps);
    const w = await requireWallet(deps, input.wallet, { requestIds: [], depositIds: [], epochs: [] });
    if (shares > w.shares) fail("PRECONDITION_FAILED", `This wallet holds ${sharesStr(w.shares)} pool shares (collect processed deposits first)`);
    const { epoch, endsAt } = openEpochFor(s, s.nowSec, Math.max(s.nowSec + 1, w.cooldownEnds));
    const warnings = [
      `Queued for epoch ${epoch} (ends ${isoSec(endsAt)}): the shares are priced when that epoch is processed, so a loss marked before then is shared`,
      "If free liquidity is short the epoch fills partially and the rest stays queued for the next processing; the request is never refused",
    ];
    if (w.cooldownEnds > s.nowSec) warnings.push(`This wallet's cooldown runs until ${isoSec(w.cooldownEnds)}: the request queues to the first epoch ending after it`);
    return { txs: [poolRequestWithdrawTx(chain.chainId, s.address, shares, epoch, endsAt)], warnings, epoch, epochEndsAt: isoSec(endsAt) };
  }),

  /** Prepared claim: pays what the request's epoch has filled so far. */
  claim: publicProcedure.input(z.object({ wallet: walletInput, requestId: requestIdInput })).mutation(async ({ ctx: { deps }, input }) => {
    const chain = requireChain(deps);
    const s = await requirePool(deps);
    const w = await requireWallet(deps, input.wallet, { requestIds: [input.requestId], depositIds: [], epochs: [] });
    const amount = w.claimable.get(input.requestId) ?? 0n;
    if (amount === 0n) fail("PRECONDITION_FAILED", `withdrawal #${input.requestId} has nothing to collect yet (its epoch is not processed, or not filled further)`);
    return { txs: [poolClaimTx(chain.chainId, s.address, input.requestId, amount)], warnings: [] as string[], amountUsd: usdStr(amount) };
  }),
});
