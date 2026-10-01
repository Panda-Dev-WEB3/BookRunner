import type { MarkInput } from "@bookrunner/shared";
import type { Address, Hex, LocalAccount } from "viem";
import { markDigest, recoverMarkSigner, signMark } from "../domain/sign";
import type { MarkSignerPort, ReceiptsRootPort } from "../ports";
import { type ReceiptsDeps, periodReceiptsRoot } from "@bookrunner/receipts";

/** MARK_SIGNER role key (roleAccount("markSigner")) signing EIP-712 marks for one registry. */
export class LocalMarkSigner implements MarkSignerPort {
  constructor(
    private readonly account: LocalAccount,
    private readonly chainId: number,
    private readonly registry: Address,
  ) {}

  get address(): Address {
    return this.account.address;
  }

  sign(input: MarkInput): Promise<Hex> {
    return signMark(this.account, this.chainId, this.registry, input);
  }

  recover(input: MarkInput, signature: Hex): Promise<Address> {
    return recoverMarkSigner(this.chainId, this.registry, input, signature);
  }

  digest(input: MarkInput): Hex {
    return markDigest(this.chainId, this.registry, input);
  }
}

/** receiptsRoot = periodReceiptsRoot(bookId, periodEnd - interval, periodEnd) from @bookrunner/receipts. */
export class ReceiptsRootAdapter implements ReceiptsRootPort {
  constructor(private readonly deps: Partial<ReceiptsDeps>) {}

  async periodRoot(bookId: number, periodStart: number, periodEnd: number) {
    const r = await periodReceiptsRoot(bookId, periodStart, periodEnd, this.deps);
    return { root: r.root, complete: r.complete, windows: r.windows.length, receipts: r.receiptCount };
  }
}
