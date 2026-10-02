// viem adapters: AttestedOracle writes (pushMany with the oracleSigner role account) and the reads
// used by discovery (IBook.getCharter, StockTokenRegistry.getIndex / getToken).
import type { Logger, PriceUpdate } from "@bookrunner/shared";
import { attestedOracleAbi, bookAbi, stockTokenRegistryAbi } from "@bookrunner/shared/abi";
import { type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient, toFunctionSelector } from "viem";
import type { ChainReader, CharterView } from "../discovery";

export interface PushResult {
  txHash: Hex;
  blockNumber: bigint;
  status: "success" | "reverted";
}

export interface OracleChain {
  readonly oracle: Address;
  readonly chainId: number;
  headTimestamp(): Promise<number>;
  isSigner(addr: Address): Promise<boolean>;
  minSources(): Promise<number>;
  /** stored publishedAt (unix s) for an oracle key; 0 when never pushed */
  latestPublishedAt(underlying: Hex): Promise<number>;
  pushMany(updates: readonly PriceUpdate[], sigs: readonly Hex[]): Promise<PushResult>;
  /**
   * Whether the deployed AttestedOracle has the pull entry point `update(bytes)` (docs/LOW_GAS.md §1).
   * A pre-low-gas deployment does not, and neither do its consumers: pull mode then keeps heartbeat
   * pushes so the stored price stays fresh. Optional (absent = assume the pull contract).
   */
  supportsUpdate?(): Promise<boolean>;
}

/** AttestedOracle.update(bytes) — the pull-oracle relay (docs/LOW_GAS.md §1). */
export const ORACLE_UPDATE_SELECTOR = toFunctionSelector("update(bytes)");

/** Whether runtime code dispatches `selector` (solc pushes every external selector as a PUSH4 constant). */
export function codeDispatches(code: Hex | undefined, selector: Hex): boolean {
  if (!code || code === "0x") return false;
  return code.toLowerCase().includes(`63${selector.toLowerCase().replace(/^0x/, "")}`);
}

export class ViemOracleChain implements OracleChain {
  constructor(
    private readonly pub: PublicClient,
    private readonly wallet: WalletClient<Transport, Chain, Account>,
    readonly oracle: Address,
    readonly chainId: number,
    private readonly log: Logger,
    private readonly receiptTimeoutMs = 30_000,
  ) {}

  async headTimestamp(): Promise<number> {
    const b = await this.pub.getBlock({ blockTag: "latest" });
    return Number(b.timestamp);
  }

  isSigner(addr: Address): Promise<boolean> {
    return this.pub.readContract({ address: this.oracle, abi: attestedOracleAbi, functionName: "isSigner", args: [addr] });
  }

  async minSources(): Promise<number> {
    return Number(await this.pub.readContract({ address: this.oracle, abi: attestedOracleAbi, functionName: "minSources" }));
  }

  async latestPublishedAt(underlying: Hex): Promise<number> {
    const d = await this.pub.readContract({ address: this.oracle, abi: attestedOracleAbi, functionName: "latest", args: [underlying] });
    return Number(d.publishedAt);
  }

  async supportsUpdate(): Promise<boolean> {
    // AttestedOracle is deployed directly (non-upgradeable, no proxy): its own code is the dispatcher
    return codeDispatches(await this.pub.getCode({ address: this.oracle }), ORACLE_UPDATE_SELECTOR);
  }

  async pushMany(updates: readonly PriceUpdate[], sigs: readonly Hex[]): Promise<PushResult> {
    const txHash = await this.wallet.writeContract({
      address: this.oracle,
      abi: attestedOracleAbi,
      functionName: "pushMany",
      args: [updates.map((u) => ({ ...u })), [...sigs]],
    });
    this.log.info({ txHash, count: updates.length }, "pushMany sent");
    // poll faster than viem's 4s default: pushes are serialized, so receipt latency delays the next one
    const receipt = await this.pub.waitForTransactionReceipt({ hash: txHash, timeout: this.receiptTimeoutMs, pollingInterval: 500 });
    this.log.info({ txHash, block: receipt.blockNumber.toString(), status: receipt.status, gasUsed: receipt.gasUsed.toString() }, "pushMany mined");
    return { txHash, blockNumber: receipt.blockNumber, status: receipt.status };
  }
}

export class ViemChainReader implements ChainReader {
  constructor(
    private readonly pub: PublicClient,
    private readonly registry: Address,
  ) {}

  async charterOf(book: Address): Promise<CharterView> {
    const c = await this.pub.readContract({ address: book, abi: bookAbi, functionName: "getCharter" });
    return { underlying: c.underlying, venue: Number(c.venue), sessions: c.sessions, symbol: c.symbol };
  }

  async indexOf(underlying: Hex) {
    const [priceId, components] = await this.pub.readContract({
      address: this.registry,
      abi: stockTokenRegistryAbi,
      functionName: "getIndex",
      args: [underlying],
    });
    return { priceId, components: components.map((c) => ({ token: c.token, weightBps: c.weightBps })) };
  }

  async tokenPriceId(token: Address): Promise<Hex> {
    const t = await this.pub.readContract({ address: this.registry, abi: stockTokenRegistryAbi, functionName: "getToken", args: [token] });
    return t.priceId;
  }
}
