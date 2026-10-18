// Uniswap v3 TWAP confirm source (kind "dex", name "dex-twap"): for each ticker the deepest Stock-Token / USDG pool
// of config/chains/<chainId>.json `dexConfirm.pools`. It CONFIRMS the Chainlink price under the primary-confirm
// policy (domain/confirm.ts) and is never a signing source: a manipulated pool can raise alerts, never move a price.
// Per observation, all reads pinned to one block (the latest, shared by every ticker of a tick):
//   - authenticity (once per pool, cached): factory.getPool(stockToken, quoteToken, fee) == pool (Uniswap's v3
//     factory for the chain, packages/shared uniswap.ts), and token0 / token1 are the Stock Token and the quote token;
//   - depth floor: the quote amount that moves the pool price 2% (DEPTH_MOVE_BPS) up or down within the active range,
//     from in-range liquidity() and sqrtPriceX96 (depth2PctQuote; the smaller direction), >= minDepthUsd (USDG
//     assumed = $1). Not balanceOf(pool): out-of-range positions, uncollected fees and donations would count there;
//   - observation history: the oldest observation (slot0 observationIndex + 1 mod cardinality, else index 0) must
//     be at least twapSec old, i.e. the ring buffer covers the window (otherwise observe() would revert "OLD");
//   - activity: the newest observation (written by the first swap of a block) must lie inside the window: a pool
//     with no swap in the window would return an old traded tick as a fresh TWAP;
//   - observe([twapSec, 0]) -> arithmetic-mean tick (rounded toward -inf, Uniswap OracleLibrary.consult) ->
//     price of one whole Stock Token in whole quote tokens (orientation from token0, decimals: token config, quote
//     decimals() read on-chain and cached);
//   - per share: divided by the token's uiMultiplier (read at the same block) exactly like the Chainlink per-token
//     feeds (tokenStateProblem, perSharePriceWad); no observation while oraclePaused() or when the multiplier changed
//     inside the window;
//   - ts = the block's timestamp (never the receive time).
import { perSharePriceWad, tickToPrice } from "@bookrunner/shared";
import { type Address, type PublicClient, erc20Abi, getAddress, parseAbi } from "viem";
import type { PriceSource, SourceObservation } from "../domain/types";
import { type TokenState, tokenStateProblem, viemAggregatorReader } from "./chainlink";

export const DEX_SOURCE_NAME = "dex-twap";
/** Price move the depth floor is measured at (bps). */
export const DEPTH_MOVE_BPS = 200;

/** A configured confirm pool, resolved (config.ts resolveDexPools). */
export interface ResolvedDexPool {
  pool: Address;
  /** the Stock Token (stockTokens[ticker].token) */
  token: Address;
  tokenDecimals: number;
  quoteToken: Address;
  fee: number;
  twapSec: number;
  /** depth floor: whole quote tokens (USD at the USDG = $1 assumption) moving the price DEPTH_MOVE_BPS */
  minDepthUsd: number;
}

export interface DexBlock {
  number: bigint;
  /** unix seconds */
  timestamp: number;
}

export interface Slot0 {
  sqrtPriceX96: bigint;
  tick: number;
  observationIndex: number;
  observationCardinality: number;
}

export interface DexReader {
  block(): Promise<DexBlock>;
  poolTokens(pool: Address): Promise<{ token0: Address; token1: Address }>;
  /** factory.getPool(tokenA, tokenB, fee) (zero address when none) */
  getPool(factory: Address, tokenA: Address, tokenB: Address, fee: number): Promise<Address>;
  decimals(token: Address): Promise<number>;
  slot0(pool: Address, blockNumber: bigint): Promise<Slot0>;
  /** in-range liquidity */
  liquidity(pool: Address, blockNumber: bigint): Promise<bigint>;
  observation(pool: Address, index: number, blockNumber: bigint): Promise<{ blockTimestamp: number; initialized: boolean }>;
  /** tickCumulatives for `secondsAgos` (reverts "OLD" when the history does not reach that far) */
  observe(pool: Address, secondsAgos: readonly number[], blockNumber: bigint): Promise<readonly bigint[]>;
  tokenState(token: Address, blockNumber: bigint): Promise<TokenState>;
}

export const uniswapV3OracleAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observations(uint256 index) view returns (uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
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
    async getPool(factory, a, b, fee) {
      return getAddress(await pub.readContract({ address: factory, abi: uniswapV3OracleAbi, functionName: "getPool", args: [a, b, fee] }));
    },
    async decimals(token) {
      return Number(await pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
    },
    async slot0(pool, blockNumber) {
      const s = await pub.readContract({ address: pool, abi: uniswapV3OracleAbi, functionName: "slot0", blockNumber });
      return { sqrtPriceX96: s[0], tick: Number(s[1]), observationIndex: Number(s[2]), observationCardinality: Number(s[3]) };
    },
    liquidity: (pool, blockNumber) => pub.readContract({ address: pool, abi: uniswapV3OracleAbi, functionName: "liquidity", blockNumber }),
    async observation(pool, index, blockNumber) {
      const o = await pub.readContract({ address: pool, abi: uniswapV3OracleAbi, functionName: "observations", args: [BigInt(index)], blockNumber });
      return { blockTimestamp: Number(o[0]), initialized: o[3] };
    },
    async observe(pool, secondsAgos, blockNumber) {
      const [cum] = await pub.readContract({ address: pool, abi: uniswapV3OracleAbi, functionName: "observe", args: [secondsAgos.map(Number)], blockNumber });
      return cum;
    },
    tokenState: (token, blockNumber) => tokens.tokenState(token, blockNumber),
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

/**
 * Whole quote tokens that move the pool price by `moveBps` within the active range (constant in-range liquidity L,
 * sqrtP = sqrtPriceX96 / 2^96 in raw token1/token0 units): quote = token1 -> L·sqrtP per unit of sqrt-price ratio,
 * quote = token0 -> L / sqrtP. Up (quote in) costs base·(r - 1), down (quote out) base·(1 - 1/r), r = sqrt(1 + move);
 * the smaller (down) is returned. Liquidity changing at an initialized tick inside the move is not modelled.
 */
export function depthQuote(liquidity: bigint, sqrtPriceX96: bigint, quoteIsToken0: boolean, quoteDecimals: number, moveBps = DEPTH_MOVE_BPS): number {
  if (liquidity <= 0n || sqrtPriceX96 <= 0n) return 0;
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
  const L = Number(liquidity);
  const base = quoteIsToken0 ? L / sqrtP : L * sqrtP;
  const r = Math.sqrt(1 + moveBps / 1e4);
  return Math.min(base * (r - 1), base * (1 - 1 / r)) / 10 ** quoteDecimals;
}

/** Float USD price -> WAD (8 decimals kept: PRICE_DECIMALS of every signed price). */
export function priceToWad(price: number): bigint {
  return BigInt(Math.round(price * 1e8)) * 10n ** 10n;
}

/** Per-share price from a per-token price and uiMultiplier (WAD), through the shared conversion. */
export function perSharePrice(tokenPrice: number, uiMultiplier: bigint): number {
  return Number(perSharePriceWad(priceToWad(tokenPrice), uiMultiplier)) / 1e18;
}

/** Diagnostics carried by every observation, usable or not (source-check, /health errors). */
export interface DexDiagnostics {
  /** quote tokens moving the price DEPTH_MOVE_BPS within the active range */
  depthQuote?: number;
  cardinality?: number;
  /** age of the oldest observation (s): how far back observe() can reach */
  historySec?: number;
  /** seconds since the newest observation (the last block with a swap) */
  lastSwapAgeSec?: number;
}

export type DexObservation =
  | ({
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
      uiMultiplier: bigint;
    } & Required<DexDiagnostics>)
  | ({ ok: false; reason: string } & DexDiagnostics);

export interface DexTwapOptions {
  /** observation max age (block time vs now) */
  maxAgeMs: number;
  /** Uniswap v3 factory of the chain: every pool must be its getPool(stockToken, quoteToken, fee); null = not checked */
  factory: Address | null;
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
  private readonly poolCheckCache = new Map<Address, Promise<{ tokenIsToken0: boolean } | { problem: string }>>();
  private readonly decimalsCache = new Map<Address, Promise<number>>();
  /** oldest / newest observation timestamps per (pool, observationIndex, cardinality): they move only with the index */
  private readonly ringCache = new Map<Address, { key: string; oldest: number; newest: number }>();
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

  /** Whether pools are checked against the factory (getPool(stockToken, quoteToken, fee) == pool). */
  factoryChecked(): boolean {
    return this.opts.factory !== null;
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

  /** factory.getPool(token, quote, fee) == pool and the pool's tokens (once per pool; a read error is retried). */
  private checkPool(p: ResolvedDexPool): Promise<{ tokenIsToken0: boolean } | { problem: string }> {
    return this.cached(this.poolCheckCache, p.pool, async () => {
      if (this.opts.factory) {
        const fromFactory = await this.reader.getPool(this.opts.factory, p.token, p.quoteToken, p.fee);
        if (fromFactory.toLowerCase() !== p.pool.toLowerCase()) {
          return { problem: `pool ${p.pool} is not the factory's pool for (Stock Token, quote token, fee ${p.fee}): getPool returned ${fromFactory}` };
        }
      }
      const t = await this.reader.poolTokens(p.pool);
      const t0 = t.token0.toLowerCase();
      const t1 = t.token1.toLowerCase();
      const tok = p.token.toLowerCase();
      const quote = p.quoteToken.toLowerCase();
      if (!((t0 === tok && t1 === quote) || (t0 === quote && t1 === tok))) {
        return { problem: `pool tokens ${t.token0} / ${t.token1} are not the Stock Token ${p.token} and the quote token ${p.quoteToken}` };
      }
      return { tokenIsToken0: t0 === tok };
    });
  }

  private async read(p: ResolvedDexPool): Promise<DexObservation> {
    const [block, check, quoteDecimals] = await Promise.all([
      this.block(),
      this.checkPool(p),
      this.cached(this.decimalsCache, p.quoteToken, () => this.reader.decimals(p.quoteToken)),
    ]);
    if ("problem" in check) return { ok: false, reason: check.problem };
    const { tokenIsToken0 } = check;

    const [slot0, liquidity, tokenState] = await Promise.all([
      this.reader.slot0(p.pool, block.number),
      this.reader.liquidity(p.pool, block.number),
      this.reader.tokenState(p.token, block.number),
    ]);
    const cardinality = slot0.observationCardinality;
    const depth = depthQuote(liquidity, slot0.sqrtPriceX96, !tokenIsToken0, quoteDecimals);
    const diag: DexDiagnostics = { depthQuote: depth, cardinality };
    if (depth < p.minDepthUsd) {
      return { ok: false, reason: `insufficient depth: ${fmtUsd(depth)} moves the price ${DEPTH_MOVE_BPS / 100}% (floor ${fmtUsd(p.minDepthUsd)})`, ...diag };
    }

    const ring = await this.ring(p.pool, slot0, block.number);
    diag.historySec = block.timestamp - ring.oldest;
    diag.lastSwapAgeSec = block.timestamp - ring.newest;
    if (diag.historySec < p.twapSec) {
      return {
        ok: false,
        reason: `observation history ${diag.historySec}s < TWAP window ${p.twapSec}s (cardinality ${cardinality}: increaseObservationCardinalityNext)`,
        ...diag,
      };
    }
    if (diag.lastSwapAgeSec >= p.twapSec) {
      return { ok: false, reason: `no swap in the ${p.twapSec}s TWAP window (last swap ${diag.lastSwapAgeSec}s ago): the TWAP would be an old trade`, ...diag };
    }

    const problem = tokenStateProblem(tokenState);
    if (problem) return { ok: false, reason: problem, ...diag };
    const eff = Number(tokenState.effectiveAt ?? 0n);
    if (eff > block.timestamp - p.twapSec && eff <= block.timestamp) {
      return { ok: false, reason: `uiMultiplier changed at ${eff}, inside the ${p.twapSec}s TWAP window`, ...diag };
    }

    let cum: readonly bigint[];
    try {
      cum = await this.reader.observe(p.pool, [p.twapSec, 0], block.number);
    } catch (e) {
      return { ok: false, reason: `observe([${p.twapSec}, 0]) failed: ${errMsg(e)}`, ...diag };
    }
    if (cum.length !== 2) return { ok: false, reason: `observe returned ${cum.length} values`, ...diag };
    const meanTick = arithmeticMeanTick(cum[0] as bigint, cum[1] as bigint, p.twapSec);
    const tokenPrice = tokenPriceAtTick(meanTick, tokenIsToken0, p.tokenDecimals, quoteDecimals);
    if (!Number.isFinite(tokenPrice) || tokenPrice <= 0) return { ok: false, reason: `TWAP price ${tokenPrice} not usable`, ...diag };
    return {
      ok: true,
      price: perSharePrice(tokenPrice, tokenState.uiMultiplier),
      tokenPrice,
      spotTokenPrice: tokenPriceAtTick(slot0.tick, tokenIsToken0, p.tokenDecimals, quoteDecimals),
      meanTick,
      twapSec: p.twapSec,
      ts: block.timestamp * 1000,
      uiMultiplier: tokenState.uiMultiplier,
      depthQuote: depth,
      cardinality,
      historySec: diag.historySec,
      lastSwapAgeSec: diag.lastSwapAgeSec,
    };
  }

  /**
   * Timestamps (s) of the oldest observation in the ring buffer (Uniswap Oracle.getSurroundingObservations) and of
   * the newest one (observationIndex: the last block with a swap).
   */
  private async ring(pool: Address, s: Slot0, blockNumber: bigint): Promise<{ oldest: number; newest: number }> {
    const card = Math.max(1, s.observationCardinality);
    const key = `${s.observationIndex}/${card}`;
    const hit = this.ringCache.get(pool);
    if (hit && hit.key === key) return hit;
    const [next, newest] = await Promise.all([
      this.reader.observation(pool, (s.observationIndex + 1) % card, blockNumber),
      this.reader.observation(pool, s.observationIndex, blockNumber),
    ]);
    const oldest = next.initialized ? next : await this.reader.observation(pool, 0, blockNumber);
    const r = { key, oldest: oldest.blockTimestamp, newest: newest.blockTimestamp };
    this.ringCache.set(pool, r);
    return r;
  }
}

function fmtUsd(x: number): string {
  return `$${Math.round(x).toLocaleString("en-US")}`;
}
