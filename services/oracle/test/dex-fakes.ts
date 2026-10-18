// In-memory Uniswap v3 pool reader for the DEX TWAP confirm source (sources/dex-twap.ts).
import { WAD } from "@bookrunner/shared";
import { type Address, getAddress } from "viem";
import type { TokenState } from "../src/sources/chainlink";
import type { DexBlock, DexReader, ResolvedDexPool, Slot0 } from "../src/sources/dex-twap";

export const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");

/** Tick whose price is `tokenPrice` whole quote tokens per whole Stock Token (rounded to the nearest tick). */
export function tickFor(tokenPrice: number, tokenIsToken0: boolean, tokenDecimals = 18, quoteDecimals = 6): number {
  // raw token1 / raw token0
  const raw = tokenIsToken0 ? tokenPrice * 10 ** (quoteDecimals - tokenDecimals) : (1 / tokenPrice) * 10 ** (tokenDecimals - quoteDecimals);
  return Math.round(Math.log(raw) / Math.log(1.0001));
}

export interface FakePool {
  token0: Address;
  token1: Address;
  /** arithmetic-mean tick over any window */
  meanTick: number;
  spotTick: number;
  observationIndex: number;
  cardinality: number;
  /** blockTimestamp of the slot after observationIndex (the oldest), and whether it is initialized */
  oldestTs: number;
  oldestInitialized: boolean;
  /** blockTimestamp of slot 0 (used when the next slot is not initialized) */
  slot0Ts: number;
  quoteBalance: bigint;
  observeError: Error | null;
}

export class FakeDexReader implements DexReader {
  blockNow: DexBlock = { number: 1000n, timestamp: 1_790_000_000 };
  pools = new Map<string, FakePool>();
  tokens = new Map<string, TokenState>();
  quoteDecimals = 6;
  calls = { block: 0, observe: 0, observation: 0, poolTokens: 0 };
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
      quoteBalance: 500_000n * 10n ** BigInt(this.quoteDecimals),
      observeError: null,
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
  async decimals() {
    return this.quoteDecimals;
  }
  async slot0(a: Address, b: bigint): Promise<Slot0> {
    this.pinned.add(b);
    const p = this.pool(a);
    return { tick: p.spotTick, observationIndex: p.observationIndex, observationCardinality: p.cardinality };
  }
  async observation(a: Address, index: number, b: bigint) {
    this.pinned.add(b);
    this.calls.observation++;
    const p = this.pool(a);
    if (index === 0) return { blockTimestamp: p.slot0Ts, initialized: true };
    return { blockTimestamp: p.oldestInitialized ? p.oldestTs : 0, initialized: p.oldestInitialized };
  }
  async observe(a: Address, secondsAgos: readonly number[], b: bigint) {
    this.pinned.add(b);
    this.calls.observe++;
    const p = this.pool(a);
    if (p.observeError) throw p.observeError;
    const base = 123_456_789n;
    // tickCumulative grows by meanTick per second
    return secondsAgos.map((ago) => base - BigInt(p.meanTick) * BigInt(ago));
  }
  async balanceOf(_token: Address, owner: Address, b: bigint) {
    this.pinned.add(b);
    return this.pool(owner).quoteBalance;
  }
  async tokenState(token: Address) {
    const t = this.tokens.get(token.toLowerCase());
    if (!t) throw new Error("execution reverted (no token)");
    return t;
  }
}

export function dexPool(pool: Address, token: Address, over: Partial<ResolvedDexPool> = {}): ResolvedDexPool {
  return { pool, token, tokenDecimals: 18, quoteToken: USDG, twapSec: 600, minQuoteLiquidity: 50_000, ...over };
}
