// AttestedOracle.settlePrice reads for the mark (Task 7 settle path; review I-2). An oracle WITHOUT the settle path
// (deployed before Task 7) has no settle price: detected once from its bytecode (the dispatcher's selector). On an
// oracle WITH it, a failed read is never "no settle price": that would value a settled price id at its held price and
// sign a held mark that disagrees with the chain. The read is retried with backoff (on top of the transport's own
// retries); if it still fails the mark attempt is refused with a RetryableMarkError (nothing signed, the mark job
// retries with its exponential backoff).
import { attestedOracleAbi } from "@bookrunner/shared/abi";
import { codeHasSelector, sleep } from "@bookrunner/waterfall";
import { type Address, type Hex, type PublicClient, toFunctionSelector } from "viem";
import type { SettleState } from "../domain/settle";
import { RetryableMarkError } from "../errors";

export const SETTLE_PRICE_SELECTOR = toFunctionSelector("settlePrice(bytes32)");

export interface SettleReadOptions {
  /** attempts per read (default 3) */
  attempts?: number;
  /** first backoff (ms, doubled per attempt; default 250) */
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class SettlePriceReader {
  private supported: boolean | null = null;

  constructor(
    private readonly pc: Pick<PublicClient, "readContract" | "getCode" | "getStorageAt">,
    private readonly oracle: Address,
    private readonly o: SettleReadOptions = {},
  ) {}

  /** The settle state at `blockNumber`; null only when the oracle has no settle path. Throws RetryableMarkError. */
  async read(priceId: Hex, blockNumber: bigint): Promise<SettleState | null> {
    if (this.supported === null) {
      this.supported = await this.retry("AttestedOracle settle-path probe", () => codeHasSelector(this.pc, this.oracle, SETTLE_PRICE_SELECTOR));
    }
    if (!this.supported) return null;
    const [priceWad, proposedAt, effectiveAt, pending, effective] = await this.retry(`AttestedOracle.settlePrice(${priceId})`, () =>
      this.pc.readContract({ address: this.oracle, abi: attestedOracleAbi, functionName: "settlePrice", args: [priceId], blockNumber }),
    );
    return { priceWad, proposedAt: BigInt(proposedAt), effectiveAt: BigInt(effectiveAt), pending, effective };
  }

  private async retry<T>(what: string, fn: () => Promise<T>): Promise<T> {
    const attempts = Math.max(1, this.o.attempts ?? 3);
    const base = this.o.baseMs ?? 250;
    const wait = this.o.sleep ?? ((ms: number) => sleep(ms));
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        last = err;
        if (i + 1 < attempts) await wait(base * 2 ** i);
      }
    }
    const msg = last instanceof Error ? last.message.split("\n")[0] : String(last);
    throw new RetryableMarkError(`${what} failed after ${attempts} attempts; refusing the mark (a settle-price read failure never values at the held price): ${msg}`);
  }
}
