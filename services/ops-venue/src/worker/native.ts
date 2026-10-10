// Orderly native deposit fee (VERIFY O5): Orderly's Vault charges an ETH fee per deposit when its deposit fee is
// enabled (`getDepositFee`, forwarded to the cross-chain manager, excess refunded to the depositor). OrderlyAdapter
// pays it from its own ETH and reverts `InsufficientNativeForFee` otherwise, which would block `Book.closeWindow`
// (the IF + MM deployment). This keeper watches every Subscription / Live book's adapter:
//   required = depositNativeFee(IF, ifTargetUsd) + depositNativeFee(MM, mmInventoryUsd)
//   balance < required  -> warn; with OPS_NATIVE_TOPUP_MAX_WEI > 0 also top up through adapter.fundNative()
//                          to `headroom x required` (at most the cap per top-up, at most one per book per cooldown).
import { formatEther } from "viem";
import { ACCOUNT } from "@bookrunner/shared";
import { errMsg } from "../util";
import type { OpsContext, TrackedBook } from "./context";

export interface NativeFeeSettings {
  /** Max wei per top-up (0 = warn only). */
  topUpMaxWei: bigint;
  /** Target balance = headroom x the fee for the next IF + MM deposits. */
  headroom: bigint;
  /** Minimum ms between two top-ups of the same adapter. */
  cooldownMs: number;
}

export type NativeCheck = { bookId: number; required: bigint; balance: bigint; action: "ok" | "warned" | "topped_up"; value?: bigint };

export class NativeFeeKeeper {
  private readonly lastTopUp = new Map<number, number>();

  constructor(
    private readonly ctx: OpsContext,
    private readonly s: NativeFeeSettings,
  ) {}

  async check(book: TrackedBook): Promise<NativeCheck | null> {
    if (book.state !== "Subscription" && book.state !== "Live") return null;
    const { chain, log } = this.ctx;
    const { balance, required } = await chain.nativeFeeState(book.adapter, [
      { account: ACCOUNT.IF, amount: book.ifTargetUsd },
      { account: ACCOUNT.MM, amount: book.mmInventoryUsd },
    ]);
    if (balance >= required) return { bookId: book.bookId, required, balance, action: "ok" };
    const target = required * this.s.headroom;
    const now = this.ctx.now();
    const recent = now - (this.lastTopUp.get(book.bookId) ?? -Infinity) < this.s.cooldownMs;
    if (this.s.topUpMaxWei === 0n || recent) {
      log.warn(
        { bookId: book.bookId, adapter: book.adapter, requiredEth: formatEther(required), balanceEth: formatEther(balance) },
        "adapter ETH below Orderly's deposit fee — deposits (Book.closeWindow) revert InsufficientNativeForFee until adapter.fundNative() tops it up",
      );
      return { bookId: book.bookId, required, balance, action: "warned" };
    }
    const value = target - balance < this.s.topUpMaxWei ? target - balance : this.s.topUpMaxWei;
    this.lastTopUp.set(book.bookId, now);
    const tx = await chain.fundNative(book.adapter, value);
    log.info({ bookId: book.bookId, adapter: book.adapter, addedEth: formatEther(value), requiredEth: formatEther(required), tx }, "adapter topped up for Orderly deposit fees");
    return { bookId: book.bookId, required, balance, action: "topped_up", value };
  }

  async checkAll(books: TrackedBook[]): Promise<void> {
    for (const b of books) {
      try {
        await this.check(b);
      } catch (err) {
        this.ctx.log.warn({ bookId: b.bookId, err: errMsg(err) }, "native deposit-fee check failed");
      }
    }
  }
}
