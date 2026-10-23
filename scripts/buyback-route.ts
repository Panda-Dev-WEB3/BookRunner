// BKRN buyback route discovery (Uniswap v4 venue, BkrnFeeRouter.setV4Route) — READ-ONLY: eth_call / eth_getLogs only,
// never sends a transaction. The contract executes a governance-set route; the choice is made here, off-chain,
// because an on-chain choice could be steered by whoever moves a pool in the same block.
//
// Candidates for BKRN = --bkrn (a Pons launch graduates into a locked v4 pool with the PonsV2MemeHook, fee 0,
// tickSpacing 200; native-ETH-quoted by default, USDG-quoted when launched so):
//   direct  USDG -> BKRN            v4 {USDG, BKRN} pools (Pons key, plus plain hook-less tiers)
//   v4Eth   USDG -> ETH -> BKRN     v4 {ETH, USDG} hook-less tiers, then the v4 {ETH, BKRN} pool, one unlock
//   v3Weth  USDG -> WETH -> BKRN    v3 factory getPool(USDG, WETH, fee) per tier + SwapRouter02, then the v4 {ETH, BKRN} pool
// Each candidate is read with StateView getSlot0 / getLiquidity (v4) or the pool's slot0 / liquidity (v3) and quoted
// for `--size` USDG with the v4 Quoter / v3 QuoterV2 (eth_call). Prints the best route by BKRN out, the deploy-input
// values (`buyback.v4Route`, `buyback.ethReference`, `buyback.v4Hooks`) and the timelock calls with calldata. The ETH
// reference is the v3 USDG/WETH TWAP (`--twap`, default 1800 s), the BKRN/ETH one the median of the picked pool's spot
// over `--samples` blocks of that span (never a single-block spot; warnings when a source is thin).
//
//   bun scripts/buyback-route.ts --bkrn 0x... [--size 1000] [--hook 0x...] [--scan] [--json]
//   RPC_URL (default https://rpc.mainnet.chain.robinhood.com). --scan: also list the v4 pools initialized with BKRN
//   (PoolManager Initialize logs filtered by the BKRN topic, 10M-block windows: ~10 eth_getLogs).
// Exit code 1 when no candidate route quotes.
import { type Address, type Hex, type PublicClient, createPublicClient, encodeAbiParameters, encodeFunctionData, formatUnits, getAddress, http, isAddress, keccak256, parseAbi, parseAbiItem, zeroAddress } from "viem";
import { bkrnFeeRouterAbi } from "../packages/shared/src/abi";
import { RHC_TOKENS, UNISWAP_V3, UNISWAP_V4, quoterV2Abi, uniswapV3FactoryAbi, uniswapV3PoolAbi } from "../packages/shared/src/uniswap";

/** PonsV2MemeHook on Robinhood Chain (third-party docs, docs.bitquery.io Pons API; seen on-chain 2026-10-23). */
export const PONS_HOOK: Address = getAddress("0xe5e702641ea86f4ae6cc3cdaed2b886f976be044");
export const PONS_FEE = 0;
export const PONS_TICK_SPACING = 200;
/** Hook-less v4 tiers tried for {ETH, USDG} and {USDG, BKRN}: [fee, tickSpacing]. */
export const V4_TIERS: ReadonlyArray<readonly [number, number]> = [
  [100, 1],
  [500, 10],
  [3000, 60],
  [10_000, 200],
];
export const V3_TIERS = [100, 500, 3000, 10_000] as const;
const NATIVE: Address = zeroAddress;

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export type RouteKind = "direct" | "v4Eth" | "v3Weth";
export const ROUTE_KIND_ID: Record<RouteKind, number> = { direct: 0, v4Eth: 1, v3Weth: 2 };

export interface Candidate {
  kind: RouteKind;
  bkrnPool: PoolKey;
  ethPool?: PoolKey;
  v3Fee?: number;
  v3Pool?: Address;
  /** BKRN out (18 dp) for the reference size; null = did not quote. */
  bkrnOut: bigint | null;
  /** ETH out of the first hop (via ETH), 18 dp. */
  ethOut?: bigint | null;
  note?: string;
}

export function sortKey(a: Address, b: Address, fee: number, tickSpacing: number, hooks: Address): PoolKey {
  const [c0, c1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { currency0: getAddress(c0), currency1: getAddress(c1), fee, tickSpacing, hooks: getAddress(hooks) };
}

/** Best quoting candidate by BKRN out (ties: fewer hops, then v4 over v3). */
export function best(cands: Candidate[]): Candidate | null {
  const hops = (c: Candidate) => (c.kind === "direct" ? 1 : 2);
  const ok = cands.filter((c) => c.bkrnOut !== null && c.bkrnOut > 0n);
  ok.sort((x, y) => {
    const d = (y.bkrnOut as bigint) - (x.bkrnOut as bigint);
    if (d !== 0n) return d > 0n ? 1 : -1;
    if (hops(x) !== hops(y)) return hops(x) - hops(y);
    return (x.kind === "v3Weth" ? 1 : 0) - (y.kind === "v3Weth" ? 1 : 0);
  });
  return ok[0] ?? null;
}

const EMPTY_KEY: PoolKey = { currency0: zeroAddress, currency1: zeroAddress, fee: 0, tickSpacing: 0, hooks: zeroAddress };

/** The BkrnFeeRouter.setV4Route argument for `c` (v4 route struct). */
export function routeStruct(c: Candidate, weth: Address) {
  return {
    kind: ROUTE_KIND_ID[c.kind],
    bkrnPool: c.bkrnPool,
    ethPool: c.kind === "v4Eth" && c.ethPool ? c.ethPool : EMPTY_KEY,
    v3Fee: c.kind === "v3Weth" ? (c.v3Fee ?? 0) : 0,
    weth: c.kind === "v3Weth" ? weth : zeroAddress,
  };
}

/** `buyback.v4Route` deploy-input object (contracts/deploy-inputs/README.md). */
export function deployInputRoute(c: Candidate, weth: Address): Record<string, unknown> {
  const k = (p: PoolKey) => ({ currency0: p.currency0, currency1: p.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks });
  const r: Record<string, unknown> = { kind: c.kind, bkrnPool: k(c.bkrnPool) };
  if (c.kind === "v4Eth" && c.ethPool) r.ethPool = k(c.ethPool);
  if (c.kind === "v3Weth") Object.assign(r, { v3Fee: c.v3Fee, weth });
  return r;
}

/** Whole `out` per whole `in`, WAD, from a v4 / v3 sqrtPriceX96 (token1 per token0 raw). */
export function spotWad(sqrtPriceX96: bigint, inIsToken0: boolean, decIn: number, decOut: number): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  const q192 = 1n << 192n;
  const raw1per0e36 = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 36n) / q192;
  const rawOutPerInWad = inIsToken0 ? raw1per0e36 / 10n ** 18n : 10n ** 54n / raw1per0e36;
  return (rawOutPerInWad * 10n ** BigInt(decIn)) / 10n ** BigInt(decOut);
}

// ------------------------------------------------------------------------------------------- chain reads

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const initializeEvent = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);

export function poolId(k: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
}

interface V4State {
  sqrtPriceX96: bigint;
  liquidity: bigint;
}

async function v4State(pc: PublicClient, stateView: Address, k: PoolKey): Promise<V4State> {
  const id = poolId(k);
  const [s0, liq] = await Promise.all([
    pc.readContract({ address: stateView, abi: stateViewAbi, functionName: "getSlot0", args: [id] }),
    pc.readContract({ address: stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [id] }),
  ]);
  return { sqrtPriceX96: s0[0], liquidity: liq };
}

async function v4Quote(pc: PublicClient, quoter: Address, k: PoolKey, currencyIn: Address, amount: bigint): Promise<bigint | null> {
  try {
    const { result } = await pc.simulateContract({
      address: quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: k, zeroForOne: getAddress(k.currency0) === getAddress(currencyIn), exactAmount: amount, hookData: "0x" }],
    });
    return result[0];
  } catch {
    return null;
  }
}

async function v3Quote(pc: PublicClient, quoter: Address, tokenIn: Address, tokenOut: Address, fee: number, amount: bigint): Promise<bigint | null> {
  try {
    const { result } = await pc.simulateContract({
      address: quoter,
      abi: quoterV2Abi,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn: amount, fee, sqrtPriceLimitX96: 0n }],
    });
    return result[0];
  } catch {
    return null;
  }
}

/** Initialize logs of v4 pools holding `token` (as currency0 or currency1): ~2 x (head / 10M) eth_getLogs. */
async function scanPools(pc: PublicClient, manager: Address, token: Address): Promise<PoolKey[]> {
  const head = await pc.getBlockNumber();
  const out: PoolKey[] = [];
  const STEP = 10_000_000n;
  for (let from = 0n; from <= head; from += STEP) {
    const to = from + STEP - 1n > head ? head : from + STEP - 1n;
    for (const args of [{ currency0: token }, { currency1: token }]) {
      const logs = await pc.getLogs({ address: manager, event: initializeEvent, args, fromBlock: from, toBlock: to });
      for (const l of logs) {
        const a = l.args;
        if (a.currency0 && a.currency1 && a.fee !== undefined && a.tickSpacing !== undefined && a.hooks) {
          out.push({ currency0: a.currency0, currency1: a.currency1, fee: a.fee, tickSpacing: a.tickSpacing, hooks: a.hooks });
        }
      }
    }
  }
  return out;
}

/** |a - b| / b in bps. */
export function divergenceBps(a: bigint, b: bigint): number {
  if (b === 0n) return Number.POSITIVE_INFINITY;
  const d = a > b ? a - b : b - a;
  return Number((d * 10_000n) / b);
}

/** Median (lower middle) of a non-empty list; 0 for an empty one. */
export function median(xs: bigint[]): bigint {
  if (xs.length === 0) return 0n;
  const s = xs.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor((s.length - 1) / 2)] as bigint;
}

/** v3 arithmetic-mean tick over `secs` -> whole USDG per whole WETH (WAD). */
async function v3TwapUsdgPerEth(pc: PublicClient, pool: Address, weth: Address, usdg: Address, secs: number): Promise<bigint> {
  const [ticks] = await pc.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "observe", args: [[secs, 0]] });
  const delta = (ticks[1] as bigint) - (ticks[0] as bigint);
  let mean = delta / BigInt(secs);
  if (delta < 0n && delta % BigInt(secs) !== 0n) mean -= 1n; // round toward -infinity like OracleLibrary
  const raw1per0 = 1.0001 ** Number(mean); // token1 per token0, raw
  const wethIs0 = BigInt(weth) < BigInt(usdg);
  const usdgPerEth = wethIs0 ? (raw1per0 * 1e18) / 1e6 : 1e18 / 1e6 / raw1per0; // whole USDG per whole WETH
  return BigInt(Math.round(usdgPerEth * 1e6)) * 10n ** 12n;
}

/** sqrtPriceX96 of `key` at up to `n` blocks spread over the last ~`secs` seconds (blocks the RPC lacks: skipped). */
async function sampledSpots(pc: PublicClient, stateView: Address, key: PoolKey, n: number, secs: number): Promise<bigint[]> {
  const head = await pc.getBlock();
  const back = await pc.getBlock({ blockNumber: head.number > 1000n ? head.number - 1000n : 0n });
  const perSec = Number(head.number - back.number) / Math.max(Number(head.timestamp - back.timestamp), 1);
  const step = BigInt(Math.max(Math.floor((perSec * secs) / Math.max(n - 1, 1)), 1));
  const out: bigint[] = [];
  for (let i = 0; i < n; i++) {
    const blockNumber = head.number - step * BigInt(i);
    try {
      const s0 = await pc.readContract({ address: stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolId(key)], blockNumber });
      if (s0[0] > 0n) out.push(s0[0]);
    } catch {
      // state not available on this RPC (not an archive node)
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------- main

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const bkrnArg = arg("bkrn");
  if (!bkrnArg || !isAddress(bkrnArg)) throw new Error("--bkrn <BKRN token address> is required");
  const bkrn = getAddress(bkrnArg);
  const hookArg = arg("hook");
  const hook = hookArg ? getAddress(hookArg) : PONS_HOOK;
  const sizeUsd = BigInt(arg("size") ?? "1000");
  const size = sizeUsd * 10n ** 6n;
  const json = process.argv.includes("--json");
  const rpc = process.env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
  const pc = createPublicClient({ transport: http(rpc) }) as PublicClient;
  const chainId = await pc.getChainId();
  const v3 = UNISWAP_V3[chainId];
  const v4 = UNISWAP_V4[chainId];
  if (!v3 || !v4) throw new Error(`no Uniswap deployment known for chain ${chainId}`);
  const usdg = RHC_TOKENS.USDG;
  const weth = RHC_TOKENS.WETH;

  // BKRN pools: the Pons keys (ETH- and USDG-quoted), hook-less tiers, plus scanned ones
  const ethBkrnKeys: PoolKey[] = [sortKey(NATIVE, bkrn, PONS_FEE, PONS_TICK_SPACING, hook)];
  const usdgBkrnKeys: PoolKey[] = [sortKey(usdg, bkrn, PONS_FEE, PONS_TICK_SPACING, hook)];
  for (const [fee, ts] of V4_TIERS) {
    ethBkrnKeys.push(sortKey(NATIVE, bkrn, fee, ts, zeroAddress));
    usdgBkrnKeys.push(sortKey(usdg, bkrn, fee, ts, zeroAddress));
  }
  if (process.argv.includes("--scan")) {
    for (const k of await scanPools(pc, v4.poolManager, bkrn)) {
      const list = k.currency0 === NATIVE ? ethBkrnKeys : k.currency0 === usdg || k.currency1 === usdg ? usdgBkrnKeys : null;
      if (list && !list.some((x) => poolId(x) === poolId(k))) list.push(k);
    }
  }
  const live = async (keys: PoolKey[]) => {
    const r: Array<{ key: PoolKey; state: V4State }> = [];
    for (const key of keys) {
      const state = await v4State(pc, v4.stateView, key);
      if (state.sqrtPriceX96 > 0n && state.liquidity > 0n) r.push({ key, state });
    }
    return r;
  };
  const ethBkrn = await live(ethBkrnKeys);
  const usdgBkrn = await live(usdgBkrnKeys);
  const ethUsdg = await live(V4_TIERS.map(([fee, ts]) => sortKey(NATIVE, usdg, fee, ts, zeroAddress)));

  const v3Pools: Array<{ fee: number; pool: Address; liquidity: bigint; usdgPerEth: bigint }> = [];
  for (const fee of V3_TIERS) {
    const pool = await pc.readContract({ address: v3.factory, abi: uniswapV3FactoryAbi, functionName: "getPool", args: [usdg, weth, fee] });
    if (pool === zeroAddress) continue;
    const [liquidity, slot0] = await Promise.all([
      pc.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "liquidity" }),
      pc.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "slot0" }),
    ]);
    if (liquidity === 0n) continue;
    const wethIs0 = BigInt(weth) < BigInt(usdg);
    v3Pools.push({ fee, pool, liquidity, usdgPerEth: spotWad(slot0[0], wethIs0, 18, 6) });
  }

  const cands: Candidate[] = [];
  for (const { key } of usdgBkrn) {
    cands.push({ kind: "direct", bkrnPool: key, bkrnOut: await v4Quote(pc, v4.quoter, key, usdg, size) });
  }
  for (const { key: bk } of ethBkrn) {
    for (const { key: ek } of ethUsdg) {
      const ethOut = await v4Quote(pc, v4.quoter, ek, usdg, size);
      const out = ethOut ? await v4Quote(pc, v4.quoter, bk, NATIVE, ethOut) : null;
      cands.push({ kind: "v4Eth", bkrnPool: bk, ethPool: ek, ethOut, bkrnOut: out });
    }
    for (const p of v3Pools) {
      const ethOut = await v3Quote(pc, v3.quoterV2, usdg, weth, p.fee, size);
      const out = ethOut ? await v4Quote(pc, v4.quoter, bk, NATIVE, ethOut) : null;
      cands.push({ kind: "v3Weth", bkrnPool: bk, v3Fee: p.fee, v3Pool: p.pool, ethOut, bkrnOut: out });
    }
  }
  const pick = best(cands);
  // references (review 2026-10-23 L-3): never one block's spot. ETH/USD = the TWAP (`--twap` s, default 1800) of
  // the deepest v3 USDG/WETH pool; BKRN/ETH = the median spot of the PICKED BKRN pool over a few recent blocks
  // (`--samples`, spread over ~`--twap` s; a non-archive RPC keeps recent state only: missing blocks are skipped)
  const twapSec = Number(arg("twap") ?? "1800");
  const deepestEth = v3Pools.slice().sort((a, b) => (b.liquidity > a.liquidity ? 1 : -1))[0];
  let usdcPerEthWad = 0n;
  const warnings: string[] = [];
  if (deepestEth) {
    usdcPerEthWad = await v3TwapUsdgPerEth(pc, deepestEth.pool, weth, usdg, twapSec).catch(() => 0n);
    if (usdcPerEthWad === 0n) {
      warnings.push(`no ${twapSec}s TWAP on v3 ${deepestEth.pool}: ETH reference from its spot`);
      usdcPerEthWad = deepestEth.usdgPerEth;
    } else if (divergenceBps(usdcPerEthWad, deepestEth.usdgPerEth) > 100) {
      warnings.push(`ETH spot ${formatUnits(deepestEth.usdgPerEth, 18)} is >1% off its TWAP ${formatUnits(usdcPerEthWad, 18)}: check before proposing`);
    }
  } else if (ethUsdg[0]) {
    usdcPerEthWad = spotWad(ethUsdg[0].state.sqrtPriceX96, true, 18, 6);
    warnings.push("no v3 USDG/WETH pool: ETH reference from a v4 spot (single source)");
  }
  const bkrnEthKey = pick && pick.kind !== "direct" ? pick.bkrnPool : ethBkrn[0]?.key;
  let bkrnPerEthWad = 0n;
  if (bkrnEthKey) {
    const samples = await sampledSpots(pc, v4.stateView, bkrnEthKey, Number(arg("samples") ?? "5"), twapSec);
    bkrnPerEthWad = median(samples.map((sp) => spotWad(sp, true, 18, 18)));
    if (samples.length < 3) warnings.push(`BKRN/ETH reference from ${samples.length} block(s) only (RPC history): re-check before proposing`);
  }
  const hooks = pick ? [pick.bkrnPool.hooks, pick.ethPool?.hooks ?? zeroAddress].filter((h) => h !== zeroAddress) : [];

  const report = {
    warnings,
    chainId,
    bkrn,
    sizeUsdg: sizeUsd.toString(),
    pools: {
      ethBkrn: ethBkrn.map((p) => ({ ...p.key, poolId: poolId(p.key), liquidity: p.state.liquidity.toString(), bkrnPerEth: formatUnits(spotWad(p.state.sqrtPriceX96, true, 18, 18), 18) })),
      usdgBkrn: usdgBkrn.map((p) => ({ ...p.key, poolId: poolId(p.key), liquidity: p.state.liquidity.toString() })),
      ethUsdgV4: ethUsdg.map((p) => ({ ...p.key, poolId: poolId(p.key), liquidity: p.state.liquidity.toString(), usdgPerEth: formatUnits(spotWad(p.state.sqrtPriceX96, true, 18, 6), 18) })),
      usdgWethV3: v3Pools.map((p) => ({ fee: p.fee, pool: p.pool, liquidity: p.liquidity.toString(), usdgPerEth: formatUnits(p.usdgPerEth, 18) })),
    },
    candidates: cands.map((c) => ({
      kind: c.kind,
      bkrnPoolId: poolId(c.bkrnPool),
      ethPoolId: c.ethPool ? poolId(c.ethPool) : null,
      v3Fee: c.v3Fee ?? null,
      bkrnOut: c.bkrnOut === null ? null : formatUnits(c.bkrnOut, 18),
    })),
    best: pick
      ? {
          kind: pick.kind,
          bkrnOut: formatUnits(pick.bkrnOut as bigint, 18),
          bkrnPerUsdg: formatUnits(((pick.bkrnOut as bigint) * 10n ** 6n) / size, 18),
          deployInput: {
            venue: "univ4",
            v4Hooks: hooks,
            ethReference: pick.kind === "direct" ? undefined : { usdcPerEthWad: usdcPerEthWad.toString(), bkrnPerEthWad: bkrnPerEthWad.toString() },
            v4Route: deployInputRoute(pick, weth),
          },
          timelockCalls: [
            ...hooks.map((h) => ({ fn: `setV4HookAllowed(${h}, true)`, data: encodeFunctionData({ abi: bkrnFeeRouterAbi, functionName: "setV4HookAllowed", args: [h, true] }) })),
            ...(pick.kind === "direct"
              ? []
              : [{ fn: `setEthReference(${usdcPerEthWad}, ${bkrnPerEthWad})`, data: encodeFunctionData({ abi: bkrnFeeRouterAbi, functionName: "setEthReference", args: [usdcPerEthWad, bkrnPerEthWad] }) }]),
            { fn: "setV4Route(route)", data: encodeFunctionData({ abi: bkrnFeeRouterAbi, functionName: "setV4Route", args: [routeStruct(pick, weth)] }) },
            { fn: "setBuybackVenue(1)", data: encodeFunctionData({ abi: bkrnFeeRouterAbi, functionName: "setBuybackVenue", args: [1] }) },
          ],
        }
      : null,
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`BKRN ${bkrn} on chain ${chainId}; reference size ${sizeUsd} USDG`);
    console.log(`  v4 ETH/BKRN pools: ${ethBkrn.length}, v4 USDG/BKRN pools: ${usdgBkrn.length}, v4 ETH/USDG pools: ${ethUsdg.length}, v3 USDG/WETH pools: ${v3Pools.length}`);
    for (const c of report.candidates) console.log(`  ${c.kind.padEnd(7)} bkrnPool ${c.bkrnPoolId.slice(0, 10)} ${c.ethPoolId ? `ethPool ${c.ethPoolId.slice(0, 10)}` : c.v3Fee ? `v3 fee ${c.v3Fee}` : ""} -> ${c.bkrnOut ?? "no quote"} BKRN`);
    if (report.best) {
      console.log(`BEST ${report.best.kind}: ${report.best.bkrnOut} BKRN (${report.best.bkrnPerUsdg} BKRN per USDG)`);
      console.log("deploy input (buyback.*):");
      console.log(JSON.stringify(report.best.deployInput, null, 2));
      console.log("timelock calls on BkrnFeeRouter (schedule + execute through the TimelockController):");
      for (const t of report.best.timelockCalls) console.log(`  ${t.fn}\n    ${t.data}`);
      for (const w of warnings) console.log(`WARN ${w}`);
      console.log("Set setV4Fees(hookFeeBps, ...) to the hook's fee (Pons: ~1-3.5% observed on 2026-10-23), maxSlippageBps above it, and");
      console.log("refresh setEthReference whenever ETH moves more than (maxSlippageBps / 4 - 5 bps) from it (RUNBOOK); alert buyback_v4_reference_stale.");
    } else {
      console.log("no candidate route quotes (BKRN not graduated yet, or no pool with liquidity)");
    }
  }
  return pick ? 0 : 1;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    },
  );
}
