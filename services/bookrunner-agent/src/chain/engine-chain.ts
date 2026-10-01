// viem implementation of EngineChain: PoolEngineAdapter / PoolEngine views and Trade-event scanning
// for the book's market (block cursor, chunked getLogs, cached block timestamps).

import { poolEngineAbi, poolEngineAdapterAbi } from "@bookrunner/shared/abi";
import type { Address, PublicClient } from "viem";
import type { EngineChain, EngineQuoteParams, EngineState, EngineTrade } from "../venues/engine";

export interface EngineChainConfig {
  lookbackBlocks: number;
  chunkBlocks: number;
  startBlock: number;
}

export class ViemEngineChain implements EngineChain {
  private cursor: bigint | null = null; // last scanned block
  private readonly blockTs = new Map<bigint, number>();

  constructor(
    private readonly pub: PublicClient,
    private readonly engine: Address,
    private readonly adapter: Address,
    readonly marketId: bigint,
    private readonly cfg: EngineChainConfig,
  ) {}

  static async create(pub: PublicClient, engine: Address, adapter: Address, cfg: EngineChainConfig): Promise<ViemEngineChain> {
    const marketId = await pub.readContract({ address: adapter, abi: poolEngineAdapterAbi, functionName: "marketId" });
    return new ViemEngineChain(pub, engine, adapter, marketId, cfg);
  }

  async readState(): Promise<EngineState> {
    const [netExposureUsd, marginEquityUsd, insuranceEquityUsd, poolEquityUsd, st] = await Promise.all([
      this.pub.readContract({ address: this.adapter, abi: poolEngineAdapterAbi, functionName: "netExposureUsd" }),
      this.pub.readContract({ address: this.adapter, abi: poolEngineAdapterAbi, functionName: "marginEquityUsd" }),
      this.pub.readContract({ address: this.adapter, abi: poolEngineAdapterAbi, functionName: "insuranceEquityUsd" }),
      this.pub.readContract({ address: this.engine, abi: poolEngineAbi, functionName: "poolEquityUsd", args: [this.marketId] }),
      this.pub.readContract({ address: this.engine, abi: poolEngineAbi, functionName: "state", args: [this.marketId] }),
    ]);
    return {
      netExposureUsd,
      marginEquityUsd,
      insuranceEquityUsd,
      poolEquityUsd,
      poolCashUsd: st.poolCashUsd,
      netSize: -(st.longSize + st.shortSize),
      reduceOnly: st.reduceOnly,
    };
  }

  async readQuote(): Promise<EngineQuoteParams | null> {
    const [st, cfg] = await Promise.all([
      this.pub.readContract({ address: this.engine, abi: poolEngineAbi, functionName: "state", args: [this.marketId] }),
      this.pub.readContract({ address: this.engine, abi: poolEngineAbi, functionName: "config", args: [this.marketId] }),
    ]);
    return { spreadBps: st.spreadBps, skewBps: st.skewBps, maxNetExposureUsd: cfg.maxNetExposureUsd };
  }

  private async timestampMs(blockNumber: bigint): Promise<number> {
    const hit = this.blockTs.get(blockNumber);
    if (hit !== undefined) return hit;
    const b = await this.pub.getBlock({ blockNumber });
    const ms = Number(b.timestamp) * 1000;
    this.blockTs.set(blockNumber, ms);
    if (this.blockTs.size > 5_000) {
      const first = this.blockTs.keys().next().value;
      if (first !== undefined) this.blockTs.delete(first);
    }
    return ms;
  }

  async tradesSince(sinceMs: number): Promise<EngineTrade[]> {
    const latest = await this.pub.getBlockNumber();
    if (this.cursor === null) {
      const lb = latest - BigInt(Math.max(0, this.cfg.lookbackBlocks));
      const start = BigInt(this.cfg.startBlock);
      this.cursor = (lb > start ? lb : start) - 1n;
    }
    if (latest <= this.cursor) return [];
    const out: EngineTrade[] = [];
    let from = this.cursor + 1n;
    const chunk = BigInt(Math.max(1, this.cfg.chunkBlocks));
    while (from <= latest) {
      const to = from + chunk - 1n < latest ? from + chunk - 1n : latest;
      const logs = await this.pub.getContractEvents({
        address: this.engine,
        abi: poolEngineAbi,
        eventName: "Trade",
        args: { marketId: this.marketId },
        fromBlock: from,
        toBlock: to,
      });
      for (const l of logs) {
        if (l.blockNumber === null || l.transactionHash === null || l.logIndex === null) continue;
        const a = l.args;
        if (a.sizeDelta === undefined || a.fillPriceWad === undefined || a.feeUsd === undefined || a.trader === undefined) continue;
        const tsMs = await this.timestampMs(l.blockNumber);
        if (tsMs < sinceMs) continue;
        out.push({
          txHash: l.transactionHash,
          logIndex: l.logIndex,
          blockNumber: l.blockNumber,
          tsMs,
          trader: a.trader,
          sizeDelta: a.sizeDelta,
          fillPriceWad: a.fillPriceWad,
          feeUsd: a.feeUsd,
        });
      }
      this.cursor = to; // advance only after the chunk was read
      from = to + 1n;
    }
    return out;
  }
}
