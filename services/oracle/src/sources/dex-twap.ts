// Uniswap v3 TWAP confirm source (kind "dex", name "dex-twap"): for each ticker the deepest Stock-Token / USDG pool
// of config/chains/<chainId>.json `dexConfirm.pools`. It CONFIRMS the Chainlink price under the primary-confirm
// policy (domain/confirm.ts) and is never a signing source: a manipulated pool can raise alerts, never move a price.
// Per observation, all reads pinned to one block (the latest, shared by every ticker of a tick):
//   - pool token0 / token1 (cached): one is the Stock Token, the other the quote token, else refused;
//   - liquidity floor: quote-token balanceOf(pool) >= minQuoteLiquidityUsd (whole tokens; USDG assumed = $1);
//   - observation history: the oldest observation (slot0 observationIndex + 1 mod cardinality, else index 0) must
//     be at least twapSec old, i.e. the ring buffer covers the window (otherwise observe() would revert "OLD");
//   - observe([twapSec, 0]) -> arithmetic-mean tick (rounded toward -inf, Uniswap OracleLibrary.consult) ->
//     price of one whole Stock Token in whole quote tokens (orientation from token0, decimals: token config, quote
//     decimals() read on-chain and cached);
//   - per share: divided by the token's uiMultiplier exactly like the Chainlink per-token feeds (tokenStateProblem,
//     perSharePriceWad); no observation while oraclePaused() or when the multiplier changed inside the window;
//   - ts = the block's timestamp (never the receive time).
import { perSharePriceWad, tickToPrice } from "@bookrunner/shared";
import { type Address, type PublicClient, erc20Abi, getAddress, parseAbi } from "viem";
import type { PriceSource, SourceObservation } from "../domain/types";
import { type TokenState, tokenStateProblem, viemAggregatorReader } from "./chainlink";

export const DEX_SOURCE_NAME = "dex-twap";

/** A configured confirm pool, resolved (config.ts resolveDexPools). */
export interface ResolvedDexPool {
  pool: Address;
  /** the Stock Token (stockTokens[ticker].token) */
  token: Address;
  tokenDecimals: number;
  quoteToken: Address;
  twapSec: number;
  /** whole quote tokens (USD at the USDG = $1 assumption) */
  minQuoteLiquidity: number;
  fee?: number;
}

export interface DexBlock {
  number: bigint;
  /** unix seconds */
  timestamp: number;
}

export interface Slot0 {
  tick: number;
  observationIndex: number;
  observationCardinality: number;
}

export interface DexReader {
  block(): Promise<DexBlock>;
  poolTokens(pool: Address): Promise<{ token0: Address; token1: Address }>;
  decimals(token: Address): Promise<number>;
  slot0(pool: Address, blockNumber: bigint): Promise<Slot0>;
  observation(pool: Address, index: number, blockNumber: bigint): Promise<{ blockTimestamp: number; initialized: boolean }>;
  /** tickCumulatives for `secondsAgos` (reverts "OLD" when the history does not reach that far) */
  observe(pool: Address, secondsAgos: readonly number[], blockNumber: bigint): Promise<readonly bigint[]>;
  balanceOf(token: Address, owner: Address, blockNumber: bigint): Promise<bigint>;
  tokenState(token: Address): Promise<TokenState>;
}

export const uniswapV3OracleAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observations(uint256 index) view returns (uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);

/** Reads through viem; every pool read pinned to the block of the tick. */
export function viemDexReader(pub: PublicClient): DexReader {
  const tokens = viemAggregatorReader(pub);
  return {
    async block() {
      const b = await pub.getBlock();
      return { number: b.number, timestamp: Number(b.timestamp) };
    },
    async poolTokens(pool) {
      const [token0, token1] = await Promise.all([
        pub.readContract({ address: pool, abi: uniswapV3OracleAbi, functionName: "token0" }),
        pub.readContract({ address: pool, abi: uniswapV3OracleAbi, functionName: "token1" }),
      ]);
      return { token0: getAddress(token0), token1: getAddress(token1) };
    },
    async decimals(token) {
      return Number(await pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
    },
    async slot0(pool, blockNumber) {
      const s = await pub.readContract({ address: pool, abi: uniswapV3OracleAbi, functionName: "slot0", blockNumber });
      return { tick: Number(s[1]), observationIndex: Number(s[2]), observationCardinality: Number(s[3]) };
    },
    async observation(pool, index, blockNumber) {
      const o = await pub.readContract({ address: pool, abi: uniswapV3OracleAbi, functionName: "observations", args: [BigInt(index)], blockNumber });
      return { blockTimestamp: Number(o[0]), initialized: o[3] };
    },
    async observe(pool, secondsAgos, blockNumber) {
      const [cum] = await pub.readContract({ address: pool, abi: uniswapV3OracleAbi, functionName: "observe", args: [secondsAgos.map(Number)], blockNumber });
      return cum;
    },
    balanceOf: (token, owner, blockNumber) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber }),
    tokenState: (token) => tokens.tokenState(token),
  };
}

/** Uniswap OracleLibrary.consult: (cum1 - cum0) / secs, rounded toward negative infinity. */
export function arithmeticMeanTick(tickCumulativeAgo: bigint, tickCumulativeNow: bigint, secs: number): number {
  if (!Number.isInteger(secs) || secs <= 0) throw new Error(`TWAP window must be a positive integer (s), got ${secs}`);
  const delta = tickCumulativeNow - tickCumulativeAgo;
  const s = BigInt(secs);
  let t = delta / s;
  if (delta < 0n && delta % s !== 0n) t -= 1n;
  return Number(t);
}

/**
 * Whole quote tokens per whole Stock Token at `tick` (tick = log_1.0001(raw token1 / raw token0)), whichever of the
 * two is token0.
 */
export function tokenPriceAtTick(tick: number, tokenIsToken0: boolean, tokenDecimals: number, quoteDecimals: number): number {
  return tokenIsToken0 ? tickToPrice(tick, tokenDecimals, quoteDecimals) : 1 / tickToPrice(tick, quoteDecimals, tokenDecimals);
}

/** Float USD price -> WAD (8 decimals kept: PRICE_DECIMALS of every signed price). */
export function priceToWad(price: number): bigint {
  return BigInt(Math.round(price * 1e8)) * 10n ** 10n;
}

/** Per-share price from a per-token price and uiMultiplier (WAD), through the shared conversion. */
export function perSharePrice(tokenPrice: number, uiMultiplier: bigint): number {
  return Number(perSharePriceWad(priceToWad(tokenPrice), uiMultiplier)) / 1e18;
}

export type DexObservation =
  | {
      ok: true;
      /** USD per SHARE (TWAP token price / uiMultiplier) */
      price: number;
      /** USD (quote tokens) per Stock Token over the window */
      tokenPrice: number;
      /** spot (slot0) token price, display only */
      spotTokenPrice: number;
      meanTick: number;
      twapSec: number;
      /** block timestamp, unix ms */
      ts: number;
      quoteLiquidity: number;
      cardinality: number;
      /** age of the oldest observation (s): how far back observe() can reach */
      historySec: number;
      uiMultiplier: bigint;
    }
  | { ok: false; reason: string; quoteLiquidity?: number; cardinality?: number; historySec?: number };

export interface DexTwapOptions {
  /** observation max age (block time vs now) */
  maxAgeMs: number;
  /** a block read this recently is reused by every ticker of a tick */
  blockCacheMs?: number;
  now?: () => number;
}

const errMsg = (e: unknown): string => (e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e));

export class DexTwapSource implements PriceSource {
  readonly name = DEX_SOURCE_NAME;
  readonly kind = "dex" as const;
  readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly poolTokenCache = new Map<Address, Promise<{ token0: Address; token1: Address }>>();
  private readonly decimalsCache = new Map<Address, Promise<number>>();
  /** oldest observation timestamp per (pool, observationIndex, cardinality): it only moves when the index does */
  private readonly oldestCache = new Map<Address, { key: string; ts: number }>();
  private blockCache: { at: number; block: Promise<DexBlock> } | null = null;

  constructor(
    private readonly pools: Readonly<Record<string, ResolvedDexPool>>,
    private readonly reader: DexReader,
    private readonly opts: DexTwapOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs;
  }

  tickers(): string[] {
    return Object.keys(this.pools);
  }

  pool(ticker: string): ResolvedDexPool | undefined {
    return this.pools[ticker];
  }

  /** Throws with the reason when there is no usable observation (per-source health shows it). */
  async fetch(ticker: string): Promise<SourceObservation | null> {
    const o = await this.observe(ticker);
    if (!o.ok) throw new Error(o.reason);
    return { price: o.price, ts: o.ts, maxAgeMs: this.maxAgeMs };
  }

  private block(): Promise<DexBlock> {
    const t = this.now();
    if (!this.blockCache || t - this.blockCache.at > (this.opts.blockCacheMs ?? 500)) {
      const block = this.reader.block();
      this.blockCache = { at: t, block };
      block.catch(() => {
        if (this.blockCache?.block === block) this.blockCache = null;
      });
    }
    return this.blockCache.block;
  }

  private cached<K, V>(m: Map<K, Promise<V>>, k: K, f: () => Promise<V>): Promise<V> {
    let p = m.get(k);
    if (!p) {
      p = f();
      m.set(k, p);
      p.catch(() => m.delete(k));
    }
    return p;
  }

  async observe(ticker: string): Promise<DexObservation> {
    const p = this.pools[ticker];
    if (!p) return { ok: false, reason: "no DEX confirm pool configured" };
    try {
      return await this.read(p);
    } catch (e) {
      return { ok: false, reason: `pool not readable: ${errMsg(e)}` };
    }
  }

  private async read(p: ResolvedDexPool): Promise<DexObservation> {
    const [block, tokens, quoteDecimals] = await Promise.all([
      this.block(),
      this.cached(this.poolTokenCache, p.pool, () => this.reader.poolTokens(p.pool)),
      this.cached(this.decimalsCache, p.quoteToken, () => this.reader.decimals(p.quoteToken)),
    ]);
    const t0 = tokens.token0.toLowerCase();
    const t1 = tokens.token1.toLowerCase();
    const tok = p.token.toLowerCase();
    const quote = p.quoteToken.toLowerCase();
    if (!((t0 === tok && t1 === quote) || (t0 === quote && t1 === tok))) {
      return { ok: false, reason: `pool tokens ${tokens.token0} / ${tokens.token1} are not the Stock Token ${p.token} and the quote token ${p.quoteToken}` };
    }
    const tokenIsToken0 = t0 === tok;

    const [balance, slot0, tokenState] = await Promise.all([
      this.reader.balanceOf(p.quoteToken, p.pool, block.number),
      this.reader.slot0(p.pool, block.number),
      this.reader.tokenState(p.token),
    ]);
    const quoteLiquidity = Number(balance) / 10 ** quoteDecimals;
    const cardinality = slot0.observationCardinality;
    if (quoteLiquidity < p.minQuoteLiquidity) {
      return { ok: false, reason: `insufficient liquidity: ${fmtUsd(quoteLiquidity)} quote tokens in the pool < floor ${fmtUsd(p.minQuoteLiquidity)}`, quoteLiquidity, cardinality };
    }

    const oldest = await this.oldestObservation(p.pool, slot0, block.number);
    const historySec = block.timestamp - oldest;
    if (historySec < p.twapSec) {
      return {
        ok: false,
        reason: `observation history ${historySec}s < TWAP window ${p.twapSec}s (cardinality ${cardinality}: increaseObservationCardinalityNext)`,
        quoteLiquidity,
        cardinality,
        historySec,
      };
    }

    const problem = tokenStateProblem(tokenState);
    if (problem) return { ok: false, reason: problem, quoteLiquidity, cardinality, historySec };
    const eff = Number(tokenState.effectiveAt ?? 0n);
    if (eff > block.timestamp - p.twapSec && eff <= block.timestamp) {
      return { ok: false, reason: `uiMultiplier changed at ${eff}, inside the ${p.twapSec}s TWAP window`, quoteLiquidity, cardinality, historySec };
    }

    let cum: readonly bigint[];
    try {
      cum = await this.reader.observe(p.pool, [p.twapSec, 0], block.number);
    } catch (e) {
      return { ok: false, reason: `observe([${p.twapSec}, 0]) failed: ${errMsg(e)}`, quoteLiquidity, cardinality, historySec };
    }
    if (cum.length !== 2) return { ok: false, reason: `observe returned ${cum.length} values`, quoteLiquidity, cardinality, historySec };
    const meanTick = arithmeticMeanTick(cum[0] as bigint, cum[1] as bigint, p.twapSec);
    const tokenPrice = tokenPriceAtTick(meanTick, tokenIsToken0, p.tokenDecimals, quoteDecimals);
    if (!Number.isFinite(tokenPrice) || tokenPrice <= 0) return { ok: false, reason: `TWAP price ${tokenPrice} not usable`, quoteLiquidity, cardinality, historySec };
    return {
      ok: true,
      price: perSharePrice(tokenPrice, tokenState.uiMultiplier),
      tokenPrice,
      spotTokenPrice: tokenPriceAtTick(slot0.tick, tokenIsToken0, p.tokenDecimals, quoteDecimals),
      meanTick,
      twapSec: p.twapSec,
      ts: block.timestamp * 1000,
      quoteLiquidity,
      cardinality,
      historySec,
      uiMultiplier: tokenState.uiMultiplier,
    };
  }

  /** Timestamp (s) of the oldest observation in the ring buffer (Uniswap Oracle.getSurroundingObservations). */
  private async oldestObservation(pool: Address, s: Slot0, blockNumber: bigint): Promise<number> {
    const card = Math.max(1, s.observationCardinality);
    const key = `${s.observationIndex}/${card}`;
    const hit = this.oldestCache.get(pool);
    if (hit && hit.key === key) return hit.ts;
    let o = await this.reader.observation(pool, (s.observationIndex + 1) % card, blockNumber);
    if (!o.initialized) o = await this.reader.observation(pool, 0, blockNumber);
    this.oldestCache.set(pool, { key, ts: o.blockTimestamp });
    return o.blockTimestamp;
  }
}

function fmtUsd(x: number): string {
  return `$${Math.round(x).toLocaleString("en-US")}`;
}
