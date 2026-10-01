// Desk session-key transactions: direct `execute(Action)` txs signed by the book's desk key
// (devnet / no bundler). Serialized through one lock so the quote loop (SetQuote) and the hedge loop
// (Hedge/FundDesk/Flatten) never race on the key's nonce. Each tx is simulated first (decoded
// mandate errors), then sent, and the receipt awaited; tx hashes are logged.

import type { Logger } from "@bookrunner/shared";
import { bookrunnerDeskAbi, mMMandateAbi, poolEngineAbi } from "@bookrunner/shared/abi";
import type { Account, Address, Chain, Hex, PublicClient, TransactionReceipt, Transport, WalletClient } from "viem";
import { SerialLock } from "../util";
import { DESK_ACTION_NAME, type DeskAction } from "./desk-actions";
import type { DeskExecutor } from "../venues/engine";

type MandateError = Extract<(typeof mMMandateAbi)[number], { type: "error" }>;
type EngineError = Extract<(typeof poolEngineAbi)[number], { type: "error" }>;

/** Desk ABI + the mandate/engine custom errors that bubble up through execute(). */
export const DESK_ABI_WITH_ERRORS = [
  ...bookrunnerDeskAbi,
  ...mMMandateAbi.filter((x): x is MandateError => x.type === "error"),
  ...poolEngineAbi.filter((x): x is EngineError => (x as { type: string }).type === "error"),
] as const;

/** Receipt polling (viem's http default is 4s, too slow for 1s devnet blocks and quote updates). */
export const RECEIPT_POLL_MS = 500;

export interface DeskRunResult {
  hash: Hex;
  receipt: TransactionReceipt;
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
  ) {}

  get key(): Address {
    return this.wallet.account.address;
  }

  async execute(action: DeskAction, label: string): Promise<Hex> {
    return (await this.run(action, label)).hash;
  }

  run(action: DeskAction, label: string): Promise<DeskRunResult> {
    return this.lock.run(async () => {
      const kind = DESK_ACTION_NAME[action.kind];
      const { request } = await this.pub.simulateContract({
        account: this.wallet.account,
        address: this.desk,
        abi: DESK_ABI_WITH_ERRORS,
        functionName: "execute",
        args: [{ kind: action.kind, data: action.data, proof: action.proof }],
      });
      const hash = await this.wallet.writeContract(request);
      this.log.info({ txHash: hash, action: kind, label, desk: this.desk }, "desk tx sent");
      const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: this.timeoutMs, pollingInterval: RECEIPT_POLL_MS });
      if (receipt.status !== "success") throw new Error(`desk ${kind} (${label}) reverted in tx ${hash}`);
      this.log.info({ txHash: hash, action: kind, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() }, "desk tx confirmed");
      return { hash, receipt };
    });
  }
}
