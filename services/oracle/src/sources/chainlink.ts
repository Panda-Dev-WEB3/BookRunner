// Chainlink AggregatorV3 source (VERIFY C1-C4). Feeds come from config/chains/<chainId>.json and/or
// ORACLE_CHAINLINK_FEEDS (config.ts). Per observation:
//   - optional L2 sequencer uptime feed: down, or up for less than the grace period -> no observation;
//   - decimals() read on-chain (cached); a mismatch with the configured decimals refuses the feed;
//   - latestRoundData(): answer > 0, updatedAt > 0, not in the future; the observation carries the feed's
//     own in-session max age (heartbeat + grace) and the aggregator rejects it beyond that. Staleness is
//     only a per-observation filter: the `held` flag comes from the session calendar (domain/hold.ts),
//     never from the feed (C3: off-hours the feed holds its last price and stays callable);
//   - per-token feeds (Robinhood tokenized equities: answer = share price x uiMultiplier) are divided by
//     the token's uiMultiplier() read in the same pass, so every published price is PER SHARE and the
//     registry applies the multiplier exactly once (C2, packages/shared/src/stockTokens.ts). No observation
//     while the token's advisory oraclePaused() is set (corporate action). When the active multiplier
//     became effective after the feed's last round, the answer still embeds the previous multiplier: the
//     source divides by the multiplier it saw with that same round (cached), or drops the observation
//     when it never saw the round before the change (e.g. right after a restart).
import { type FeedConfig, feedAnswerToWad, perSharePriceWad } from "@bookrunner/shared";
import type { Address, PublicClient } from "viem";
import type { PriceSource, SourceObservation } from "../domain/types";

export const aggregatorV3Abi = [
  { type: "function", name: "decimals", inputs: [], outputs: [{ name: "", type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "description", inputs: [], outputs: [{ name: "", type: "string" }], stateMutability: "view" },
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

/** ERC-8056 + Robinhood Stock Token views (contracts/src/interfaces/external/IScaledUIAmount.sol). */
export const stockTokenAbi = [
  { type: "function", name: "uiMultiplier", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "newUIMultiplier", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "effectiveAt", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "oraclePaused", inputs: [], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ name: "", type: "uint8" }], stateMutability: "view" },
] as const;

export interface RoundData {
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
}

export interface TokenState {
  uiMultiplier: bigint;
  /** null when the view is not implemented */
  newUIMultiplier: bigint | null;
  effectiveAt: bigint | null;
  oraclePaused: boolean | null;
}

export interface AggregatorReader {
  decimals(feed: Address): Promise<number>;
  latestRoundData(feed: Address): Promise<RoundData>;
  tokenState(token: Address): Promise<TokenState>;
}

const optional = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

export function viemAggregatorReader(pub: PublicClient): AggregatorReader {
  return {
    async decimals(feed) {
      return Number(await pub.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "decimals" }));
    },
    async latestRoundData(feed) {
      const [, answer, startedAt, updatedAt] = await pub.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData" });
      return { answer, startedAt, updatedAt };
    },
    async tokenState(token) {
      const [uiMultiplier, newUIMultiplier, effectiveAt, oraclePaused] = await Promise.all([
        pub.readContract({ address: token, abi: stockTokenAbi, functionName: "uiMultiplier" }),
        optional(pub.readContract({ address: token, abi: stockTokenAbi, functionName: "newUIMultiplier" })),
        optional(pub.readContract({ address: token, abi: stockTokenAbi, functionName: "effectiveAt" })),
        optional(pub.readContract({ address: token, abi: stockTokenAbi, functionName: "oraclePaused" })),
      ]);
      return { uiMultiplier, newUIMultiplier, effectiveAt, oraclePaused };
    },
  };
}

/** A configured feed, resolved (token address + in-session max age). */
export interface ResolvedFeed {
  proxy: Address;
  basis: FeedConfig["basis"];
  token: Address | null;
  decimals?: number;
  /** in-session staleness bound for this feed's observations */
  maxAgeMs: number;
  description?: string;
}

export interface ChainlinkOptions {
  /** Chainlink L2 sequencer uptime feed (answer 0 = up). */
  sequencerFeed?: Address | null;
  /** Sequencer must have been up this long (Chainlink's recommended grace: 3600 s). */
  sequencerGraceMs?: number;
  /** Tolerated lead of updatedAt over the local clock. */
  maxFutureMs?: number;
  now?: () => number;
}

export type ChainlinkObservation =
  | {
      ok: true;
      /** price per SHARE (per-token feeds already divided by uiMultiplier) */
      price: number;
      ts: number;
      maxAgeMs: number;
      ageMs: number;
      stale: boolean;
      decimals: number;
      answer: bigint;
      /** multiplier the per-token answer was divided by (null for per-share feeds) */
      uiMultiplier: bigint | null;
      pendingMultiplier: { value: bigint; effectiveAt: number } | null;
    }
  | { ok: false; reason: string };

export class ChainlinkSource implements PriceSource {
  readonly name = "chainlink";
  readonly kind = "chainlink" as const;
  private readonly decimalsCache = new Map<Address, number>();
  /** Multiplier in force when a feed round was first observed (the one the answer embeds). */
  private readonly roundMultiplier = new Map<Address, { updatedAt: bigint; multiplier: bigint }>();
  private readonly now: () => number;

  constructor(
    private readonly feeds: Record<string, ResolvedFeed>,
    private readonly reader: AggregatorReader,
    private readonly opts: ChainlinkOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  tickers(): string[] {
    return Object.keys(this.feeds);
  }

  feed(ticker: string): ResolvedFeed | undefined {
    return this.feeds[ticker];
  }

  async fetch(ticker: string): Promise<SourceObservation | null> {
    const o = await this.observe(ticker);
    return o.ok ? { price: o.price, ts: o.ts, maxAgeMs: o.maxAgeMs } : null;
  }

  /** Full observation with the reason when unusable (fetch, and the source-check CLI). */
  async observe(ticker: string): Promise<ChainlinkObservation> {
    const f = this.feeds[ticker];
    if (!f) return { ok: false, reason: "no feed configured" };
    const nowMs = this.now();

    const seq = this.opts.sequencerFeed;
    if (seq) {
      const s = await this.reader.latestRoundData(seq);
      if (s.answer !== 0n) return { ok: false, reason: "L2 sequencer down" };
      const upForMs = nowMs - Number(s.startedAt) * 1000;
      if (upForMs < (this.opts.sequencerGraceMs ?? 3_600_000)) return { ok: false, reason: `L2 sequencer up for ${Math.round(upForMs / 1000)}s (< grace)` };
    }

    let dec = this.decimalsCache.get(f.proxy);
    if (dec === undefined) {
      dec = await this.reader.decimals(f.proxy);
      this.decimalsCache.set(f.proxy, dec);
    }
    if (f.decimals !== undefined && dec !== f.decimals) return { ok: false, reason: `decimals() = ${dec}, configured ${f.decimals}` };

    const [round, token] = await Promise.all([
      this.reader.latestRoundData(f.proxy),
      f.basis === "per-token" && f.token ? this.reader.tokenState(f.token) : Promise.resolve(null),
    ]);
    if (round.answer <= 0n) return { ok: false, reason: `answer ${round.answer} <= 0` };
    if (round.updatedAt === 0n) return { ok: false, reason: "round not complete (updatedAt 0)" };
    const ts = Number(round.updatedAt) * 1000;
    if (ts > nowMs + (this.opts.maxFutureMs ?? 5_000)) return { ok: false, reason: "updatedAt in the future" };

    const answerWad = feedAnswerToWad(round.answer, dec);
    let priceWad = answerWad;
    let pendingMultiplier: { value: bigint; effectiveAt: number } | null = null;
    let multiplierUsed: bigint | null = null;
    if (f.basis === "per-token") {
      if (!f.token || !token) return { ok: false, reason: "per-token feed without a Stock Token (cannot divide by uiMultiplier)" };
      if (token.uiMultiplier <= 0n) return { ok: false, reason: "uiMultiplier() = 0" };
      if (token.oraclePaused === true) return { ok: false, reason: "token oraclePaused() (corporate action in progress)" };
      const eff = token.effectiveAt ?? 0n;
      let multiplier = token.uiMultiplier;
      if (eff > round.updatedAt && Number(eff) * 1000 <= nowMs) {
        // the active multiplier changed after this round: the answer embeds the previous one. Known
        // exactly if this very round was observed before the change; otherwise drop the observation.
        const seen = this.roundMultiplier.get(f.proxy);
        if (!seen || seen.updatedAt !== round.updatedAt) {
          return { ok: false, reason: `multiplier became effective at ${eff} after the feed's last round (${round.updatedAt})` };
        }
        multiplier = seen.multiplier;
      } else {
        this.roundMultiplier.set(f.proxy, { updatedAt: round.updatedAt, multiplier });
      }
      if (token.newUIMultiplier !== null && token.newUIMultiplier !== token.uiMultiplier && Number(eff) * 1000 > nowMs) {
        pendingMultiplier = { value: token.newUIMultiplier, effectiveAt: Number(eff) };
      }
      multiplierUsed = multiplier;
      priceWad = perSharePriceWad(answerWad, multiplier);
    }
    const ageMs = nowMs - ts;
    return {
      ok: true,
      price: Number(priceWad) / 1e18,
      ts,
      maxAgeMs: f.maxAgeMs,
      ageMs,
      stale: ageMs > f.maxAgeMs,
      decimals: dec,
      answer: round.answer,
      uiMultiplier: multiplierUsed,
      pendingMultiplier,
    };
  }
}
