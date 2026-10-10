// Uniswap on Robinhood Chain (docs/VERIFY.md §6) + the read-only ABIs used by the buyback keeper and
// scripts/check-pools.ts. Addresses are from Uniswap's deployment pages; re-check each one on-chain
// (`cast code <addr>` non-empty) right before mainnet use.
import { type Address, type Hex, concatHex, getAddress, numberToHex, parseAbi } from "viem";

export interface UniswapV3Deployment {
  swapRouter02: Address;
  factory: Address;
  quoterV2: Address;
  positionManager: Address;
}

export interface UniswapV4Deployment {
  poolManager: Address;
  /** VERIFY U3: a third-party guide says this UniversalRouter is a Robinhood-modified fork (extra
   *  `minHopPriceX36` in its v4 swap struct); Uniswap's page also lists UniversalRouter 2.1.2. */
  universalRouter: Address;
  universalRouter212: Address;
  quoter: Address;
  stateView: Address;
}

/** VERIFY U1 (Confirmed against Uniswap's v3 Robinhood Chain deployments page). */
export const UNISWAP_V3: Readonly<Record<number, UniswapV3Deployment>> = {
  4663: {
    swapRouter02: getAddress("0xcaf681a66d020601342297493863e78c959e5cb2"),
    factory: getAddress("0x1f7d7550b1b028f7571e69a784071f0205fd2efa"),
    quoterV2: getAddress("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"),
    positionManager: getAddress("0x73991a25c818bf1f1128deaab1492d45638de0d3"),
  },
};

/** VERIFY U2 (Uniswap v4 deployments page). Not wired: HedgeExecutor UNIV4 stays NotConfigured (U3). */
export const UNISWAP_V4: Readonly<Record<number, UniswapV4Deployment>> = {
  4663: {
    poolManager: getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951"),
    universalRouter: getAddress("0x8876789976decbfcbbbe364623c63652db8c0904"),
    universalRouter212: getAddress("0x204FAca1764B154221e35c0d20aBb3c525710498"),
    quoter: getAddress("0x8dc178efb8111bb0973dd9d722ebeff267c98f94"),
    stateView: getAddress("0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"),
  },
};

/** Canonical tokens on Robinhood Chain mainnet (VERIFY S1 / S3; docs.robinhood.com/chain/contracts). */
export const RHC_TOKENS = {
  USDG: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  WETH: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
} as const;

export function uniswapV3For(chainId: number): UniswapV3Deployment | null {
  return UNISWAP_V3[chainId] ?? null;
}

export const uniswapV3FactoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"]);

export const uniswapV3PoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);

/** QuoterV2 is non-view (it reverts internally to return the quote): call it with eth_call / simulateContract. */
export const quoterV2Abi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

/** Packed v3 path: token, fee (3 bytes), token, ... */
export function encodeV3Path(tokens: readonly Address[], fees: readonly number[]): Hex {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) throw new Error("encodeV3Path: need n tokens and n-1 fees");
  const parts: Hex[] = [];
  tokens.forEach((t, i) => {
    parts.push(getAddress(t).toLowerCase() as Hex);
    if (i < fees.length) {
      const f = fees[i]!;
      if (!Number.isInteger(f) || f <= 0 || f >= 1_000_000) throw new Error(`encodeV3Path: bad fee ${f}`);
      parts.push(numberToHex(f, { size: 3 }));
    }
  });
  return concatHex(parts);
}

/** Price of one whole token0 in whole token1 at `tick` (float; display only). */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1);
}
