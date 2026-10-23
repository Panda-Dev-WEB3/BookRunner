import { describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionData, getAddress, zeroAddress } from "viem";
import { bkrnFeeRouterAbi } from "../packages/shared/src/abi";
import { type Candidate, PONS_HOOK, best, deployInputRoute, divergenceBps, median, poolId, routeStruct, sortKey, spotWad } from "./buyback-route";

const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const BKRN = getAddress("0xE75F02879217df5d6D7dC7CD842f31aBa6c3dc9f");

describe("buyback-route (pure)", () => {
  test("pool keys sort currencies like v4 (native ETH first) and hash like PoolIdLibrary", () => {
    const k = sortKey(BKRN, zeroAddress, 0, 200, PONS_HOOK);
    expect(k.currency0).toBe(zeroAddress);
    expect(k.currency1).toBe(BKRN);
    // a Pons ETH pool seen on Robinhood Chain (PoolManager Initialize log, 2026-10-23)
    expect(poolId(k)).toBe("0xc4dfac457a5b578e0613fa860363113d419a98a616733ce5cedd4ecc2e0efad1");
    expect(poolId(sortKey(zeroAddress, USDG, 500, 10, zeroAddress))).toBe("0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982");
  });

  test("best route: most BKRN, then fewer hops, then v4 over v3; non-quoting candidates ignored", () => {
    const bk = sortKey(zeroAddress, BKRN, 0, 200, PONS_HOOK);
    const c = (kind: Candidate["kind"], out: bigint | null): Candidate => ({ kind, bkrnPool: bk, bkrnOut: out });
    expect(best([c("v4Eth", 10n), c("v3Weth", 12n), c("direct", null)])?.kind).toBe("v3Weth");
    expect(best([c("v3Weth", 10n), c("v4Eth", 10n)])?.kind).toBe("v4Eth");
    expect(best([c("v4Eth", 10n), c("direct", 10n)])?.kind).toBe("direct");
    expect(best([c("direct", null), c("v4Eth", 0n)])).toBeNull();
  });

  test("setV4Route calldata and the deploy-input object carry exactly the chosen route", () => {
    const bk = sortKey(zeroAddress, BKRN, 0, 200, PONS_HOOK);
    const eth = sortKey(zeroAddress, USDG, 500, 10, zeroAddress);
    const v4: Candidate = { kind: "v4Eth", bkrnPool: bk, ethPool: eth, bkrnOut: 1n };
    const data = encodeFunctionData({ abi: bkrnFeeRouterAbi, functionName: "setV4Route", args: [routeStruct(v4, WETH)] });
    const { args } = decodeFunctionData({ abi: bkrnFeeRouterAbi, data });
    expect(args?.[0]).toMatchObject({ kind: 1, v3Fee: 0, weth: zeroAddress, ethPool: { currency1: USDG, fee: 500, tickSpacing: 10 } });
    expect(deployInputRoute(v4, WETH)).toEqual({ kind: "v4Eth", bkrnPool: bk, ethPool: eth });
    const v3: Candidate = { kind: "v3Weth", bkrnPool: bk, v3Fee: 100, bkrnOut: 1n };
    expect(routeStruct(v3, WETH)).toMatchObject({ kind: 2, v3Fee: 100, weth: WETH, ethPool: { currency0: zeroAddress, fee: 0 } });
    expect(deployInputRoute(v3, WETH)).toEqual({ kind: "v3Weth", bkrnPool: bk, v3Fee: 100, weth: WETH });
  });

  test("spot price from sqrtPriceX96 in whole units", () => {
    // 2,400 USDG per ETH, ETH token0 (18 dp), USDG token1 (6 dp): raw 2.4e-9 -> sqrt * 2^96
    const sqrt = 3_881_371_428_364_983_705_067_955n; // floor(sqrt(2.4e-9) * 2^96)
    expect(Number(spotWad(sqrt, true, 18, 6)) / 1e18).toBeCloseTo(2400, 3);
    expect(Number(spotWad(sqrt, false, 6, 18)) / 1e18).toBeCloseTo(1 / 2400, 9);
    expect(spotWad(0n, true, 18, 6)).toBe(0n);
  });

  test("references are never one sample: median of block samples, divergence in bps", () => {
    expect(median([5n, 1n, 3n])).toBe(3n);
    expect(median([4n, 1n, 3n, 2n])).toBe(2n); // lower middle
    expect(median([])).toBe(0n);
    expect(divergenceBps(101n, 100n)).toBe(100);
    expect(divergenceBps(99n, 100n)).toBe(100);
    expect(divergenceBps(1n, 0n)).toBe(Number.POSITIVE_INFINITY);
  });
});
