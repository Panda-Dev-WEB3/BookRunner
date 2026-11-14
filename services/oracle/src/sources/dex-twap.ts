// Uniswap v3 TWAP confirm source (kind "dex", name "dex-twap"): for each ticker the confirm pools of
// config/chains/<chainId>.json `dexConfirm.pools` (Stock-Token / USDG, and Stock-Token / WETH through the
// `dexConfirm.ethUsd` WETH / USDG leg). It CONFIRMS the Chainlink price under the primary-confirm policy
// (domain/confirm.ts) and is never a signing source: a manipulated pool can raise alerts, never move a price.
// Per pool, all reads pinned to one block (the latest, shared by every ticker of a tick):
//   - authenticity (once per pool, cached): factory.getPool(stockToken, quoteToken, fee) == pool (Uniswap's v3
//     factory for the chain, packages/shared uniswap.ts), and token0 / token1 are the Stock Token and the quote token;
//     the ETH/USD leg the same way (getPool(WETH, USDG, fee), its tokens WETH and USDG);
//   - observation history: the oldest observation (slot0 observationIndex + 1 mod cardinality, else index 0) must
//     be at least twapSec old, i.e. the ring buffer covers the window (otherwise observe() would revert "OLD");
//   - activity: the newest observation (written by the first swap of a block) must lie inside the window: a pool
//     with no swap in the window would return an old traded tick as a fresh TWAP;
//   - observe([twapSec, 0]) -> arithmetic-mean tick (rounded toward -inf, Uniswap OracleLibrary.consult) ->
//     price of one whole Stock Token in whole quote tokens (orientation from token0, decimals: token config, quote
//     decimals() read on-chain and cached); a WETH quote times the leg's WETH / USD TWAP over the SAME window (both
//     geometric means, so the product is the TWAP of the stock / USD cross); the leg must pass its own depth floor,
//     history and last-swap checks, per window;
//   - depth: the quote amount that moves the pool price 2% (DEPTH_MOVE_BPS) within the active range (depthQuote; the
//     smaller direction), in USD (USDG assumed = $1; a WETH amount valued at the leg's TWAP). The FLOOR (minDepthUsd)
//     uses the time-averaged depth: the harmonic-mean in-range liquidity over the window (the same observe() call's
//     secondsPerLiquidityCumulativeX128, OracleLibrary.consult) at the mean tick, so one manipulated block (spot
//     pushed into a sparse range) cannot knock a pool out. The combining WEIGHT is min(current, time-averaged) depth,
//     so a narrow position added for the read block cannot buy the weight either. Not balanceOf(pool): out-of-range
//     positions, uncollected fees and donations would count there;
//   - per share: divided by the token's uiMultiplier (read at the same block) exactly like the Chainlink per-token
//     feeds (tokenStateProblem, perSharePriceWad), whatever the quote; no observation while oraclePaused() or when the
//     multiplier changed inside the window;
//   - ts = the block's timestamp (never the receive time).
// Several pools per ticker (combineDexPools): the confirm is available while at least one pool is usable (every
// check above passed). Its reported value is the weighted median of the usable pools; every usable pool's price goes
// along (SourceObservation.parts) and domain/confirm.ts flags a divergence when ANY of them is beyond the band, so
// "confirmed" means every usable pool agrees, and hiding a divergence takes manipulating every pool. The WETH pools
// share the one ETH/USD leg: their combined weight is capped at the leg's own weight.
// RPC budget (deploy/server/MAINNET.md "RPC budget"): one pass reads every pool of the tick: the block, then ONE
// Multicall3 aggregate3 at that block (slot0, liquidity, observe per pool and per leg window; the four token views
// once per Stock Token; allowFailure), and a second one only for the pools whose observation index moved (ring buffer
// timestamps). `readIntervalMs` (ORACLE_DEX_READ_MS) reuses a pass that recent; its observations keep their block
// timestamp, so maxAgeMs (ORACLE_DEX_MAX_AGE_MS) must exceed it.
import { perSharePriceWad, tickToPrice } from "@bookrunner/shared";
import { type Address, type PublicClient, erc20Abi, getAddress, parseAbi } from "viem";
import type { PriceSource, SourceObservation } from "../domain/types";
import { READ_RETRY_MS, type Settled, TOKEN_STATE_VIEWS, type TokenState, settledErr, settledOk, stockTokenAbi, tokenStateFromViews, tokenStateProblem, viemAggregatorReader } from "./chainlink";

export const DEX_SOURCE_NAME = "dex-twap";
/** Price move the depth floor is measured at (bps). */
export const DEPTH_MOVE_BPS = 200;

/** usd: the quote token is the USD stable (USDG, assumed $1); eth: WETH, priced through the ETH/USD leg. */
export type DexQuote = "usd" | "eth";

/** A configured confirm pool, resolved (config.ts resolveDexPools). */
export interface ResolvedDexPool {
  pool: Address;
  /** the Stock Token (stockTokens[ticker].token) */
  token: Address;
  tokenDecimals: number;
  quoteToken: Address;
  /** how the quote token converts to USD */
  quote: DexQuote;
  fee: number;
  twapSec: number;
  /** depth floor: USD moving the price DEPTH_MOVE_BPS over the window (USDG = $1; WETH at the ETH/USD leg's TWAP) */
  minDepthUsd: number;
}

/** The WETH / USD leg of the WETH-quoted pools (config.ts resolveDexEthUsd). */
export interface ResolvedEthUsdLeg {
  pool: Address;
  weth: Address;
  /** USD quote token (USDG, assumed $1) */
  quoteToken: Address;
  fee: number;
  /** 2% depth floor of the leg (USD, time-averaged over each window) */
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

/** observe(secondsAgos): Uniswap's two cumulative arrays, one entry per secondsAgo. */
export interface ObserveResult {
  tickCumulatives: readonly bigint[];
  secondsPerLiquidityCumulativeX128s: readonly bigint[];
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
  /** cumulatives for `secondsAgos` (reverts "OLD" when the history does not reach that far) */
  observe(pool: Address, secondsAgos: readonly number[], blockNumber: bigint): Promise<ObserveResult>;
  tokenState(token: Address, blockNumber: bigint): Promise<TokenState>;
  /** Every pool and token read of a pass in one batched call at `blockNumber`. Absent: per-call reads (readPassPerCall). */
  readPass?(pools: readonly DexPoolRequest[], tokens: readonly Address[], blockNumber: bigint): Promise<DexPassReads>;
  /** Ring-buffer observations of a pass in one batched call at `blockNumber`, keyed `${pool}:${index}` (lowercase pool). */
  readObservations?(reqs: readonly { pool: Address; index: number }[], blockNumber: bigint): Promise<Map<string, Settled<{ blockTimestamp: number; initialized: boolean }>>>;
}

export interface DexPoolRequest {
  pool: Address;
  /** one observe([w, 0]) per window: [twapSec] for a Stock Token pool, every window of its WETH pools for the leg */
  windows: readonly number[];
}

export interface DexPoolRead {
  slot0: Settled<Slot0>;
  liquidity: Settled<bigint>;
  /** per window: observe([window, 0]) */
  observe: Map<number, Settled<ObserveResult>>;
}

/** One pass's reads: per pool (lowercase address) and per Stock Token (lowercase address; once per token). */
export interface DexPassReads {
  pools: Map<string, DexPoolRead>;
  tokens: Map<string, Settled<TokenState>>;
}

const settle = <T>(p: Promise<T>): Promise<Settled<T>> => p.then(settledOk<T>, settledErr<T>);
const lc = (a: Address) => a.toLowerCase();

/** The reads of a pass through the per-call reads (tests, chains without Multicall3). */
export async function readPassPerCall(r: DexReader, pools: readonly DexPoolRequest[], tokens: readonly Address[], blockNumber: bigint): Promise<DexPassReads> {
  const [poolRows, tokenRows] = await Promise.all([
    Promise.all(
      pools.map(async (p) => {
        const [slot0, liquidity, ...obs] = await Promise.all([
          settle(r.slot0(p.pool, blockNumber)),
          settle(r.liquidity(p.pool, blockNumber)),
          ...p.windows.map((w) => settle(r.observe(p.pool, [w, 0], blockNumber))),
        ]);
        const observe = new Map(p.windows.map((w, i) => [w, obs[i] as Settled<ObserveResult>]));
        return [lc(p.pool), { slot0: slot0 as Settled<Slot0>, liquidity: liquidity as Settled<bigint>, observe }] as const;
      }),
    ),
    Promise.all(tokens.map(async (t) => [lc(t), await settle(r.tokenState(t, blockNumber))] as const)),
  ]);
  return { pools: new Map(poolRows), tokens: new Map(tokenRows) };
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
 * multicall3For): the pool and token reads of a pass are one aggregate3 eth_call (and the moved ring observations a
 * second); null: per-call reads (devnet / testnet, unchanged).
 */
export function viemDexReader(pub: PublicClient, multicall: Address | null = null): DexReader {
  const tokens = viemAggregatorReader(pub);
  const rows = async (contracts: Parameters<PublicClient["multicall"]>[0]["contracts"], blockNumber: bigint): Promise<Settled<unknown>[]> => {
    const res = await pub.multicall({ contracts, allowFailure: true, blockNumber, multicallAddress: multicall as Address, batchSize: 0 });
    return res.map((r) => (r.status === "success" ? settledOk(r.result as unknown) : settledErr(r.error)));
  };
  const observeResult = (v: unknown): ObserveResult => {
    const [tickCumulatives, secondsPerLiquidityCumulativeX128s] = v as readonly [readonly bigint[], readonly bigint[]];
    return { tickCumulatives, secondsPerLiquidityCumulativeX128s };
  };
  const multicalled: Pick<DexReader, "readPass" | "readObservations"> = multicall
    ? {
        async readPass(pools, toks, blockNumber) {
          const res = await rows(
            [
              ...pools.flatMap((p) => [
                { address: p.pool, abi: uniswapV3OracleAbi, functionName: "slot0" },
                { address: p.pool, abi: uniswapV3OracleAbi, functionName: "liquidity" },
                ...p.windows.map((w) => ({ address: p.pool, abi: uniswapV3OracleAbi, functionName: "observe", args: [[w, 0]] })),
              ]),
              ...toks.flatMap((t) => TOKEN_STATE_VIEWS.map((functionName) => ({ address: t, abi: stockTokenAbi, functionName }))),
            ],
            blockNumber,
          );
          let i = 0;
          const next = () => res[i++] ?? settledErr<unknown>(new Error("multicall result missing"));
          const out: DexPassReads = { pools: new Map(), tokens: new Map() };
          for (const p of pools) {
            const s0 = next();
            const liq = next();
            const observe = new Map<number, Settled<ObserveResult>>();
            for (const w of p.windows) {
              const o = next();
              observe.set(w, o.ok ? settledOk(observeResult(o.value)) : (o as Settled<never>));
            }
            const slot0: Settled<Slot0> = s0.ok
              ? (() => {
                  const s = s0.value as readonly [bigint, number, number, number];
                  return settledOk({ sqrtPriceX96: s[0], tick: Number(s[1]), observationIndex: Number(s[2]), observationCardinality: Number(s[3]) });
                })()
              : s0;
            out.pools.set(lc(p.pool), { slot0, liquidity: liq.ok ? settledOk(liq.value as bigint) : liq, observe });
          }
          for (const t of toks) out.tokens.set(lc(t), tokenStateFromViews(TOKEN_STATE_VIEWS.map(() => next())));
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
      return observeResult(await pub.readContract({ address: pool, abi: uniswapV3OracleAbi, functionName: "observe", args: [secondsAgos.map(Number)], blockNumber }));
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

const MAX_UINT160 = (1n << 160n) - 1n;

/**
 * Uniswap OracleLibrary.consult: the harmonic-mean in-range liquidity over `secs` from two
 * secondsPerLiquidityCumulativeX128 values (secs x (2^160 - 1) / (delta << 32)). A window without in-range liquidity
 * accumulates seconds / 1 there, so it drives the mean towards 0; a non-increasing delta gives 0 (never usable).
 */
export function harmonicMeanLiquidity(secondsPerLiquidityAgoX128: bigint, secondsPerLiquidityNowX128: bigint, secs: number): bigint {
  if (!Number.isInteger(secs) || secs <= 0) throw new Error(`TWAP window must be a positive integer (s), got ${secs}`);
  const delta = secondsPerLiquidityNowX128 - secondsPerLiquidityAgoX128;
  if (delta <= 0n) return 0n;
  return (BigInt(secs) * MAX_UINT160) / (delta << 32n);
}

/** sqrtPriceX96 at a tick (float precision: enough for a depth figure). */
export function sqrtPriceX96AtTick(tick: number): bigint {
  return BigInt(Math.round(Math.sqrt(1.0001 ** tick) * 2 ** 96));
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
  /** quote tokens moving the price DEPTH_MOVE_BPS within the active range NOW (WETH for a WETH-quoted pool) */
  depthQuote?: number;
  /** the same in USD (USDG = $1; WETH at the ETH/USD leg's TWAP, or its spot when the leg is unusable) */
  depthUsd?: number;
  /** USD moving the price DEPTH_MOVE_BPS at the window's harmonic-mean liquidity and mean tick: the FLOOR's measure */
  twapDepthUsd?: number;
  /** combining weight: min(depthUsd, twapDepthUsd), the WETH pools' total capped at the ETH/USD leg's own weight */
  weightUsd?: number;
  cardinality?: number;
  /** age of the oldest observation (s): how far back observe() can reach */
  historySec?: number;
  /** seconds since the newest observation (the last block with a swap) */
  lastSwapAgeSec?: number;
}

/** Which pool an observation comes from: `label` e.g. "NVDA/WETH 500 0x62AB..6b6C" (alerts, /health, source-check). */
export interface DexPoolId {
  pool: Address;
  label: string;
  quote: DexQuote;
}

export type DexPoolObservation =
  | (DexPoolId & {
      ok: true;
      /** USD per SHARE (TWAP token price in USD / uiMultiplier) */
      price: number;
      /** USD per Stock Token over the window (a WETH quote times the leg's TWAP) */
      tokenPrice: number;
      /** spot (slot0) token price in USD, display only */
      spotTokenPrice: number;
      meanTick: number;
      twapSec: number;
      /** block timestamp, unix ms */
      ts: number;
      uiMultiplier: bigint;
    } & Required<DexDiagnostics>)
  | (DexPoolId & { ok: false; reason: string } & DexDiagnostics);

/**
 * A ticker's confirm observation: usable = the reference pool's observation with `price` the weighted median of the
 * usable pools (combineDexPools), plus every pool's; not usable = why (one pool: its reason and diagnostics; several:
 * every pool's reason).
 */
export type DexObservation =
  | (Extract<DexPoolObservation, { ok: true }> & { pools: DexPoolObservation[] })
  | ({ ok: false; reason: string; pools?: DexPoolObservation[] } & DexDiagnostics & Partial<DexPoolId>);

/** The ETH/USD leg as seen by the latest pass (source-check, notes). */
export type DexLegObservation =
  | ({ ok: true; label: string; spotPrice: number } & Required<Omit<DexDiagnostics, "depthQuote">>)
  | ({ ok: false; label: string; reason: string; spotPrice?: number } & Omit<DexDiagnostics, "depthQuote">);

/**
 * The value a ticker's usable pools report: the weighted median of their per-share prices (weights: weightUsd).
 * Sorted by price, the value at which the cumulative weight reaches half the total; when it reaches exactly half at a
 * pool, the mean of that pool's and the next pool's prices (a 50/50 split favours neither side). `reference` is the
 * pool at (or just below) the median. A pool holding less than half the weight never moves the value outside the
 * range of the others. Empty input throws. Divergence is NOT decided on this value alone (combineDexPools: parts).
 */
export function weightedMedian<T extends { price: number; weightUsd: number }>(xs: readonly T[]): { value: number; reference: T } {
  if (xs.length === 0) throw new Error("weighted median of no pools");
  const sorted = [...xs].sort((a, b) => a.price - b.price || b.weightUsd - a.weightUsd);
  const w = (x: T) => Math.max(0, x.weightUsd);
  const total = sorted.reduce((s, x) => s + w(x), 0);
  if (total <= 0) {
    // no weight at all: the plain median
    const mid = sorted.length >> 1;
    const ref = sorted[sorted.length % 2 === 1 ? mid : mid - 1] as T;
    return { value: sorted.length % 2 === 1 ? ref.price : (ref.price + (sorted[mid] as T).price) / 2, reference: ref };
  }
  let cum = 0;
  for (let i = 0; i < sorted.length; i++) {
    const x = sorted[i] as T;
    cum += w(x);
    if (cum >= total / 2 - total * 1e-12) {
      const next = sorted[i + 1];
      const tie = next !== undefined && Math.abs(cum - total / 2) <= total * 1e-12;
      return { value: tie ? (x.price + next.price) / 2 : x.price, reference: x };
    }
  }
  const last = sorted[sorted.length - 1] as T;
  return { value: last.price, reference: last };
}

/**
 * One ticker's pools -> its confirm observation. Available when at least one pool is usable (passed its history,
 * last-swap, token-state, leg and time-averaged depth checks); `price` = the weighted median of the usable ones
 * (weightedMedian), the other fields the reference pool's. The caller passes every usable pool's price on as `parts`
 * (fetch), so a divergence of any one of them is flagged (domain/confirm.ts).
 */
export function combineDexPools(results: readonly DexPoolObservation[]): DexObservation {
  const usable = results.filter((r): r is Extract<DexPoolObservation, { ok: true }> => r.ok);
  if (usable.length > 0) {
    const m = weightedMedian(usable);
    return { ...m.reference, price: m.value, pools: [...results] };
  }
  if (results.length === 0) return { ok: false, reason: "no DEX confirm pool configured" };
  if (results.length === 1) return { ...(results[0] as Extract<DexPoolObservation, { ok: false }>), pools: [...results] };
  const why = results.map((r) => `${r.label}: ${r.ok ? "usable" : r.reason}`).join("; ");
  return { ok: false, reason: `no usable confirm pool (${results.length} configured): ${why}`, pools: [...results] };
}

/**
 * The WETH-quoted pools all price through the one ETH/USD leg: scales their weights so that together they weigh at
 * most `legWeightUsd` (one shared leg is not several independent sources). Returns new observations, same order.
 */
export function capSharedLeg(results: readonly DexPoolObservation[], legWeightUsd: number): DexPoolObservation[] {
  const eth = results.filter((r) => r.ok && r.quote === "eth");
  const total = eth.reduce((s, r) => s + (r.ok ? r.weightUsd : 0), 0);
  if (total <= legWeightUsd || total <= 0) return [...results];
  const k = Math.max(0, legWeightUsd) / total;
  return results.map((r) => (r.ok && r.quote === "eth" ? { ...r, weightUsd: r.weightUsd * k } : r));
}

export interface DexTwapOptions {
  /** observation max age (block time vs now) */
  maxAgeMs: number;
  /** Uniswap v3 factory of the chain: every pool must be its getPool(stockToken, quoteToken, fee); null = not checked */
  factory: Address | null;
  /** The WETH / USD leg; required when any pool is quoted in WETH. */
  ethUsd?: ResolvedEthUsdLeg | null;
  /** a pass started less than this ago is reused by every ticker (ORACLE_DEX_READ_MS; 0 = a pass per tick) */
  readIntervalMs?: number;
  /** every pass reports its block timestamp here (the oracle's HeadClock) */
  onBlockTimestamp?: (tsSec: number) => void;
  now?: () => number;
}

const errMsg = (e: unknown): string => (e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e));
const shortAddr = (a: Address) => `${a.slice(0, 6)}..${a.slice(-4)}`;

/** "NVDA/WETH 500 0x62AB..6b6C" */
export function dexPoolLabel(ticker: string, p: Pick<ResolvedDexPool, "pool" | "fee" | "quote">): string {
  return `${ticker}/${p.quote === "eth" ? "WETH" : "USDG"} ${p.fee} ${shortAddr(p.pool)}`;
}

/** "WETH/USDG 100 0x52e6..71Ca" */
export function ethLegLabel(l: Pick<ResolvedEthUsdLeg, "pool" | "fee">): string {
  return `WETH/USDG ${l.fee} ${shortAddr(l.pool)}`;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The leg at one TWAP window: WETH in USD over it and the leg's weight, or why not. */
type LegQuote = { ok: true; price: number; spot: number; weightUsd: number } | { ok: false; reason: string; spot?: number };

interface PoolCheck {
  /** the pool's base (Stock Token, or WETH for the leg) is token0 */
  baseIsToken0: boolean;
}

export class DexTwapSource implements PriceSource {
  readonly name = DEX_SOURCE_NAME;
  readonly kind = "dex" as const;
  readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly pools: Readonly<Record<string, readonly ResolvedDexPool[]>>;
  private readonly leg: ResolvedEthUsdLeg | null;
  private readonly poolCheckCache = new Map<Address, Promise<PoolCheck | { problem: string }>>();
  private readonly decimalsCache = new Map<Address, Promise<number>>();
  /** oldest / newest observation timestamps per (pool, observationIndex, cardinality): they move only with the index */
  private readonly ringCache = new Map<Address, { key: string; oldest: number; newest: number }>();
  /** the current pass (every ticker's observation), shared while in flight or younger than readIntervalMs */
  private pass: { startedAt: number; promise: Promise<Map<string, DexObservation>>; done: boolean; failed: boolean } | null = null;
  /** latest observation per ticker (confirmNote) and the leg as seen by the latest pass */
  private readonly latest = new Map<string, DexObservation>();
  private lastLeg: DexLegObservation | null = null;
  /** completed passes (tests) */
  passes = 0;

  constructor(pools: Readonly<Record<string, ResolvedDexPool | readonly ResolvedDexPool[]>>, private readonly reader: DexReader, private readonly opts: DexTwapOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs;
    this.leg = opts.ethUsd ?? null;
    this.pools = Object.fromEntries(Object.entries(pools).map(([t, p]) => [t, Array.isArray(p) ? [...p] : [p as ResolvedDexPool]]));
    const needLeg = Object.entries(this.pools).flatMap(([t, ps]) => ps.filter((p) => p.quote === "eth").map((p) => dexPoolLabel(t, p)));
    if (needLeg.length > 0 && !this.leg) throw new Error(`WETH-quoted confirm pools without an ETH/USD leg (dexConfirm.ethUsd): ${needLeg.join(", ")}`);
  }

  tickers(): string[] {
    return Object.keys(this.pools);
  }

  /** The ticker's confirm pools (empty when none). */
  poolsOf(ticker: string): readonly ResolvedDexPool[] {
    return this.pools[ticker] ?? [];
  }

  /** The WETH / USD leg (null when no pool is quoted in WETH). */
  ethUsdLeg(): ResolvedEthUsdLeg | null {
    return this.leg;
  }

  /** The leg as seen by the latest pass (null: no leg, or not read yet). */
  legObservation(): DexLegObservation | null {
    return this.lastLeg;
  }

  /** Whether pools are checked against the factory (getPool(stockToken, quoteToken, fee) == pool). */
  factoryChecked(): boolean {
    return this.opts.factory !== null;
  }

  /**
   * Throws with the reason when there is no usable observation (per-source health shows it). `price` is the weighted
   * median; `parts` every usable pool's own price (a divergence of any one is flagged by domain/confirm.ts).
   */
  async fetch(ticker: string): Promise<SourceObservation | null> {
    const o = await this.observe(ticker);
    if (!o.ok) throw new Error(o.reason);
    const parts = o.pools.flatMap((p) => (p.ok ? [{ label: p.label, price: p.price }] : []));
    return { price: o.price, ts: o.ts, maxAgeMs: this.maxAgeMs, ...(o.pools.length > 1 ? { parts } : {}) };
  }

  /**
   * Which pools the ticker's latest observation used and which failed, for /health `confirm[].notes` and the
   * services/alerts confirm messages; null when the ticker has no pool or was not observed yet.
   */
  confirmNote(ticker: string): string | null {
    const o = this.latest.get(ticker);
    if (!o || !this.pools[ticker]) return null;
    const pools = o.pools ?? [];
    if (pools.length === 0) return `${DEX_SOURCE_NAME}: ${o.ok ? "no pool read" : o.reason}`;
    const used = pools.filter((p) => p.ok);
    const failed = pools.filter((p): p is Extract<DexPoolObservation, { ok: false }> => !p.ok);
    const usedText = used.map((p) => `${p.label} $${p.price.toFixed(2)} (2% depth ${fmtUsd(p.twapDepthUsd)} avg / ${fmtUsd(p.depthUsd)} now, weight ${fmtUsd(p.weightUsd)}${o.ok && p.pool === o.pool ? ", reference" : ""})`);
    const failedText = failed.map((p) => `${p.label}: ${p.reason}`);
    const value = o.ok && used.length > 1 ? ` (weighted median $${o.price.toFixed(2)})` : "";
    return `${DEX_SOURCE_NAME}: used ${usedText.length > 0 ? usedText.join(", ") : "none"}${value}${failedText.length > 0 ? `; failed ${failedText.join("; ")}` : ""}`;
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
    if (!this.pools[ticker]) return { ok: false, reason: "no DEX confirm pool configured" };
    let o: DexObservation;
    try {
      const all = await this.currentPass(this.now());
      o = all.get(ticker) ?? { ok: false, reason: "pool not read" };
    } catch (e) {
      o = { ok: false, reason: `pool not readable: ${errMsg(e)}` };
    }
    this.latest.set(ticker, o);
    return o;
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

  /** One pass: the block, the per-pool checks (cached), one batched read of every usable pool + token + the leg, the moved rings. */
  private async readAll(): Promise<Map<string, DexObservation>> {
    const entries = Object.entries(this.pools).flatMap(([t, ps]) => ps.map((p) => ({ t, p, label: dexPoolLabel(t, p) })));
    const leg = this.leg;
    const [block, prep, legPrep] = await Promise.all([
      this.reader.block(),
      Promise.all(
        entries.map(async (x) => {
          try {
            const [check, quoteDecimals] = await Promise.all([this.checkPool(x.p.pool, x.p.token, x.p.quoteToken, x.p.fee, "Stock Token"), this.decimalsOf(x.p.quoteToken)]);
            return { ...x, check, quoteDecimals, error: null as unknown };
          } catch (e) {
            return { ...x, check: null, quoteDecimals: 0, error: e };
          }
        }),
      ),
      leg
        ? Promise.all([this.checkPool(leg.pool, leg.weth, leg.quoteToken, leg.fee, "WETH"), this.decimalsOf(leg.weth), this.decimalsOf(leg.quoteToken)]).then(
            ([check, wethDecimals, usdDecimals]) => ({ check, wethDecimals, usdDecimals, error: null as unknown }),
            (e: unknown) => ({ check: null, wethDecimals: 0, usdDecimals: 0, error: e }),
          )
        : null,
    ]);
    this.opts.onBlockTimestamp?.(block.timestamp);
    const results = new Map<string, DexPoolObservation[]>(Object.keys(this.pools).map((t) => [t, []]));
    const push = (t: string, o: DexPoolObservation) => results.get(t)?.push(o);
    const usable: Array<{ t: string; p: ResolvedDexPool; label: string; tokenIsToken0: boolean; quoteDecimals: number }> = [];
    for (const x of prep) {
      const id: DexPoolId = { pool: x.p.pool, label: x.label, quote: x.p.quote };
      if (x.error !== null || !x.check) push(x.t, { ...id, ok: false, reason: `pool not readable: ${errMsg(x.error)}` });
      else if ("problem" in x.check) push(x.t, { ...id, ok: false, reason: x.check.problem });
      else usable.push({ t: x.t, p: x.p, label: x.label, tokenIsToken0: x.check.baseIsToken0, quoteDecimals: x.quoteDecimals });
    }

    // the leg is read only when a WETH pool is usable, observed at every window those pools use (one observe each)
    const windows = [...new Set(usable.filter((u) => u.p.quote === "eth").map((u) => u.p.twapSec))].sort((a, b) => a - b);
    const legLabel = leg ? ethLegLabel(leg) : "";
    let legReady: { wethIsToken0: boolean; wethDecimals: number; usdDecimals: number } | null = null;
    let legProblem: string | null = null;
    if (leg && legPrep) {
      if (legPrep.error !== null || !legPrep.check) legProblem = `pool not readable: ${errMsg(legPrep.error)}`;
      else if ("problem" in legPrep.check) legProblem = legPrep.check.problem;
      else legReady = { wethIsToken0: legPrep.check.baseIsToken0, wethDecimals: legPrep.wethDecimals, usdDecimals: legPrep.usdDecimals };
    }
    const readLeg = leg !== null && legReady !== null && windows.length > 0;
    // replaced by evaluateLeg when the leg is read this pass
    this.lastLeg = leg ? { ok: false, label: legLabel, reason: legProblem ?? "not read (no usable WETH-quoted pool)" } : null;

    let legAt: Map<number, LegQuote> | null = null;
    if (usable.length > 0) {
      const req: DexPoolRequest[] = usable.map((u) => ({ pool: u.p.pool, windows: [u.p.twapSec] }));
      if (readLeg && leg) req.push({ pool: leg.pool, windows });
      const tokens = [...new Map(usable.map((u) => [lc(u.p.token), u.p.token])).values()];
      const reads = this.reader.readPass ? await this.reader.readPass(req, tokens, block.number) : await readPassPerCall(this.reader, req, tokens, block.number);
      // ring buffer timestamps: one batched read for every pool whose observation index moved since the cached one
      const moved = req.flatMap((q) => {
        const s0 = reads.pools.get(lc(q.pool))?.slot0;
        return s0?.ok && !this.ringHit(q.pool, s0.value) ? [{ pool: q.pool, slot0: s0.value }] : [];
      });
      if (moved.length > 0) await this.readRings(moved, block.number);

      legAt = readLeg && leg && legReady ? this.evaluateLeg(leg, legLabel, legReady, windows, block, reads.pools.get(lc(leg.pool))) : null;
      for (const u of usable) {
        const id: DexPoolId = { pool: u.p.pool, label: u.label, quote: u.p.quote };
        const r = reads.pools.get(lc(u.p.pool));
        const ts = reads.tokens.get(lc(u.p.token));
        try {
          if (!r || !ts) throw new Error("pool not read");
          const usd: LegQuote =
            u.p.quote === "usd"
              ? { ok: true, price: 1, spot: 1, weightUsd: Number.POSITIVE_INFINITY }
              : legAt
                ? (legAt.get(u.p.twapSec) ?? { ok: false, reason: `${legLabel}: window not read` })
                : { ok: false, reason: `${legLabel}: ${legProblem ?? "not read"}` };
          push(u.t, { ...id, ...this.evaluate(u.p, u.tokenIsToken0, u.quoteDecimals, block, r, ts, usd) });
        } catch (e) {
          push(u.t, { ...id, ok: false, reason: `pool not readable: ${errMsg(e)}` });
        }
      }
    }

    const out = new Map<string, DexObservation>();
    for (const [t, rs] of results) {
      // in the configured order (failed checks were collected first)
      const order = (o: DexPoolObservation) => (this.pools[t] ?? []).findIndex((p) => p.pool === o.pool);
      const sorted = [...rs].sort((a, b) => order(a) - order(b));
      // one shared leg: the WETH pools together weigh at most its weight at their (smallest) window weight
      const legWeights = sorted.flatMap((r) => {
        const q = r.ok && r.quote === "eth" ? legAt?.get(r.twapSec) : undefined;
        return q?.ok ? [q.weightUsd] : [];
      });
      out.set(t, combineDexPools(legWeights.length > 0 ? capSharedLeg(sorted, Math.min(...legWeights)) : sorted));
    }
    return out;
  }

  private decimalsOf(token: Address): Promise<number> {
    return this.cached(this.decimalsCache, token, () => this.reader.decimals(token));
  }

  /** factory.getPool(base, quote, fee) == pool and the pool's tokens (once per pool; a read error is retried). */
  private checkPool(pool: Address, base: Address, quote: Address, fee: number, baseName: string): Promise<PoolCheck | { problem: string }> {
    return this.cached(this.poolCheckCache, pool, async () => {
      if (this.opts.factory) {
        const fromFactory = await this.reader.getPool(this.opts.factory, base, quote, fee);
        if (fromFactory.toLowerCase() !== pool.toLowerCase()) {
          return { problem: `pool ${pool} is not the factory's pool for (${baseName}, quote token, fee ${fee}): getPool returned ${fromFactory}` };
        }
      }
      const t = await this.reader.poolTokens(pool);
      const t0 = t.token0.toLowerCase();
      const t1 = t.token1.toLowerCase();
      const b = base.toLowerCase();
      const q = quote.toLowerCase();
      if (!((t0 === b && t1 === q) || (t0 === q && t1 === b))) {
        return { problem: `pool tokens ${t.token0} / ${t.token1} are not the ${baseName} ${base} and the quote token ${quote}` };
      }
      return { baseIsToken0: t0 === b };
    });
  }

  /**
   * The ETH/USD leg at every window of the WETH pools, each window on its own: history covering it, a swap inside
   * it, observe([w, 0]), the time-averaged 2% depth (harmonic-mean liquidity at the mean tick, USD) against the leg's
   * floor; WETH in USD over it and the leg's weight min(current, time-averaged depth). Records lastLeg: ok when at
   * least one window is usable, else the first window's reason.
   */
  private evaluateLeg(
    leg: ResolvedEthUsdLeg,
    label: string,
    c: { wethIsToken0: boolean; wethDecimals: number; usdDecimals: number },
    windows: readonly number[],
    block: DexBlock,
    r: DexPoolRead | undefined,
  ): Map<number, LegQuote> {
    const all = (q: LegQuote) => new Map(windows.map((w) => [w, q]));
    const fail = (reason: string, diag: Omit<DexDiagnostics, "depthQuote"> = {}, spot?: number): Map<number, LegQuote> => {
      this.lastLeg = { ok: false, label, reason, ...diag, ...(spot !== undefined ? { spotPrice: spot } : {}) };
      return all({ ok: false, reason: `${label}: ${reason}`, ...(spot !== undefined ? { spot } : {}) });
    };
    if (!r) return fail("pool not read");
    if (!r.slot0.ok) return fail(`pool not readable: ${errMsg(r.slot0.error)}`);
    if (!r.liquidity.ok) return fail(`pool not readable: ${errMsg(r.liquidity.error)}`);
    const slot0 = r.slot0.value;
    const spot = tokenPriceAtTick(slot0.tick, c.wethIsToken0, c.wethDecimals, c.usdDecimals);
    const depthNow = depthQuote(r.liquidity.value, slot0.sqrtPriceX96, !c.wethIsToken0, c.usdDecimals);
    const diag: Omit<DexDiagnostics, "depthQuote"> = { depthUsd: depthNow, cardinality: slot0.observationCardinality };
    const ring = this.ringCache.get(leg.pool);
    if (!ring || !this.ringHit(leg.pool, slot0)) return fail("observation ring not read", diag, spot);
    const historySec = block.timestamp - ring.oldest;
    const lastSwapAgeSec = block.timestamp - ring.newest;
    diag.historySec = historySec;
    diag.lastSwapAgeSec = lastSwapAgeSec;
    const out = new Map<number, LegQuote>();
    const failed: string[] = [];
    let best: { twapDepthUsd: number; weightUsd: number } | null = null;
    const no = (w: number, reason: string) => {
      failed.push(reason);
      out.set(w, { ok: false, reason: `${label}: ${reason}`, spot });
    };
    for (const w of windows) {
      if (historySec < w) {
        no(w, `observation history ${historySec}s < TWAP window ${w}s`);
        continue;
      }
      if (lastSwapAgeSec >= w) {
        no(w, `no swap in the ${w}s TWAP window (last swap ${lastSwapAgeSec}s ago)`);
        continue;
      }
      const o = r.observe.get(w);
      if (!o?.ok) {
        no(w, `observe([${w}, 0]) failed: ${o ? errMsg(o.error) : "not read"}`);
        continue;
      }
      const { tickCumulatives: tc, secondsPerLiquidityCumulativeX128s: spl } = o.value;
      if (tc.length !== 2 || spl.length !== 2) {
        no(w, `observe returned ${tc.length} values`);
        continue;
      }
      const meanTick = arithmeticMeanTick(tc[0] as bigint, tc[1] as bigint, w);
      const price = tokenPriceAtTick(meanTick, c.wethIsToken0, c.wethDecimals, c.usdDecimals);
      if (!Number.isFinite(price) || price <= 0) {
        no(w, `TWAP price ${price} not usable`);
        continue;
      }
      const twapDepthUsd = depthQuote(harmonicMeanLiquidity(spl[0] as bigint, spl[1] as bigint, w), sqrtPriceX96AtTick(meanTick), !c.wethIsToken0, c.usdDecimals);
      if (twapDepthUsd < leg.minDepthUsd) {
        no(w, `insufficient depth: ${fmtUsd(twapDepthUsd)} moves the price ${DEPTH_MOVE_BPS / 100}% (time-averaged over ${w}s; now ${fmtUsd(depthNow)}; floor ${fmtUsd(leg.minDepthUsd)})`);
        continue;
      }
      const weightUsd = Math.min(depthNow, twapDepthUsd);
      out.set(w, { ok: true, price, spot, weightUsd });
      if (!best || weightUsd < best.weightUsd) best = { twapDepthUsd, weightUsd };
    }
    this.lastLeg = best
      ? { ok: true, label, spotPrice: spot, depthUsd: depthNow, twapDepthUsd: best.twapDepthUsd, weightUsd: best.weightUsd, cardinality: slot0.observationCardinality, historySec, lastSwapAgeSec }
      : { ok: false, label, reason: failed[0] ?? "no window", spotPrice: spot, ...diag };
    return out;
  }

  /**
   * One pool's observation from the pass's reads (the checks in their historical order; throws = not readable).
   * `usd`: USD per quote token over the pool's window (USDG: 1; WETH: the leg's TWAP, or why not).
   */
  private evaluate(
    p: ResolvedDexPool,
    tokenIsToken0: boolean,
    quoteDecimals: number,
    block: DexBlock,
    r: DexPoolRead,
    tokenStateRead: Settled<TokenState>,
    usd: LegQuote,
  ): DistributiveOmit<DexPoolObservation, keyof DexPoolId> {
    const value = <T>(s: Settled<T>): T => {
      if (!s.ok) throw s.error;
      return s.value;
    };
    const slot0 = value(r.slot0);
    const liquidity = value(r.liquidity);
    const tokenState = value(tokenStateRead);
    const cardinality = slot0.observationCardinality;
    const depth = depthQuote(liquidity, slot0.sqrtPriceX96, !tokenIsToken0, quoteDecimals);
    const diag: DexDiagnostics = { depthQuote: depth, cardinality };
    if (!usd.ok) {
      if (usd.spot !== undefined) diag.depthUsd = depth * usd.spot;
      return { ok: false, reason: `ETH/USD leg ${usd.reason}`, ...diag };
    }
    const depthUsd = depth * usd.price;
    diag.depthUsd = depthUsd;

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

    const obs = r.observe.get(p.twapSec);
    if (!obs?.ok) return { ok: false, reason: `observe([${p.twapSec}, 0]) failed: ${obs ? errMsg(obs.error) : "not read"}`, ...diag };
    const { tickCumulatives: cum, secondsPerLiquidityCumulativeX128s: spl } = obs.value;
    if (cum.length !== 2 || spl.length !== 2) return { ok: false, reason: `observe returned ${cum.length} values`, ...diag };
    const meanTick = arithmeticMeanTick(cum[0] as bigint, cum[1] as bigint, p.twapSec);
    // the floor's measure: the window's harmonic-mean liquidity at the mean tick (one pushed block cannot move it)
    const twapDepthUsd = depthQuote(harmonicMeanLiquidity(spl[0] as bigint, spl[1] as bigint, p.twapSec), sqrtPriceX96AtTick(meanTick), !tokenIsToken0, quoteDecimals) * usd.price;
    diag.twapDepthUsd = twapDepthUsd;
    if (twapDepthUsd < p.minDepthUsd) {
      const inWeth = p.quote === "eth" ? `; ${(twapDepthUsd / usd.price).toFixed(1)} WETH at ${fmtUsd(usd.price)}` : "";
      return {
        ok: false,
        reason: `insufficient depth: ${fmtUsd(twapDepthUsd)} moves the price ${DEPTH_MOVE_BPS / 100}% (time-averaged over ${p.twapSec}s; now ${fmtUsd(depthUsd)}; floor ${fmtUsd(p.minDepthUsd)}${inWeth})`,
        ...diag,
      };
    }
    // USD per Stock Token: the pool's quote-token TWAP times the quote's USD TWAP over the same window; the
    // multiplier is then divided out exactly as on the USDG path (per token -> per share)
    const tokenPrice = tokenPriceAtTick(meanTick, tokenIsToken0, p.tokenDecimals, quoteDecimals) * usd.price;
    if (!Number.isFinite(tokenPrice) || tokenPrice <= 0) return { ok: false, reason: `TWAP price ${tokenPrice} not usable`, ...diag };
    return {
      ok: true,
      price: perSharePrice(tokenPrice, tokenState.uiMultiplier),
      tokenPrice,
      spotTokenPrice: tokenPriceAtTick(slot0.tick, tokenIsToken0, p.tokenDecimals, quoteDecimals) * usd.spot,
      meanTick,
      twapSec: p.twapSec,
      ts: block.timestamp * 1000,
      uiMultiplier: tokenState.uiMultiplier,
      depthQuote: depth,
      depthUsd,
      twapDepthUsd,
      // a narrow position added for the read block raises depthUsd, not the window's average: it buys no weight
      weightUsd: Math.min(depthUsd, twapDepthUsd),
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
