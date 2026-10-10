import { describe, expect, test } from "bun:test";
import { RHC_TOKENS, UNISWAP_V3, UNISWAP_V4, encodeV3Path, tickToPrice, uniswapV3For } from "../src/uniswap";

describe("uniswap (RHC)", () => {
  test("VERIFY U1/U2 addresses are present for 4663 only", () => {
    expect(uniswapV3For(4663)?.swapRouter02.toLowerCase()).toBe("0xcaf681a66d020601342297493863e78c959e5cb2");
    expect(uniswapV3For(4663)?.quoterV2.toLowerCase()).toBe("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7");
    expect(UNISWAP_V3[4663]?.factory.toLowerCase()).toBe("0x1f7d7550b1b028f7571e69a784071f0205fd2efa");
    expect(UNISWAP_V4[4663]?.universalRouter.toLowerCase()).toBe("0x8876789976decbfcbbbe364623c63652db8c0904");
    expect(uniswapV3For(46630)).toBeNull();
    expect(uniswapV3For(31337)).toBeNull();
    expect(RHC_TOKENS.USDG.toLowerCase()).toBe("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
  });

  test("encodeV3Path packs token(20) fee(3) token(20) like HedgeExecutor._path", () => {
    const a = "0x00000000000000000000000000000000000000aa";
    const b = "0x00000000000000000000000000000000000000bb";
    const c = "0x00000000000000000000000000000000000000cc";
    expect(encodeV3Path([a, b], [500])).toBe(`${a}0001f4${b.slice(2)}`);
    const p = encodeV3Path([a, b, c], [500, 3000]);
    expect((p.length - 2) / 2).toBe(20 + 3 + 20 + 3 + 20);
    expect(p).toBe(`${a}0001f4${b.slice(2)}000bb8${c.slice(2)}`);
    expect(() => encodeV3Path([a], [])).toThrow();
    expect(() => encodeV3Path([a, b], [0])).toThrow();
    expect(() => encodeV3Path([a, b], [1_000_000])).toThrow();
  });

  test("tickToPrice: 20 BKRN (18dp) per USDG (6dp) at tick 306282", () => {
    // token0 = USDG (6dp), token1 = BKRN (18dp)
    expect(tickToPrice(306_282, 6, 18)).toBeCloseTo(19.998, 2);
    expect(tickToPrice(0, 18, 18)).toBe(1);
  });
});
