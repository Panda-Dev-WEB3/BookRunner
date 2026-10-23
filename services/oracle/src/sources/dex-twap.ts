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
// RPC budget (deploy/server/MAINNET.md "RPC budget"): one pass reads every pool of the tick: the block, then ONE
// Multicall3 aggregate3 at that block (slot0, liquidity, observe, the token's four views, per pool; allowFailure), and
// a second one only for the pools whose observation index moved (ring buffer timestamps). `readIntervalMs`
// (ORACLE_DEX_READ_MS) reuses a pass that recent; its observations keep their block timestamp, so maxAgeMs
// (ORACLE_DEX_MAX_AGE_MS) must exceed it.
import { perSharePriceWad, tickToPrice } from "@bookrunner/shared";
import { type Address, type PublicClient, erc20Abi, getAddress, parseAbi } from "viem";
import type { PriceSource, SourceObservation } from "../domain/types";
import { READ_RETRY_MS, type Settled, TOKEN_STATE_VIEWS, type TokenState, settledErr, settledOk, stockTokenAbi, tokenStateFromViews, tokenStateProblem, viemAggregatorReader } from "./chainlink";

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
  /** Every pool read of a pass in one batched call at `blockNumber`. Absent: per-call reads (readPoolsPerCall). */
  readPools?(pools: readonly DexPoolRequest[], blockNumber: bigint): Promise<Map<Address, DexPoolRead>>;
  /** Ring-buffer observations of a pass in one batched call at `blockNumber`, keyed `${pool}:${index}` (lowercase pool). */
  readObservations?(reqs: readonly { pool: Address; index: number }[], blockNumber: bigint): Promise<Map<string, Settled<{ blockTimestamp: number; initialized: boolean }>>>;
}

export interface DexPoolRequest {
  pool: Address;
  token: Address;
  twapSec: number;
}

export interface DexPoolRead {
  slot0: Settled<Slot0>;
  liquidity: Settled<bigint>;
  /** observe([twapSec, 0]) tickCumulatives */
  observe: Settled<readonly bigint[]>;
  tokenState: Settled<TokenState>;
}

const settle = <T>(p: Promise<T>): Promise<Settled<T>> => p.then(settledOk<T>, settledErr<T>);

/** The pool reads of a pass through the per-call reads (tests, chains without Multicall3). */
export async function readPoolsPerCall(r: DexReader, pools: readonly DexPoolRequest[], blockNumber: bigint): Promise<Map<Address, DexPoolRead>> {
  const rows = await Promise.all(
    pools.map(async (p) => {
      const [slot0, liquidity, observe, tokenState] = await Promise.all([
        settle(r.slot0(p.pool, blockNumber)),
        settle(r.liquidity(p.pool, blockNumber)),
        settle(r.observe(p.pool, [p.twapSec, 0], blockNumber)),
        settle(r.tokenState(p.token, blockNumber)),
      ]);
      return [p.pool, { slot0, liquidity, observe, tokenState }] as const;
    }),
  );
  return new Map(rows);
}

const obsKey = (pool: Address, index: number) => `${pool.toLowerCase()}:${index}`;

export const uniswapV3OracleAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observations(uint256 index) view returns (uint32 blockTimestamp, int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, bool initialized)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);

/**
 * Reads through viem; every pool read pinned to the block of the tick. `multicall` (Multicall3 address, shared
 * multicall3For): the pool reads of a pass are one aggregate3 eth_call (and the moved ring observations a second);
 * null: per-call reads (devnet / testnet, unchanged).
 */
export function viemDexReader(pub: PublicClient, multicall: Address | null = null): DexReader {
  const tokens = viemAggregatorReader(pub);
  const rows = async (contracts: Parameters<PublicClient["multicall"]>[0]["contracts"], blockNumber: bigint): Promise<Settled<unknown>[]> => {
    const res = await pub.multicall({ contracts, allowFailure: true, blockNumber, multicallAddress: multicall as Address, batchSize: 0 });
    return res.map((r) => (r.status === "success" ? settledOk(r.result as unknown) : settledErr(r.error)));
  };
  const multicalled: Pick<DexReader, "readPools" | "readObservations"> = multicall
    ? {
        async readPools(pools, blockNumber) {
          const out = new Map<Address, DexPoolRead>();
          const res = await rows(
            pools.flatMap((p) => [
              { address: p.pool, abi: uniswapV3OracleAbi, functionName: "slot0" },
              { address: p.pool, abi: uniswapV3OracleAbi, functionName: "liquidity" },
              { address: p.pool, abi: uniswapV3OracleAbi, functionName: "observe", args: [[p.twapSec, 0]] },
              ...TOKEN_STATE_VIEWS.map((functionName) => ({ address: p.token, abi: stockTokenAbi, functionName })),
            ]),
            blockNumber,
          );
          let i = 0;
          const next = () => res[i++] ?? settledErr<unknown>(new Error("multicall result missing"));
          for (const p of pools) {
            const s0 = next();
            const liq = next();
            const obs = next();
            const tokenState = tokenStateFromViews(TOKEN_STATE_VIEWS.map(() => next()));
            const slot0: Settled<Slot0> = s0.ok
              ? (() => {
                  const s = s0.value as readonly [bigint, number, number, number];
                  return settledOk({ sqrtPriceX96: s[0], tick: Number(s[1]), observationIndex: Number(s[2]), observationCardinality: Number(s[3]) });
                })()
              : s0;
            out.set(p.pool, {
              slot0,
              liquidity: liq.ok ? settledOk(liq.value as bigint) : liq,
              observe: obs.ok ? settledOk((obs.value as readonly [readonly bigint[], unknown])[0]) : obs,
              tokenState,
            });
          }
          return out;
        },
        async readObservations(reqs, blockNumber) {
          const res = await rows(
            reqs.map((r) => ({ address: r.pool, abi: uniswapV3OracleAbi, functionName: "observations", args: [BigInt(r.index)] })),
            blockNumber,
          );
          return new Map(
            reqs.map((r, i) => {
              const s = res[i] ?? settledErr<unknown>(new Error("multicall result missing"));
              const o = s.ok ? (s.value as readonly [number, bigint, bigint, boolean]) : null;
              return [obsKey(r.pool, r.index), o ? settledOk({ blockTimestamp: Number(o[0]), initialized: o[3] }) : (s as Settled<never>)] as const;
            }),
          );
        },
      }
    : {};
  return {
    ...multicalled,
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
  /** a pass started less than this ago is reused by every ticker (ORACLE_DEX_READ_MS; 0 = a pass per tick) */
  readIntervalMs?: number;
  /** every pass reports its block timestamp here (the oracle's HeadClock) */
  onBlockTimestamp?: (tsSec: number) => void;
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
  /** the current pass (every ticker's observation), shared while in flight or younger than readIntervalMs */
  private pass: { startedAt: number; promise: Promise<Map<string, DexObservation>>; done: boolean; failed: boolean } | null = null;
  /** completed passes (tests) */
  passes = 0;

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
      const all = await this.currentPass(this.now());
      return all.get(ticker) ?? { ok: false, reason: "pool not read" };
    } catch (e) {
      return { ok: false, reason: `pool not readable: ${errMsg(e)}` };
    }
  }

  /** The pass this observation uses: the current one when in flight or fresh, else a new one (every pool at one block). */
  private currentPass(nowMs: number): Promise<Map<string, DexObservation>> {
    const p = this.pass;
    const interval = Math.max(0, this.opts.readIntervalMs ?? 0);
    if (p && (!p.done || nowMs - p.startedAt < (p.failed ? Math.min(interval, READ_RETRY_MS) : interval))) return p.promise;
    const entry = { startedAt: nowMs, promise: null as unknown as Promise<Map<string, DexObservation>>, done: false, failed: false };
    entry.promise = this.readAll().then(
      (r) => {
        entry.done = true;
        this.passes++;
        return r;
      },
      (e: unknown) => {
        entry.done = true;
        entry.failed = true;
        throw e;
      },
    );
    this.pass = entry;
    return entry.promise;
  }

  /** One pass: the block, the per-pool checks (cached), one batched read of every usable pool, the moved rings. */
  private async readAll(): Promise<Map<string, DexObservation>> {
    const tickers = Object.keys(this.pools);
    const [block, prep] = await Promise.all([
      this.reader.block(),
      Promise.all(
        tickers.map(async (t) => {
          const p = this.pools[t] as ResolvedDexPool;
          try {
            const [check, quoteDecimals] = await Promise.all([this.checkPool(p), this.cached(this.decimalsCache, p.quoteToken, () => this.reader.decimals(p.quoteToken))]);
            return { t, p, check, quoteDecimals, error: null };
          } catch (e) {
            return { t, p, check: null, quoteDecimals: 0, error: e };
          }
        }),
      ),
    ]);
    this.opts.onBlockTimestamp?.(block.timestamp);
    const out = new Map<string, DexObservation>();
    const usable: Array<{ t: string; p: ResolvedDexPool; tokenIsToken0: boolean; quoteDecimals: number }> = [];
    for (const x of prep) {
      if (x.error !== null || !x.check) out.set(x.t, { ok: false, reason: `pool not readable: ${errMsg(x.error)}` });
      else if ("problem" in x.check) out.set(x.t, { ok: false, reason: x.check.problem });
      else usable.push({ t: x.t, p: x.p, tokenIsToken0: x.check.tokenIsToken0, quoteDecimals: x.quoteDecimals });
    }
    if (usable.length === 0) return out;
    const req = usable.map((u) => ({ pool: u.p.pool, token: u.p.token, twapSec: u.p.twapSec }));
    const reads = this.reader.readPools ? await this.reader.readPools(req, block.number) : await readPoolsPerCall(this.reader, req, block.number);
    // ring buffer timestamps: one batched read for every pool whose observation index moved since the cached one
    const moved = usable.flatMap((u) => {
      const s0 = reads.get(u.p.pool)?.slot0;
      return s0?.ok && !this.ringHit(u.p.pool, s0.value) ? [{ pool: u.p.pool, slot0: s0.value }] : [];
    });
    if (moved.length > 0) await this.readRings(moved, block.number);
    for (const u of usable) {
      const r = reads.get(u.p.pool);
      try {
        if (!r) throw new Error("pool not read");
        out.set(u.t, this.evaluate(u.p, u.tokenIsToken0, u.quoteDecimals, block, r));
      } catch (e) {
        out.set(u.t, { ok: false, reason: `pool not readable: ${errMsg(e)}` });
      }
    }
    return out;
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

  /** One pool's observation from the pass's reads (the checks in their historical order; throws = not readable). */
  private evaluate(p: ResolvedDexPool, tokenIsToken0: boolean, quoteDecimals: number, block: DexBlock, r: DexPoolRead): DexObservation {
    const value = <T>(s: Settled<T>): T => {
      if (!s.ok) throw s.error;
      return s.value;
    };
    const slot0 = value(r.slot0);
    const liquidity = value(r.liquidity);
    const tokenState = value(r.tokenState);
    const cardinality = slot0.observationCardinality;
    const depth = depthQuote(liquidity, slot0.sqrtPriceX96, !tokenIsToken0, quoteDecimals);
    const diag: DexDiagnostics = { depthQuote: depth, cardinality };
    if (depth < p.minDepthUsd) {
      return { ok: false, reason: `insufficient depth: ${fmtUsd(depth)} moves the price ${DEPTH_MOVE_BPS / 100}% (floor ${fmtUsd(p.minDepthUsd)})`, ...diag };
    }

    const ring = this.ringCache.get(p.pool);
    if (!ring || !this.ringHit(p.pool, slot0)) throw new Error("observation ring not read");
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

    if (!r.observe.ok) return { ok: false, reason: `observe([${p.twapSec}, 0]) failed: ${errMsg(r.observe.error)}`, ...diag };
    const cum = r.observe.value;
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
  private ringHit(pool: Address, s: Slot0): boolean {
    return this.ringCache.get(pool)?.key === ringKey(s);
  }

  /**
   * Reads the ring timestamps of the pools whose observation index moved. Batched reader: one call with the next,
   * newest and slot-0 observations of every such pool (slot 0 read speculatively: it is the oldest while the ring is
   * not full). Per-call reader: next + newest, then slot 0 only when the next slot is not initialized (as before).
   * A pool whose observations are not readable is left uncached (its observation fails this pass).
   */
  private async readRings(pools: Array<{ pool: Address; slot0: Slot0 }>, blockNumber: bigint): Promise<void> {
    const at = pools.map(({ pool, slot0 }) => {
      const card = Math.max(1, slot0.observationCardinality);
      return { pool, slot0, key: ringKey(slot0), next: (slot0.observationIndex + 1) % card, newest: slot0.observationIndex };
    });
    if (this.reader.readObservations) {
      const res = await this.reader.readObservations(
        at.flatMap((a) => [
          { pool: a.pool, index: a.next },
          { pool: a.pool, index: a.newest },
          { pool: a.pool, index: 0 },
        ]),
        blockNumber,
      );
      for (const a of at) {
        const next = res.get(obsKey(a.pool, a.next));
        const newest = res.get(obsKey(a.pool, a.newest));
        const zero = res.get(obsKey(a.pool, 0));
        if (!next?.ok || !newest?.ok) continue;
        const oldest = next.value.initialized ? next.value : zero?.ok ? zero.value : null;
        if (oldest) this.ringCache.set(a.pool, { key: a.key, oldest: oldest.blockTimestamp, newest: newest.value.blockTimestamp });
      }
      return;
    }
    await Promise.all(
      at.map(async (a) => {
        try {
          const [next, newest] = await Promise.all([this.reader.observation(a.pool, a.next, blockNumber), this.reader.observation(a.pool, a.newest, blockNumber)]);
          const oldest = next.initialized ? next : await this.reader.observation(a.pool, 0, blockNumber);
          this.ringCache.set(a.pool, { key: a.key, oldest: oldest.blockTimestamp, newest: newest.blockTimestamp });
        } catch {
          // left uncached: this pool's observation is "not readable" this pass, re-read next pass
        }
      }),
    );
  }
}

const ringKey = (s: Slot0) => `${s.observationIndex}/${Math.max(1, s.observationCardinality)}`;

function fmtUsd(x: number): string {
  return `$${Math.round(x).toLocaleString("en-US")}`;
}
