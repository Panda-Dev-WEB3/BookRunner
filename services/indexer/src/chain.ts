// Chain port of the indexer + viem implementation. Enrichment reads are made at the log's block
// (consistent replays) and fall back to the latest state when the node has pruned that state.
import { publicClientFor } from "@bookrunner/shared";
import { bookAbi, mMMandateAbi, markRegistryAbi, marketCharterAbi } from "@bookrunner/shared/abi";
import { type Address, type Hex, type PublicClient, decodeFunctionData } from "viem";
import { charterStructToJson } from "./convert";
import type { RawLog } from "./decode";

export interface CharterRecordLite {
  charter: Record<string, unknown>; // charters.struct_json shape
  filedAt: number;
  decidedAt: number;
}

export interface IndexerChain {
  headBlock(): Promise<bigint>;
  getLogs(addresses: Address[], from: bigint, to: bigint): Promise<RawLog[]>;
  blockTimestamp(n: bigint): Promise<number>;
  charterRecord(id: bigint, at: bigint): Promise<CharterRecordLite | null>;
  bookCharter(book: Address, at: bigint): Promise<Record<string, unknown> | null>;
  bookSubscriptionEnds(book: Address, at: bigint): Promise<number | null>;
  bookLastMarkId(book: Address, at: bigint): Promise<bigint | null>;
  mark(markId: bigint, at: bigint): Promise<{ flowNonce: bigint; committedAt: number } | null>;
  commitSignature(txHash: Hex): Promise<Hex | null>;
  mandateKeyOperator(mandate: Address, key: Address, at: bigint): Promise<Address | null>;
}

export class ViemIndexerChain implements IndexerChain {
  readonly pub: PublicClient;
  private readonly ts = new Map<bigint, number>();

  constructor(
    chainId: number,
    rpcUrl: string,
    private readonly contracts: { charter: Address; markRegistry: Address },
    private readonly chunk = 200,
  ) {
    this.pub = publicClientFor(chainId, rpcUrl);
  }

  headBlock(): Promise<bigint> {
    return this.pub.getBlockNumber({ cacheTime: 0 });
  }

  async getLogs(addresses: Address[], from: bigint, to: bigint): Promise<RawLog[]> {
    const out: RawLog[] = [];
    for (let i = 0; i < addresses.length; i += this.chunk) {
      const logs = await this.pub.getLogs({ address: addresses.slice(i, i + this.chunk), fromBlock: from, toBlock: to });
      for (const l of logs) out.push(l);
    }
    return out;
  }

  async blockTimestamp(n: bigint): Promise<number> {
    const hit = this.ts.get(n);
    if (hit !== undefined) return hit;
    const b = await this.pub.getBlock({ blockNumber: n });
    const t = Number(b.timestamp);
    if (this.ts.size > 5000) this.ts.clear();
    this.ts.set(n, t);
    return t;
  }

  /** Read at `at`, falling back to latest when historical state is unavailable. */
  private async at<T>(fn: (blockNumber?: bigint) => Promise<T>, at: bigint): Promise<T> {
    try {
      return await fn(at);
    } catch {
      return fn(undefined);
    }
  }

  async charterRecord(id: bigint, at: bigint): Promise<CharterRecordLite | null> {
    const address = this.contracts.charter;
    const r = await this.at((blockNumber) => this.pub.readContract({ address, abi: marketCharterAbi, functionName: "get", args: [id], blockNumber }), at);
    return {
      charter: charterStructToJson(r.charter as unknown as Record<string, unknown>),
      filedAt: Number(r.filedAt),
      decidedAt: Number(r.decidedAt),
    };
  }

  async bookCharter(book: Address, at: bigint): Promise<Record<string, unknown> | null> {
    try {
      const c = await this.at((blockNumber) => this.pub.readContract({ address: book, abi: bookAbi, functionName: "getCharter", blockNumber }), at);
      return charterStructToJson(c as unknown as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  async bookSubscriptionEnds(book: Address, at: bigint): Promise<number | null> {
    try {
      return Number(await this.at((blockNumber) => this.pub.readContract({ address: book, abi: bookAbi, functionName: "subscriptionEnds", blockNumber }), at));
    } catch {
      return null;
    }
  }

  async bookLastMarkId(book: Address, at: bigint): Promise<bigint | null> {
    try {
      return await this.at((blockNumber) => this.pub.readContract({ address: book, abi: bookAbi, functionName: "lastMarkId", blockNumber }), at);
    } catch {
      return null;
    }
  }

  async mark(markId: bigint, at: bigint): Promise<{ flowNonce: bigint; committedAt: number } | null> {
    const address = this.contracts.markRegistry;
    try {
      const m = await this.at((blockNumber) => this.pub.readContract({ address, abi: markRegistryAbi, functionName: "getMark", args: [markId], blockNumber }), at);
      return { flowNonce: m.input.flowNonce, committedAt: Number(m.committedAt) };
    } catch {
      return null;
    }
  }

  /** Signature from MarkRegistry.commit(m, sig) calldata (null if the tx was not a direct commit). */
  async commitSignature(txHash: Hex): Promise<Hex | null> {
    try {
      const tx = await this.pub.getTransaction({ hash: txHash });
      const d = decodeFunctionData({ abi: markRegistryAbi, data: tx.input });
      if (d.functionName !== "commit") return null;
      return (d.args?.[1] as Hex | undefined) ?? null;
    } catch {
      return null;
    }
  }

  async mandateKeyOperator(mandate: Address, key: Address, at: bigint): Promise<Address | null> {
    try {
      const k = await this.at((blockNumber) => this.pub.readContract({ address: mandate, abi: mMMandateAbi, functionName: "getKey", args: [key], blockNumber }), at);
      return k.operator;
    } catch {
      return null;
    }
  }
}
