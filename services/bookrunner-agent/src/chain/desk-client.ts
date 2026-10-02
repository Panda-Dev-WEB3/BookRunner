// Desk session-key transactions: direct txs signed by the book's desk key (devnet / no bundler).
// With a price-data provider (pull oracle, docs/LOW_GAS.md §1) every action that needs prices goes out as
// `executeWithPrices(action, priceData)` carrying the freshest signed bundle (the desk calls
// AttestedOracle.update first); without one — or when nothing signed is available — as plain
// `execute(action)`. Serialized through one lock so the quote loop (SetQuote) and the hedge loop
// (Hedge/FundDesk/Flatten) never race on the key's nonce. Each tx is simulated first (decoded
// mandate / oracle errors), then sent with a buffered gas limit, and the receipt awaited.

import type { Logger } from "@bookrunner/shared";
import { bookrunnerDeskAbi, mMMandateAbi, poolEngineAbi, underwritingVaultAbi } from "@bookrunner/shared/abi";
import type { Abi, Account, Address, Chain, Hex, PublicClient, TransactionReceipt, Transport, WalletClient } from "viem";
import { SerialLock, errMsg, revertName } from "../util";
import { DESK_ACTION_NAME, type DeskAction } from "./desk-actions";
import { ORACLE_ERRORS, mergeAbi } from "./lowgas-abi";
import type { DeskPriceData } from "./pull-prices";
import type { DeskExecutor } from "../venues/engine";

type MandateError = Extract<(typeof mMMandateAbi)[number], { type: "error" }>;
type EngineError = Extract<(typeof poolEngineAbi)[number], { type: "error" }>;
type VaultError = Extract<(typeof underwritingVaultAbi)[number], { type: "error" }>;

/** Desk ABI + the mandate/engine/vault custom errors that bubble up through execute(). */
export const DESK_ABI_WITH_ERRORS = [
  ...bookrunnerDeskAbi,
  ...mMMandateAbi.filter((x): x is MandateError => x.type === "error"),
  ...poolEngineAbi.filter((x): x is EngineError => (x as { type: string }).type === "error"),
  // FundDesk -> vault.fundDesk reverts InsufficientIdle(requested, available)
  ...underwritingVaultAbi.filter((x): x is VaultError => (x as { type: string }).type === "error"),
] as const;

/**
 * DESK_ABI_WITH_ERRORS (the generated desk ABI carries execute + executeWithPrices) + the AttestedOracle
 * errors an in-tx update can revert with.
 */
export const DESK_PULL_ABI: Abi = mergeAbi(DESK_ABI_WITH_ERRORS as unknown as Abi, ORACLE_ERRORS as unknown as Abi) as Abi;

/**
 * AttestedOracle.update reverts that condemn the carried price data itself, not the action: signer
 * rotated / not registered (BadSigner), signer clock ahead of the chain (FuturePrice), a malformed entry
 * (ZeroPrice, InsufficientSources) or bundle (LengthMismatch). The action is then retried once as plain
 * execute() against the stored prices. Mandate / staleness rejections are never retried that way (that
 * would act on an older price than the one just rejected).
 */
export const PRICE_DATA_REJECTIONS: readonly string[] = ["BadSigner", "FuturePrice", "ZeroPrice", "InsufficientSources", "LengthMismatch"];

export function isPriceDataRejection(err: unknown): boolean {
  const name = revertName(err);
  return name !== null && PRICE_DATA_REJECTIONS.includes(name);
}

/**
 * Gas limit for a desk tx: the eth_estimateGas result + 30% + 30k. The estimate is a tight binary
 * search at the estimation block; the mined block can cost more (PoolEngine._accrue writes the
 * funding index only when no earlier tx in that block touched the market) and every nested hop
 * (desk -> mandate/adapter -> engine) forwards only 63/64 of what is left, so an unbuffered limit
 * OOGs the inner engine call (SetQuote) while the outer frames still have gas.
 */
export const GAS_BUFFER_NUM = 13n;
export const GAS_BUFFER_DEN = 10n;
export const GAS_BUFFER_PAD = 30_000n;
export const bufferedGas = (estimate: bigint): bigint => (estimate * GAS_BUFFER_NUM) / GAS_BUFFER_DEN + GAS_BUFFER_PAD;

/** Receipt polling (viem's http default is 4s, too slow for 1s devnet blocks and quote updates). */
export const RECEIPT_POLL_MS = 500;

export interface DeskRunResult {
  hash: Hex;
  receipt: TransactionReceipt;
  /** sent as executeWithPrices (signed prices carried) */
  withPrices?: boolean;
}

export interface DeskRunner extends DeskExecutor {
  run(action: DeskAction, label: string): Promise<DeskRunResult>;
  readonly key: Address;
}

export class DeskClient implements DeskRunner {
  constructor(
    private readonly pub: PublicClient,
    private readonly wallet: WalletClient<Transport, Chain, Account>,
    private readonly desk: Address,
    private readonly log: Logger,
    private readonly timeoutMs: number,
    private readonly lock: SerialLock = new SerialLock(),
    /** pull oracle: signed prices per action kind (null = always plain execute, e.g. a legacy desk) */
    private readonly prices: DeskPriceData | null = null,
  ) {}

  get key(): Address {
    return this.wallet.account.address;
  }

  get carriesPrices(): boolean {
    return this.prices !== null;
  }

  async execute(action: DeskAction, label: string): Promise<Hex> {
    return (await this.run(action, label)).hash;
  }

  private call(action: DeskAction, priceData: Hex | null) {
    const a = { kind: action.kind, data: action.data, proof: action.proof };
    return {
      account: this.wallet.account,
      address: this.desk,
      abi: DESK_PULL_ABI,
      functionName: priceData ? "executeWithPrices" : "execute",
      args: priceData ? [a, priceData] : [a],
    } as const;
  }

  run(action: DeskAction, label: string): Promise<DeskRunResult> {
    return this.lock.run(async () => {
      const kind = DESK_ACTION_NAME[action.kind];
      // fetched inside the lock: the freshest prices at send time, not at enqueue time
      const priceData = this.prices
        ? await this.prices.forAction(action.kind).catch((err: unknown) => {
            this.log.warn({ action: kind, label, err: errMsg(err) }, "desk: signed prices unavailable; sending without");
            return null;
          })
        : null;
      let call = this.call(action, priceData);
      let request: Awaited<ReturnType<PublicClient["simulateContract"]>>["request"];
      try {
        ({ request } = await this.pub.simulateContract(call));
      } catch (err) {
        if (!priceData || !isPriceDataRejection(err)) throw err;
        this.log.warn({ action: kind, label, err: errMsg(err) }, "desk: carried price data rejected; retrying as plain execute");
        call = this.call(action, null);
        ({ request } = await this.pub.simulateContract(call));
      }
      const withPrices = call.functionName === "executeWithPrices";
      const estimate = await this.pub.estimateContractGas(call);
      const gas = bufferedGas(estimate);
      const hash = await this.wallet.writeContract({ ...request, gas } as never);
      this.log.info({ txHash: hash, action: kind, label, desk: this.desk, gas: gas.toString(), withPrices }, "desk tx sent");
      const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: this.timeoutMs, pollingInterval: RECEIPT_POLL_MS });
      if (receipt.status !== "success") throw new Error(`desk ${kind} (${label}) reverted in tx ${hash}`);
      this.log.info({ txHash: hash, action: kind, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), withPrices }, "desk tx confirmed");
      return { hash, receipt, withPrices };
    });
  }
}
