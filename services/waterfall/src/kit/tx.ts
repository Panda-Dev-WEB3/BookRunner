// Serialised contract writes for one role account: simulate (eth_call) -> estimate + buffer ->
// send -> wait for the receipt. One in-flight tx per sender, so concurrent loops/workers never race
// on nonces.
import type { Logger } from "@bookrunner/shared";
import {
  type Abi,
  type Account,
  type Address,
  BaseError,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
} from "viem";

export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  /** Short label for logs, e.g. "distribute(book=1, period=...)". */
  label: string;
  /** Optional explicit gas limit (skips estimation and the buffer). */
  gas?: bigint;
  /** Attributed book (gas accounting). */
  bookId?: number;
}

export interface TxOutcome {
  hash: Hex;
  receipt: TransactionReceipt;
  result: unknown;
}

export class TxRevertedError extends Error {
  constructor(
    readonly label: string,
    readonly hash: Hex,
  ) {
    super(`${label}: transaction ${hash} reverted`);
  }
}

export interface RevertInfo {
  /** Decoded custom error / Error(string) / Panic name when the ABI knows it. */
  errorName?: string;
  reason?: string;
  args?: readonly unknown[];
  /** 4-byte selector of the revert data. */
  selector?: Hex;
  message: string;
}

/** Extracts what we can from a viem error (custom errors outside the interface ABI keep only the selector). */
export function describeRevert(err: unknown, abi: Abi = []): RevertInfo {
  if (!(err instanceof BaseError)) return { message: err instanceof Error ? err.message : String(err) };
  const withData = err.walk((e) => typeof (e as { data?: unknown }).data === "string" && String((e as { data: string }).data).startsWith("0x")) as
    | { data: Hex }
    | null;
  const info: RevertInfo = { message: err.shortMessage || err.message };
  const reasonHolder = err.walk((e) => typeof (e as { reason?: unknown }).reason === "string") as { reason?: string } | null;
  if (reasonHolder?.reason) info.reason = reasonHolder.reason;
  const data = withData?.data;
  if (data && data.length >= 10) {
    info.selector = data.slice(0, 10) as Hex;
    try {
      const d = decodeErrorResult({ abi, data });
      info.errorName = d.errorName;
      info.args = d.args as readonly unknown[] | undefined;
      if (d.errorName === "Error" && typeof d.args?.[0] === "string") info.reason = d.args[0];
    } catch {
      // unknown custom error: selector only
    }
  }
  return info;
}

/** True when an error message / reason looks like an idempotency rejection ("already ..."). */
export function looksLikeAlready(info: RevertInfo): boolean {
  return /already|distributed|applied|swept|exists|not newer|done/i.test(`${info.errorName ?? ""} ${info.reason ?? ""} ${info.message}`);
}

/**
 * Gas limit from an eth_estimateGas result: +30% + 30k. The estimate is a tight binary search at
 * the estimation block; state written between estimation and mining (funding accrual, fee
 * accounting, a first-touch SSTORE) and the 63/64 rule on nested calls make an unbuffered limit
 * run the inner call out of gas.
 */
export const bufferedGas = (estimate: bigint): bigint => (estimate * 13n) / 10n + 30_000n;

export type GasListener = (e: { label: string; bookId?: number; gasUsed: bigint; costWei: bigint; hash: Hex }) => void;

export class TxSender {
  private tail: Promise<unknown> = Promise.resolve();
  private listeners: GasListener[] = [];

  constructor(
    private readonly pc: PublicClient,
    private readonly wallet: WalletClient<Transport, Chain, Account>,
    private readonly log: Logger,
    private readonly opts: { receiptTimeoutMs?: number; confirmations?: number; pollingIntervalMs?: number } = {},
  ) {}

  get address(): Address {
    return this.wallet.account.address;
  }

  onGas(l: GasListener) {
    this.listeners.push(l);
  }

  /** eth_call from the sender; returns the decoded result or throws the revert. */
  async simulate(call: ContractCall): Promise<unknown> {
    const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args ?? [] });
    const res = await this.pc.call({ account: this.wallet.account, to: call.address, data });
    if (!res.data) return undefined;
    try {
      return decodeFunctionResult({ abi: call.abi, functionName: call.functionName, data: res.data });
    } catch {
      return undefined;
    }
  }

  /** Simulate, send and wait for a successful receipt. Serialised per sender. */
  send(call: ContractCall): Promise<TxOutcome> {
    const run = async (): Promise<TxOutcome> => {
      const result = await this.simulate(call);
      const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args ?? [] });
      const gas = call.gas ?? bufferedGas(await this.pc.estimateGas({ account: this.wallet.account, to: call.address, data }));
      const hash = await this.wallet.sendTransaction({
        account: this.wallet.account,
        chain: this.wallet.chain,
        to: call.address,
        data,
        gas,
      });
      this.log.info({ tx: call.label, hash, from: this.address }, "tx sent");
      const receipt = await this.pc.waitForTransactionReceipt({
        hash,
        timeout: this.opts.receiptTimeoutMs ?? 120_000,
        confirmations: this.opts.confirmations ?? 1,
        pollingInterval: this.opts.pollingIntervalMs ?? 500,
      });
      const costWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
      for (const l of this.listeners) l({ label: call.label, bookId: call.bookId, gasUsed: receipt.gasUsed, costWei, hash });
      if (receipt.status !== "success") {
        this.log.error({ tx: call.label, hash, block: receipt.blockNumber }, "tx reverted");
        throw new TxRevertedError(call.label, hash);
      }
      this.log.info({ tx: call.label, hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() }, "tx mined");
      return { hash, receipt, result };
    };
    const p = this.tail.then(run, run);
    this.tail = p.catch(() => undefined);
    return p;
  }
}
