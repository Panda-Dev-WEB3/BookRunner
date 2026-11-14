// In-memory Uniswap v3 pool reader for the DEX TWAP confirm source (sources/dex-twap.ts).
import { WAD } from "@bookrunner/shared";
import { type Address, getAddress } from "viem";
import type { TokenState } from "../src/sources/chainlink";
import { type DexBlock, type DexReader, type ResolvedDexPool, type Slot0, depthQuote } from "../src/sources/dex-twap";

export const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
export const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
export const FACTORY = getAddress("0x1f7d7550b1b028f7571e69a784071f0205fd2efa");

/** sqrtPriceX96 at a tick (float precision; enough for depth tests). */
export function sqrtPriceX96At(tick: number): bigint {
  return BigInt(Math.round(Math.sqrt(1.0001 ** tick) * 2 ** 96));
}

/** In-range liquidity whose 2% depth (depthQuote) is `depthUsd` quote tokens. */
export function liquidityForDepth(depthUsd: number, sqrtPriceX96: bigint, quoteIsToken0: boolean, quoteDecimals = 6): bigint {
  const unit = depthQuote(10n ** 24n, sqrtPriceX96, quoteIsToken0, quoteDecimals);
  return BigInt(Math.round((depthUsd / unit) * 1e12)) * 10n ** 12n;
}

/** Tick whose price is `tokenPrice` whole quote tokens per whole Stock Token (rounded to the nearest tick). */
export function tickFor(tokenPrice: number, tokenIsToken0: boolean, tokenDecimals = 18, quoteDecimals = 6): number {
  // raw token1 / raw token0
  const raw = tokenIsToken0 ? tokenPrice * 10 ** (quoteDecimals - tokenDecimals) : (1 / tokenPrice) * 10 ** (tokenDecimals - quoteDecimals);
  return Math.round(Math.log(raw) / Math.log(1.0001));
}

export interface FakePool {
  token0: Address;
  token1: Address;
  /** arithmetic-mean tick over any window (unless meanTickByWindow names it) */
  meanTick: number;
  /** a different mean tick per window (s) */
  meanTickByWindow: Record<number, number>;
  spotTick: number;
  observationIndex: number;
  cardinality: number;
  /** blockTimestamp of the slot after observationIndex (the oldest), and whether it is initialized */
  oldestTs: number;
  oldestInitialized: boolean;
  /** blockTimestamp of slot 0 (used when the next slot is not initialized) */
  slot0Ts: number;
  /** blockTimestamp of the newest observation (observationIndex): the last block with a swap */
  newestTs: number;
  /** quote tokens moving the price 2% NOW (sets liquidity()): USD for a USDG pool, WETH for a WETH pool */
  depthUsd: number;
  /** the same over the window (sets the harmonic-mean liquidity through secondsPerLiquidityCumulativeX128); default depthUsd */
  twapDepthUsd: number | null;
  /** the pool's quote token (default USDG; WETH for a Stock-Token / WETH pool, USDG for the ETH/USD leg) */
  quote: Address;
  /** fee tier the fake factory registers the pool under */
  fee: number;
  observeError: Error | null;
}

export class FakeDexReader implements DexReader {
  blockNow: DexBlock = { number: 1000n, timestamp: 1_790_000_000 };
  pools = new Map<string, FakePool>();
  tokens = new Map<string, TokenState>();
  quoteDecimals = 6;
  /** decimals() per token (lowercase); default: WETH 18, anything else quoteDecimals */
  decimalsOf = new Map<string, number>([[WETH.toLowerCase(), 18]]);
  calls = { block: 0, observe: 0, observation: 0, poolTokens: 0, getPool: 0 };
  /** every observe() call: pool (lowercase) and secondsAgos */
  observed: Array<{ pool: string; secondsAgos: readonly number[] }> = [];
  /** factory.getPool answers: key token|quote|fee (lowercase) -> pool; default the pool whose tokens match */
  factoryPools = new Map<string, Address>();
  /** block numbers every pinned read used */
  pinned = new Set<bigint>();

  addPool(addr: Address, p: Partial<FakePool> & Pick<FakePool, "token0" | "token1" | "meanTick">): void {
    this.pools.set(addr.toLowerCase(), {
      spotTick: p.meanTick,
      observationIndex: 10,
      cardinality: 7200,
      oldestTs: this.blockNow.timestamp - 86_400,
      oldestInitialized: true,
      slot0Ts: this.blockNow.timestamp - 86_400,
      newestTs: this.blockNow.timestamp - 30,
      depthUsd: 500_000,
      fee: 3000,
      observeError: null,
      quote: USDG,
      meanTickByWindow: {},
      twapDepthUsd: null,
      ...p,
    });
  }
  setToken(token: Address, s: Partial<TokenState> = {}): void {
    this.tokens.set(token.toLowerCase(), { uiMultiplier: WAD, newUIMultiplier: null, effectiveAt: null, oraclePaused: false, ...s });
  }
  private pool(a: Address): FakePool {
    const p = this.pools.get(a.toLowerCase());
    if (!p) throw new Error("execution reverted (no pool)");
    return p;
  }
  async block() {
    this.calls.block++;
    return this.blockNow;
  }
  async poolTokens(a: Address) {
    this.calls.poolTokens++;
    const p = this.pool(a);
    return { token0: p.token0, token1: p.token1 };
  }
  async decimals(token: Address) {
    return this.decimalsOf.get(token.toLowerCase()) ?? this.quoteDecimals;
  }
  async getPool(_factory: Address, a: Address, b: Address, fee: number) {
    this.calls.getPool++;
    const k = `${[a.toLowerCase(), b.toLowerCase()].sort().join("|")}|${fee}`;
    const hit = this.factoryPools.get(k);
    if (hit) return hit;
    for (const [addr, p] of this.pools) {
      if (`${[p.token0.toLowerCase(), p.token1.toLowerCase()].sort().join("|")}|${p.fee}` === k) return getAddress(addr);
    }
    return getAddress("0x0000000000000000000000000000000000000000");
  }
  async slot0(a: Address, b: bigint): Promise<Slot0> {
    this.pinned.add(b);
    const p = this.pool(a);
    return { sqrtPriceX96: sqrtPriceX96At(p.spotTick), tick: p.spotTick, observationIndex: p.observationIndex, observationCardinality: p.cardinality };
  }
  async liquidity(a: Address, b: bigint) {
    this.pinned.add(b);
    const p = this.pool(a);
    return liquidityForDepth(p.depthUsd, sqrtPriceX96At(p.spotTick), p.token0.toLowerCase() === p.quote.toLowerCase(), await this.decimals(p.quote));
  }
  async observation(a: Address, index: number, b: bigint) {
    this.pinned.add(b);
    this.calls.observation++;
    const p = this.pool(a);
    if (index === p.observationIndex) return { blockTimestamp: p.newestTs, initialized: true };
    if (index === 0) return { blockTimestamp: p.slot0Ts, initialized: true };
    return { blockTimestamp: p.oldestInitialized ? p.oldestTs : 0, initialized: p.oldestInitialized };
  }
  async observe(a: Address, secondsAgos: readonly number[], b: bigint) {
    this.pinned.add(b);
    this.calls.observe++;
    this.observed.push({ pool: a.toLowerCase(), secondsAgos });
    const p = this.pool(a);
    if (p.observeError) throw p.observeError;
    const base = 123_456_789n;
    const mean = (ago: number) => p.meanTickByWindow[ago] ?? p.meanTick;
    // the harmonic-mean liquidity whose depth at the mean tick is twapDepthUsd
    const lAvg = async (ago: number) =>
      liquidityForDepth(p.twapDepthUsd ?? p.depthUsd, sqrtPriceX96At(mean(ago)), p.token0.toLowerCase() === p.quote.toLowerCase(), await this.decimals(p.quote));
    const spl: bigint[] = [];
    for (const ago of secondsAgos) {
      const l = await lAvg(ago);
      spl.push(ago === 0 ? 10n ** 40n : 10n ** 40n - (l > 0n ? (BigInt(ago) << 128n) / l : 10n ** 39n));
    }
    // tickCumulative grows by the window's mean tick per second
    return { tickCumulatives: secondsAgos.map((ago) => base - BigInt(mean(ago)) * BigInt(ago)), secondsPerLiquidityCumulativeX128s: spl };
  }
  async tokenState(token: Address, b: bigint) {
    this.pinned.add(b);
    const t = this.tokens.get(token.toLowerCase());
    if (!t) throw new Error("execution reverted (no token)");
    return t;
  }
}

export function dexPool(pool: Address, token: Address, over: Partial<ResolvedDexPool> = {}): ResolvedDexPool {
  return { pool, token, tokenDecimals: 18, quoteToken: USDG, quote: "usd", fee: 3000, twapSec: 600, minDepthUsd: 50_000, ...over };
}
