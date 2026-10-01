// AggregatorV3 reader for configured feed addresses (ORACLE_CHAINLINK_FEEDS = {"NVDA":"0x..."}).
// VERIFY: equity feed addresses, decimals, heartbeat and market-hours behaviour on the target chain;
// there are no such feeds on devnet, so this source is inactive unless configured.
import type { Address, PublicClient } from "viem";
import type { PriceSource } from "../domain/types";

export const aggregatorV3Abi = [
  { type: "function", name: "decimals", inputs: [], outputs: [{ name: "", type: "uint8" }], stateMutability: "view" },
  {
    type: "function",
    name: "latestRoundData",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
  },
] as const;

export interface AggregatorReader {
  decimals(feed: Address): Promise<number>;
  latestRoundData(feed: Address): Promise<{ answer: bigint; updatedAt: bigint }>;
}

export function viemAggregatorReader(pub: PublicClient): AggregatorReader {
  return {
    async decimals(feed) {
      return Number(await pub.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "decimals" }));
    },
    async latestRoundData(feed) {
      const [, answer, , updatedAt] = await pub.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData" });
      return { answer, updatedAt };
    },
  };
}

export class ChainlinkSource implements PriceSource {
  readonly name = "chainlink";
  private readonly decimals = new Map<Address, number>();

  constructor(
    private readonly feeds: Record<string, Address>,
    private readonly reader: AggregatorReader,
    readonly maxAgeMs?: number,
  ) {}

  tickers(): string[] {
    return Object.keys(this.feeds);
  }

  async fetch(ticker: string): Promise<{ price: number; ts: number } | null> {
    const feed = this.feeds[ticker];
    if (!feed) return null;
    let dec = this.decimals.get(feed);
    if (dec === undefined) {
      dec = await this.reader.decimals(feed);
      this.decimals.set(feed, dec);
    }
    const { answer, updatedAt } = await this.reader.latestRoundData(feed);
    if (answer <= 0n || updatedAt === 0n) return null;
    return { price: Number(answer) / 10 ** dec, ts: Number(updatedAt) * 1000 };
  }
}
