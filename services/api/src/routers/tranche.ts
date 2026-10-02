import { BOOK_STATE } from "@bookrunner/shared/types";
import { dbUsd, wad } from "@bookrunner/shared/units";
import { sharesToAssets } from "@bookrunner/shared/waterfall";
import { type Address, getAddress } from "viem";
import { z } from "zod";
import type { TrancheWalletState } from "../chain/gateway";
import type { BookRow } from "../data/types";
import type { ApiDeps } from "../deps";
import { usdInput } from "../domain/charter";
import { NOTICE_TEXT, bucketOf, redeemSchedule } from "../domain/redemption";
import {
  type DepositSettlement,
  type PreparedTx,
  approveUsdcTx,
  claimAllocationTx,
  claimCancelledRefundTx,
  claimRedemptionTx,
  depositTx,
  requestRedeemTx,
} from "../domain/txs";
import { parseUsd, usdStr, wadStr } from "../format";
import { fail, publicProcedure, requireChain, router, softChain } from "../trpc";
import {
  bookIdInput,
  loadBook,
  loadCharterOf,
  markInterval,
  markView,
  trancheAddress,
  trancheInput,
  trancheKind,
  trancheLabel,
  walletInput,
} from "./common";

type TrancheName = "senior" | "junior";
const TRANCHES: TrancheName[] = ["senior", "junior"];
const nowSec = (deps: ApiDeps) => Math.floor(deps.now() / 1000);
const cap = (s: TrancheName) => (s === "senior" ? "Senior" : "Junior");

function positiveUsd(v: string | number, what: string): bigint {
  const raw = parseUsd(v);
  if (raw <= 0n) fail("BAD_REQUEST", `${what} must be above 0`);
  return raw;
}

/** Last known share price (WAD): chain book.sharePrice, else the newest mark, else 1.0. */
async function sharePriceWad(deps: ApiDeps, b: BookRow, t: TrancheName): Promise<{ wad: bigint; source: "chain" | "mark" | "initial" }> {
  const chainBook = await softChain(deps, "book.state", (g) => g.bookState(getAddress(b.bookAddr)), null);
  if (chainBook) return { wad: t === "senior" ? chainBook.seniorPriceWad : chainBook.juniorPriceWad, source: "chain" };
  const [m] = await deps.data.latestMarks([b.id]);
  const s = m ? markView(m)[t === "senior" ? "seniorSharePrice" : "juniorSharePrice"] : null;
  return s ? { wad: wad(s), source: "mark" } : { wad: 10n ** 18n, source: "initial" };
}

export const trancheRouter = router({
  /** Prepared [USDC approve, tranche.deposit] with window / per-wallet cap checks. */
  subscribe: publicProcedure
    .input(z.object({ bookId: bookIdInput, tranche: trancheInput, amountUsd: usdInput, wallet: walletInput }))
    .mutation(async ({ ctx: { deps }, input }) => {
      const b = await loadBook(deps, input.bookId);
      const { charter } = await loadCharterOf(deps, b);
      const chain = requireChain(deps);
      const amount = positiveUsd(input.amountUsd, "Amount");
      const tranche = trancheAddress(b, input.tranche);
      const now = nowSec(deps);
      const warnings: string[] = [];

      const [params, w, chainBook] = await Promise.all([
        softChain(deps, "config.params", (g) => g.params(), null),
        softChain(deps, "tranche.wallet", (g) => g.trancheWallet(tranche, input.wallet, []), null as TrancheWalletState | null),
        softChain(deps, "book.state", (g) => g.bookState(getAddress(b.bookAddr)), null),
      ]);
      const state = chainBook ? (BOOK_STATE[chainBook.state] ?? b.state) : b.state;
      const endsAt = chainBook?.subscriptionEnds ?? (b.subscriptionEnds ? Math.floor(b.subscriptionEnds.getTime() / 1000) : null);
      // A Live book takes deposits only in a top-up round, which settles at the first mark whose
      // period ends at or after the round end (never at "window close").
      const topUp = state === "Live" ? (chainBook?.topUp ?? null) : null;
      const interval = state === "Live" ? await markInterval(deps) : null;
      const settlesAt = topUp?.open && interval ? Math.ceil(topUp.endsAt / interval) * interval : null;
      const settles: DepositSettlement = state === "Subscription" ? { kind: "window" } : { kind: "topup", settlesAt };

      if (params?.newBooksPaused) fail("PRECONDITION_FAILED", "New deposits are paused by the guardian (redemptions are unaffected)");
      const open = w ? w.depositsOpen : state === "Subscription" && endsAt !== null && now < endsAt;
      if (!open) {
        const closedAt = endsAt ? new Date(endsAt * 1000).toISOString() : null;
        fail(
          "PRECONDITION_FAILED",
          state === "Subscription" && closedAt && endsAt !== null && now >= endsAt
            ? `The subscription window closed at ${closedAt}; it settles when the window is closed on-chain`
            : `Deposits are closed for ${trancheLabel(b, input.tranche)} (book is ${state}; no open window or top-up round)`,
        );
      }
      if (w?.paused) fail("PRECONDITION_FAILED", `Deposits into ${trancheLabel(b, input.tranche)} are paused (redemptions are unaffected)`);

      const committed = w ? w.committed : dbUsd.fromDb(await deps.data.committedUsd(b.id, input.tranche, input.wallet, 0));
      const capUsd = charter?.perWalletCapUsd ?? 0n;
      const sponsorExempt = !!charter && charter.sponsor.toLowerCase() === input.wallet.toLowerCase();
      if (capUsd > 0n && !sponsorExempt && committed + amount > capUsd) {
        const room = capUsd > committed ? capUsd - committed : 0n;
        fail("PRECONDITION_FAILED", `Per-wallet cap is ${usdStr(capUsd)} USDC per round: already committed ${usdStr(committed)}, at most ${usdStr(room)} more`);
      }

      const usdc = await softChain(deps, "usdc.state", (g) => g.usdcState(input.wallet, tranche), null);
      const txs: PreparedTx[] = [];
      if (!usdc || usdc.allowance < amount) {
        txs.push(approveUsdcTx(chain.chainId, chain.deployment.contracts.usdc, tranche, amount, `the ${cap(input.tranche)} tranche of book #${b.id}`));
      }
      txs.push(depositTx(chain.chainId, tranche, amount, input.wallet, trancheLabel(b, input.tranche), settles));
      if (usdc && usdc.balance < amount) warnings.push(`Wallet USDC balance ${usdStr(usdc.balance)} is below the amount`);
      if (input.tranche === "senior" && charter) {
        warnings.push(
          settles.kind === "window"
            ? `Senior allocation is capped at ${charter.seniorCapBps / 100}% of book capital; commitments above the cap are refunded pro-rata at window close`
            : `Senior is capped at ${charter.seniorCapBps / 100}% of the book: the round is accepted at the first mark at or after the round end${settlesAt ? ` (${new Date(settlesAt * 1000).toISOString()})` : ""} at that mark's share price, and Senior above the cap room is refunded pro-rata then`,
        );
      }
      if (!w) warnings.push("Chain state unavailable; window and cap checks used indexed data");

      return {
        txs,
        signer: input.wallet,
        bookId: b.id,
        tranche: input.tranche,
        amountUsd: usdStr(amount),
        window: { state, subscriptionEnds: endsAt ? new Date(endsAt * 1000).toISOString() : null, depositsOpen: open },
        cap: {
          perWalletCapUsd: usdStr(capUsd),
          committedUsd: usdStr(committed),
          remainingUsd: capUsd > 0n && !sponsorExempt ? usdStr(capUsd - committed - amount) : null,
          sponsorExempt,
        },
        totalCommittedUsd: w ? usdStr(w.totalCommitted) : null,
        warnings,
      };
    }),

  /** Prepared tranche.requestRedeem. Notice is not a gate: the request is always accepted. */
  redeem: publicProcedure
    .input(z.object({ bookId: bookIdInput, tranche: trancheInput, shares: usdInput, wallet: walletInput }))
    .mutation(async ({ ctx: { deps }, input }) => {
      const b = await loadBook(deps, input.bookId);
      const { charter } = await loadCharterOf(deps, b);
      const chain = requireChain(deps);
      const shares = positiveUsd(input.shares, "Shares");
      const tranche = trancheAddress(b, input.tranche);
      const w = await softChain(deps, "tranche.wallet", (g) => g.trancheWallet(tranche, input.wallet, []), null as TrancheWalletState | null);
      if (w && w.shares < shares) {
        fail("BAD_REQUEST", `Wallet holds ${usdStr(w.shares)} ${cap(input.tranche)} shares; claim any allocation first if shares are still in escrow`);
      }
      const interval = await markInterval(deps);
      const kind = trancheKind(input.tranche);
      const s = redeemSchedule(kind, nowSec(deps), charter?.juniorNoticeSeconds ?? 0n, interval);
      const price = await sharePriceWad(deps, b, input.tranche);
      const tx = requestRedeemTx(chain.chainId, tranche, shares, input.wallet, `${cap(input.tranche)} (book #${b.id})`);
      return {
        tx,
        txs: [tx],
        signer: input.wallet,
        bookId: b.id,
        tranche: input.tranche,
        shares: usdStr(shares),
        requestedAt: new Date(s.requestedAt * 1000).toISOString(),
        eligibleAt: new Date(s.eligibleAt * 1000).toISOString(),
        eligibleAtUnix: s.eligibleAt,
        noticeSeconds: s.noticeSeconds,
        requestId: s.requestId,
        settlesAtPeriodEnd: new Date(s.settlesAtPeriodEnd * 1000).toISOString(),
        markIntervalSeconds: interval,
        notice: { isGate: false as const, text: NOTICE_TEXT },
        indicative: {
          sharePrice: wadStr(price.wad),
          valueUsd: usdStr(sharesToAssets(shares, price.wad)),
          source: price.source,
          text: "Indicative only: the request settles at the share price of the mark that settles it",
        },
      };
    }),

  position: publicProcedure.input(z.object({ bookId: bookIdInput, wallet: walletInput })).query(async ({ ctx: { deps }, input }) => {
    const b = await loadBook(deps, input.bookId);
    const [rows, interval] = await Promise.all([deps.data.listRedemptions(b.id, input.wallet), markInterval(deps)]);
    let anyChain = false;
    const tranches = await Promise.all(
      TRANCHES.map(async (t) => {
        const addr: Address = trancheAddress(b, t);
        const mine = rows.filter((r) => r.tranche === t);
        const ids = [...new Set(mine.filter((r) => !r.claimedAt).map((r) => bucketOf(r.requestId, r.eligibleAt, interval).toString()))].map(BigInt);
        const w = await softChain(deps, "tranche.wallet", (g) => g.trancheWallet(addr, input.wallet, ids), null as TrancheWalletState | null);
        if (w) anyChain = true;
        const price = await sharePriceWad(deps, b, t);
        const byBucket = new Map((w?.buckets ?? []).map((x) => [x.requestId.toString(), x]));
        const redemptions = mine.map((r) => {
          const bucket = bucketOf(r.requestId, r.eligibleAt, interval);
          const onChain = byBucket.get(bucket.toString());
          const status = r.claimedAt
            ? "claimed"
            : onChain
              ? onChain.claimableShares > 0n
                ? "claimable"
                : onChain.pendingShares > 0n
                  ? "pending"
                  : r.honouredMarkId
                    ? "settled"
                    : "pending"
              : r.honouredMarkId
                ? "settled"
                : "pending";
          return {
            requestId: bucket.toString(),
            shares: usdStr(dbUsd.fromDb(r.shares)),
            requestedAt: r.noticeAt.toISOString(),
            eligibleAt: r.eligibleAt.toISOString(),
            settlesAtPeriodEnd: new Date(Number(bucket) * interval * 1000).toISOString(),
            honouredMarkId: r.honouredMarkId,
            assetsUsd: r.assets == null ? null : usdStr(dbUsd.fromDb(r.assets)),
            status,
            requestTx: r.requestTx,
          };
        });
        return {
          tranche: t,
          address: addr,
          shares: w ? usdStr(w.shares) : null,
          sharePrice: wadStr(price.wad),
          navValueUsd: w ? usdStr(w.navValue > 0n ? w.navValue : sharesToAssets(w.shares, price.wad)) : null,
          committedUsd: w ? usdStr(w.committed) : null,
          depositsOpen: w ? w.depositsOpen : null,
          claimableAllocation: w ? { shares: usdStr(w.claimableShares), refundUsd: usdStr(w.claimableRefund) } : null,
          claimableRedemptionUsd: w ? usdStr(w.claimableAssets) : null,
          redemptions,
          notice: NOTICE_TEXT,
        };
      }),
    );
    const sum = (k: "navValueUsd" | "claimableRedemptionUsd") =>
      tranches.every((t) => t[k] !== null) ? usdStr(tranches.reduce((a, t) => a + dbUsd.fromDb(t[k]), 0n)) : null;
    return {
      bookId: b.id,
      wallet: input.wallet,
      tranches,
      totals: { navValueUsd: sum("navValueUsd"), claimableRedemptionUsd: sum("claimableRedemptionUsd") },
      source: anyChain ? ("chain" as const) : ("db" as const),
    };
  }),

  /** Prepared claims: allocation (shares + refund), settled redemptions, cancelled-window refunds. */
  claim: publicProcedure
    .input(z.object({ bookId: bookIdInput, wallet: walletInput, tranche: trancheInput.optional() }))
    .mutation(async ({ ctx: { deps }, input }) => {
      const b = await loadBook(deps, input.bookId);
      const chain = requireChain(deps);
      const chainBook = await softChain(deps, "book.state", (g) => g.bookState(getAddress(b.bookAddr)), null);
      const cancelled = (chainBook ? BOOK_STATE[chainBook.state] : b.state) === "Cancelled";
      const txs: PreparedTx[] = [];
      const claimable: Array<{ tranche: TrancheName; allocationShares: string; refundUsd: string; redemptionUsd: string; cancelledRefundUsd: string }> = [];
      for (const t of input.tranche ? [input.tranche] : TRANCHES) {
        const addr = trancheAddress(b, t);
        const w = await softChain(deps, "tranche.wallet", (g) => g.trancheWallet(addr, input.wallet, []), null as TrancheWalletState | null);
        if (!w) fail("SERVICE_UNAVAILABLE", "Chain read failed (tranche claimables); retry shortly");
        const label = `${cap(t)} (book #${b.id})`;
        const cancelledRefund = cancelled ? w.committed : 0n;
        if (cancelledRefund > 0n) txs.push(claimCancelledRefundTx(chain.chainId, addr, input.wallet, label));
        else if (w.claimableShares > 0n || w.claimableRefund > 0n) txs.push(claimAllocationTx(chain.chainId, addr, input.wallet, label));
        if (w.claimableAssets > 0n) txs.push(claimRedemptionTx(chain.chainId, addr, input.wallet, label));
        claimable.push({
          tranche: t,
          allocationShares: usdStr(cancelledRefund > 0n ? 0n : w.claimableShares),
          refundUsd: usdStr(cancelledRefund > 0n ? 0n : w.claimableRefund),
          redemptionUsd: usdStr(w.claimableAssets),
          cancelledRefundUsd: usdStr(cancelledRefund),
        });
      }
      return {
        txs,
        signer: input.wallet,
        bookId: b.id,
        claimable,
        message: txs.length ? `${txs.length} claim transaction(s) prepared` : "Nothing to claim right now",
      };
    }),
});
