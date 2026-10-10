// Pre-launch hedge-route check (docs/VERIFY.md U4) — READ-ONLY: eth_call only, never sends a transaction.
// For every Stock Token in the StockTokenRegistry it prints the HedgeExecutor governance route (venue
// UNIV3), the Uniswap v3 pool(s) of that route with their in-range liquidity / spot tick / observation
// cardinality, and a QuoterV2 quote for a reference size: buy `--size` settlement tokens of the asset, then
// sell that amount back (round trip), with the slippage against the AttestedOracle valuation. It also
// checks the BKRN buyback pool and the BkrnFeeRouter reference source (fixed / TWAP / attested).
//
//   RPC_URL=<archive rpc> DEPLOYMENT_FILE=contracts/deployments/4663.json bun scripts/check-pools.ts
//   bun scripts/check-pools.ts --size 25000 --max-slippage-bps 150 --json
//   options: --size <whole settlement tokens, default 10000>  --venue <UNIV3>  --factory <addr>
//            --quoter <addr>  --max-slippage-bps <default 100>  --json
// Defaults: CHAIN_ID from the deployment file; factory / QuoterV2 from packages/shared/src/uniswap.ts for
// that chain (Robinhood Chain 4663). Devnet/testnet (MockSwapRouter, no v3 factory): routes are listed
// and quoted with MockSwapRouter.quote, pools are reported as "n/a". Exit code 1 when any active token
// fails (no route, missing pool, zero liquidity, failed quote, slippage above the bound).
import {
  bkrnFeeRouterAbi,
  bookrunnerConfigAbi,
  hedgeExecutorAbi,
  mockSwapRouterAbi,
  stockTokenRegistryAbi,
} from "../packages/shared/src/abi";
import { chainFor } from "../packages/shared/src/chains";
import { loadDeployment } from "../packages/shared/src/deployments";
import { quoterV2Abi, tickToPrice, uniswapV3FactoryAbi, uniswapV3For, uniswapV3PoolAbi } from "../packages/shared/src/uniswap";
import { type Address, type Hex, type PublicClient, createPublicClient, erc20Abi, formatUnits, getAddress, http, isAddress, stringToHex, zeroAddress } from "viem";

const BPS = 10_000n;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function addrArg(name: string): Address | undefined {
  const v = arg(name);
  if (v === undefined) return undefined;
  if (!isAddress(v)) throw new Error(`--${name}: not an address: ${v}`);
  return getAddress(v);
}

interface PoolInfo {
  pair: string;
  fee: number;
  pool: Address | null;
  liquidity: string | null;
  tick: number | null;
  spotPrice: number | null; // whole tokenB per whole tokenA of `pair` (tokenA/tokenB)
  observationCardinality: number | null;
}

interface TokenReport {
  symbol: string;
  token: Address;
  active: boolean;
  route: { fee: number; hop: Address | null; hopFee: number } | null;
  pools: PoolInfo[];
  buy: { amountIn: string; amountOut: string; oracleValue: string | null; slippageBps: number | null } | null;
  sell: { amountIn: string; amountOut: string; oracleValue: string | null; slippageBps: number | null } | null;
  problems: string[];
}

const meta = new Map<Address, { symbol: string; decimals: number }>();

async function tokenMeta(pc: PublicClient, token: Address): Promise<{ symbol: string; decimals: number }> {
  const hit = meta.get(token);
  if (hit) return hit;
  const [symbol, decimals] = await Promise.all([
    pc.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => token.slice(0, 8)),
    pc.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  const m = { symbol, decimals: Number(decimals) };
  meta.set(token, m);
  return m;
}

async function poolInfo(pc: PublicClient, factory: Address | null, a: Address, b: Address, fee: number): Promise<PoolInfo> {
  const [ma, mb] = await Promise.all([tokenMeta(pc, a), tokenMeta(pc, b)]);
  const info: PoolInfo = { pair: `${ma.symbol}/${mb.symbol}`, fee, pool: null, liquidity: null, tick: null, spotPrice: null, observationCardinality: null };
  if (!factory) return info;
  const pool = await pc.readContract({ address: factory, abi: uniswapV3FactoryAbi, functionName: "getPool", args: [a, b, fee] });
  if (pool === zeroAddress) return info;
  info.pool = pool;
  const [liq, slot0, token0] = await Promise.all([
    pc.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "liquidity" }),
    pc.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "slot0" }),
    pc.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "token0" }),
  ]);
  info.liquidity = liq.toString();
  info.tick = slot0[1];
  info.observationCardinality = slot0[3];
  // pool price is token1 per token0; report it as b per a
  const aIs0 = getAddress(token0) === getAddress(a);
  const p01 = tickToPrice(slot0[1], aIs0 ? ma.decimals : mb.decimals, aIs0 ? mb.decimals : ma.decimals);
  info.spotPrice = aIs0 ? p01 : 1 / p01;
  return info;
}

async function quote(
  pc: PublicClient,
  o: { quoter: Address | null; router: Address | null; tokenIn: Address; tokenOut: Address; amountIn: bigint; fee: number; path: Hex | null },
): Promise<bigint> {
  if (o.quoter) {
    if (o.path) {
      const { result } = await pc.simulateContract({ address: o.quoter, abi: quoterV2Abi, functionName: "quoteExactInput", args: [o.path, o.amountIn] });
      return result[0];
    }
    const { result } = await pc.simulateContract({
      address: o.quoter,
      abi: quoterV2Abi,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: o.tokenIn, tokenOut: o.tokenOut, amountIn: o.amountIn, fee: o.fee, sqrtPriceLimitX96: 0n }],
    });
    return result[0];
  }
  if (!o.router) throw new Error("no quoter and no router");
  // devnet/testnet MockSwapRouter prices swaps itself
  return pc.readContract({ address: o.router, abi: mockSwapRouterAbi, functionName: "quote", args: [o.tokenIn, o.tokenOut, o.amountIn] });
}

function slippage(given: bigint, received: bigint): number | null {
  if (given === 0n) return null;
  return Number(((given - received) * BPS) / given);
}

async function main() {
  const dep = loadDeployment();
  const chainId = Number(process.env.CHAIN_ID ?? dep.chainId);
  const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8547";
  const venueName = arg("venue") ?? "UNIV3";
  const venue = stringToHex(venueName, { size: 32 });
  const sizeWhole = BigInt(arg("size") ?? "10000");
  const maxSlipBps = Number(arg("max-slippage-bps") ?? "100");
  const json = process.argv.includes("--json");
  const uni = uniswapV3For(chainId);
  const factory = addrArg("factory") ?? uni?.factory ?? null;
  const quoter = addrArg("quoter") ?? uni?.quoterV2 ?? null;

  const pc = createPublicClient({ chain: chainFor(chainId, rpc), transport: http(rpc) }) as PublicClient;
  const config = dep.contracts.config;
  const [settlement, registry, executor, feeRouter, bkrn] = await Promise.all([
    pc.readContract({ address: config, abi: bookrunnerConfigAbi, functionName: "usdc" }),
    pc.readContract({ address: config, abi: bookrunnerConfigAbi, functionName: "stockRegistry" }),
    pc.readContract({ address: config, abi: bookrunnerConfigAbi, functionName: "hedgeExecutor" }),
    pc.readContract({ address: config, abi: bookrunnerConfigAbi, functionName: "feeRouter" }),
    pc.readContract({ address: config, abi: bookrunnerConfigAbi, functionName: "bkrn" }),
  ]);
  const sMeta = await tokenMeta(pc, settlement);
  const router = await pc.readContract({ address: executor, abi: hedgeExecutorAbi, functionName: "routerOf", args: [venue] });
  const amountIn = sizeWhole * 10n ** BigInt(sMeta.decimals);
  const tokens = await pc.readContract({ address: registry, abi: stockTokenRegistryAbi, functionName: "tokens" });

  const reports: TokenReport[] = [];
  for (const token of tokens) {
    const m = await tokenMeta(pc, token);
    const t = await pc.readContract({ address: registry, abi: stockTokenRegistryAbi, functionName: "getToken", args: [token] });
    const r: TokenReport = { symbol: m.symbol, token, active: t.active, route: null, pools: [], buy: null, sell: null, problems: [] };
    reports.push(r);
    try {
      const [fee, hop, hopFee] = await pc.readContract({ address: executor, abi: hedgeExecutorAbi, functionName: "routeOf", args: [venue, token] });
      if (fee === 0) {
        r.problems.push("no governance route (HedgeExecutor.setRoute via the timelock)");
        continue;
      }
      r.route = { fee, hop: hop === zeroAddress ? null : hop, hopFee };
      r.pools = r.route.hop
        ? [await poolInfo(pc, factory, settlement, r.route.hop, fee), await poolInfo(pc, factory, r.route.hop, token, hopFee)]
        : [await poolInfo(pc, factory, settlement, token, fee)];
      if (factory) {
        for (const p of r.pools) {
          if (!p.pool) r.problems.push(`no pool ${p.pair} @ ${p.fee}`);
          else if (p.liquidity === "0") r.problems.push(`zero in-range liquidity ${p.pair} @ ${p.fee}`);
        }
        if (r.problems.length) continue;
      }
      const buyPath = r.route.hop
        ? await pc.readContract({ address: executor, abi: hedgeExecutorAbi, functionName: "pathOf", args: [venue, settlement, token] })
        : null;
      const out = await quote(pc, { quoter, router, tokenIn: settlement, tokenOut: token, amountIn, fee, path: buyPath && buyPath !== "0x" ? buyPath : null });
      const value = await pc.readContract({ address: registry, abi: stockTokenRegistryAbi, functionName: "valueUsd", args: [token, out] }).catch(() => null);
      r.buy = { amountIn: formatUnits(amountIn, sMeta.decimals), amountOut: formatUnits(out, m.decimals), oracleValue: value === null ? null : formatUnits(value, 6), slippageBps: value === null ? null : slippage(amountIn, value) };
      const sellPath = r.route.hop
        ? await pc.readContract({ address: executor, abi: hedgeExecutorAbi, functionName: "pathOf", args: [venue, token, settlement] })
        : null;
      const back = await quote(pc, { quoter, router, tokenIn: token, tokenOut: settlement, amountIn: out, fee, path: sellPath && sellPath !== "0x" ? sellPath : null });
      r.sell = { amountIn: formatUnits(out, m.decimals), amountOut: formatUnits(back, sMeta.decimals), oracleValue: r.buy.oracleValue, slippageBps: value === null ? null : slippage(value, back) };
      if (r.buy.slippageBps !== null && r.buy.slippageBps > maxSlipBps) r.problems.push(`buy slippage ${r.buy.slippageBps} bps > ${maxSlipBps}`);
      if (r.sell.slippageBps !== null && r.sell.slippageBps > maxSlipBps) r.problems.push(`sell slippage ${r.sell.slippageBps} bps > ${maxSlipBps}`);
      if (value === null) r.problems.push("oracle valuation unavailable (stale or unset price): slippage not checked");
    } catch (err) {
      r.problems.push(`read/quote failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
    }
  }

  // BKRN buyback pool + reference source
  const buyback: Record<string, unknown> = {};
  const buybackProblems: string[] = [];
  try {
    const [poolFee, source, twapPool, twapWindow, ref] = await Promise.all([
      pc.readContract({ address: feeRouter, abi: bkrnFeeRouterAbi, functionName: "buybackPoolFee" }),
      pc.readContract({ address: feeRouter, abi: bkrnFeeRouterAbi, functionName: "referenceSource" }),
      pc.readContract({ address: feeRouter, abi: bkrnFeeRouterAbi, functionName: "twapPool" }),
      pc.readContract({ address: feeRouter, abi: bkrnFeeRouterAbi, functionName: "twapWindow" }),
      pc.readContract({ address: feeRouter, abi: bkrnFeeRouterAbi, functionName: "referenceBkrnPerUsdc" }).catch((e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e))),
    ]);
    buyback.poolFee = poolFee;
    buyback.referenceSource = ["fixed", "twap", "attested"][source] ?? `unknown(${source})`;
    buyback.twapPool = twapPool === zeroAddress ? null : twapPool;
    buyback.twapWindow = twapWindow;
    buyback.referenceBkrnPerSettlement = typeof ref === "bigint" ? formatUnits(ref, 18) : `reverts: ${ref}`;
    if (typeof ref !== "bigint") buybackProblems.push("reference price read reverts");
    if (poolFee === 0) buybackProblems.push("buyback params not set (setBuybackParams)");
    else {
      const p = await poolInfo(pc, factory, settlement, bkrn, poolFee);
      buyback.pool = p;
      if (factory && !p.pool) buybackProblems.push(`no ${p.pair} pool @ ${poolFee}`);
      const bbRouter = await pc.readContract({ address: feeRouter, abi: bkrnFeeRouterAbi, functionName: "buybackRouter" });
      const q = await quote(pc, { quoter, router: bbRouter, tokenIn: settlement, tokenOut: bkrn, amountIn, fee: poolFee, path: null }).catch(() => null);
      buyback.quoteBkrnOut = q === null ? null : formatUnits(q, 18);
      const floor = await pc.readContract({ address: feeRouter, abi: bkrnFeeRouterAbi, functionName: "buybackFloor", args: [amountIn] }).catch(() => null);
      buyback.floorBkrnOut = floor === null ? null : formatUnits(floor, 18);
      if (q !== null && floor !== null && q < floor) buybackProblems.push("pool quote below the on-chain floor (buybacks would revert)");
    }
  } catch (err) {
    buybackProblems.push(`buyback read failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
  }
  buyback.problems = buybackProblems;

  const failing = reports.filter((r) => r.active && r.problems.length > 0);
  const summary = {
    chainId,
    settlement: { address: settlement, symbol: sMeta.symbol, decimals: sMeta.decimals },
    venue: venueName,
    hedgeExecutor: executor,
    router,
    v3Factory: factory,
    quoterV2: quoter,
    referenceSize: `${sizeWhole} ${sMeta.symbol}`,
    tokens: reports,
    buyback,
    ok: failing.length === 0 && buybackProblems.length === 0,
  };

  if (json) {
    console.log(JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  } else {
    console.log(`chain ${chainId}  settlement ${sMeta.symbol} (${settlement}, ${sMeta.decimals} dp)  venue ${venueName}`);
    console.log(`HedgeExecutor ${executor}  router ${router}  v3 factory ${factory ?? "n/a"}  QuoterV2 ${quoter ?? "n/a (router quote)"}`);
    console.log(`reference size: ${sizeWhole} ${sMeta.symbol}\n`);
    for (const r of reports) {
      const route = r.route ? (r.route.hop ? `${r.route.fee} -> ${meta.get(r.route.hop)?.symbol ?? r.route.hop} -> ${r.route.hopFee}` : `direct @ ${r.route.fee}`) : "none";
      console.log(`${r.symbol.padEnd(8)} ${r.token}  ${r.active ? "active" : "inactive"}  route: ${route}`);
      for (const p of r.pools) {
        console.log(`    pool ${p.pair} @ ${p.fee}: ${p.pool ?? "n/a"}  liquidity ${p.liquidity ?? "n/a"}  tick ${p.tick ?? "n/a"}  spot ${p.spotPrice === null ? "n/a" : p.spotPrice.toPrecision(6)}  obs ${p.observationCardinality ?? "n/a"}`);
      }
      if (r.buy) console.log(`    buy  ${r.buy.amountIn} ${sMeta.symbol} -> ${r.buy.amountOut} ${r.symbol} (oracle $${r.buy.oracleValue ?? "?"}, slippage ${r.buy.slippageBps ?? "?"} bps)`);
      if (r.sell) console.log(`    sell ${r.sell.amountIn} ${r.symbol} -> ${r.sell.amountOut} ${sMeta.symbol} (slippage ${r.sell.slippageBps ?? "?"} bps)`);
      for (const p of r.problems) console.log(`    !! ${p}`);
    }
    console.log(`\nBKRN buyback: ${JSON.stringify(buyback, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    console.log(summary.ok ? "\nOK" : `\nFAIL: ${failing.length} active token(s) and ${buybackProblems.length} buyback problem(s)`);
  }
  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
