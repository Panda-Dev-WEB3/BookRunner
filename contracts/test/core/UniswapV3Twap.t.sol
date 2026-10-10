// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {UniswapV3Twap} from "../../src/libraries/UniswapV3Twap.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {UniV3MockFactory, UniV3MockPool} from "../mocks/UniswapV3Mocks.sol";

contract TwapHarness {
    function sqrtAt(int24 t) external pure returns (uint160) {
        return UniswapV3Twap.sqrtRatioAtTick(t);
    }

    function quote(int24 t, uint128 base, address b, address q) external pure returns (uint256) {
        return UniswapV3Twap.quoteAtTick(t, base, b, q);
    }

    function mean(address pool, uint32 w) external view returns (int24) {
        return UniswapV3Twap.meanTick(pool, w);
    }
}

/// @notice UniswapV3Twap: TickMath vectors (canonical getSqrtRatioAtTick outputs, cross-checked offline
///         against sqrt(1.0001^tick) * 2^96 at 120-digit precision), OracleLibrary quote/mean-tick maths.
contract UniswapV3TwapTest is Test {
    TwapHarness internal h;

    function setUp() public {
        h = new TwapHarness();
        vm.warp(1_700_000_000);
    }

    function test_sqrtRatioAtTick_vectors() public view {
        assertEq(h.sqrtAt(-887_272), 4_295_128_739);
        assertEq(h.sqrtAt(887_272), 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342);
        assertEq(h.sqrtAt(0), 79_228_162_514_264_337_593_543_950_336); // 2^96
        assertEq(h.sqrtAt(1), 79_232_123_823_359_799_118_286_999_568);
        assertEq(h.sqrtAt(-1), 79_224_201_403_219_477_170_569_942_574);
        assertEq(h.sqrtAt(50), 79_426_470_787_362_580_746_886_972_461);
        assertEq(h.sqrtAt(-50), 79_030_349_367_926_598_376_800_521_322);
        assertEq(h.sqrtAt(100_000), 11_755_562_826_496_067_164_730_007_768_450);
        assertEq(h.sqrtAt(-100_000), 533_968_626_430_936_354_154_228_408);
        assertEq(h.sqrtAt(276_324), 79_228_057_781_537_899_283_318_961_129_827_820);
        assertEq(h.sqrtAt(-276_324), 79_228_267_247_129_223_624_114);
    }

    function test_sqrtRatioAtTick_outOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Twap.TickOutOfRange.selector, int24(-887_273)));
        h.sqrtAt(-887_273);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3Twap.TickOutOfRange.selector, int24(887_273)));
        h.sqrtAt(887_273);
    }

    function testFuzz_sqrtRatioAtTick_monotonic(int24 t) public view {
        t = int24(bound(int256(t), -887_271, 887_271));
        assertLt(h.sqrtAt(t), h.sqrtAt(t + 1));
    }

    function test_quoteAtTick_identityAndDirection() public view {
        address lo = address(0x1000);
        address hi = address(0x2000);
        assertEq(h.quote(0, 1e18, lo, hi), 1e18);
        assertEq(h.quote(0, 1e18, hi, lo), 1e18);
        // tick 23028 ~ price 10.0 (token1 per token0): 1 token0 -> ~10 token1, 1 token1 -> ~0.1 token0
        uint256 up = h.quote(23_028, 1e18, lo, hi);
        uint256 down = h.quote(23_028, 1e18, hi, lo);
        assertApproxEqRel(up, 10e18, 1e14);
        assertApproxEqRel(down, 0.1e18, 1e14);
        // the large-ratio branch (sqrtRatio > uint128.max)
        uint256 big = h.quote(500_000, 1, lo, hi);
        assertApproxEqRel(big, 5_171_760_815_372_400_971_558, 1e9); // 1.0001^500000 = 5.1717608153724009715581e21
    }

    /// @dev 20 BKRN (18dp) per USDC (6dp) is a raw ratio of 2e13: tick 306282 (token0 = USDC).
    function test_quoteAtTick_bkrnPerUsdc() public view {
        address usdc = address(0x1000);
        address bkrn = address(0x2000);
        assertApproxEqRel(h.quote(306_282, 1e6, usdc, bkrn), 20e18, 2e14);
        // reversed orientation: token0 = BKRN, tick -306283
        assertApproxEqRel(h.quote(-306_283, 1e6, bkrn, usdc), 20e18, 2e14);
    }

    function test_meanTick_windowAndRoundingTowardNegativeInfinity() public {
        UniV3MockFactory f = new UniV3MockFactory();
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        UniV3MockPool pool = f.createPool(address(a), address(b), 3000, -10);
        vm.warp(block.timestamp + 100);
        assertEq(h.mean(address(pool), 100), -10);
        // 50s at -10 then 50s at -11 => mean -10.5 => floors to -11
        pool.setTick(-11);
        vm.warp(block.timestamp + 50);
        assertEq(h.mean(address(pool), 100), -11);
        // positive side truncates: 50s at 11 after 50s at 10 => 10.5 => 10
        UniV3MockPool p2 = f.createPool(address(a), address(b), 500, 10);
        vm.warp(block.timestamp + 50);
        p2.setTick(11);
        vm.warp(block.timestamp + 50);
        assertEq(h.mean(address(p2), 100), 10);
        // older than the oldest observation
        vm.expectRevert(bytes("OLD"));
        h.mean(address(p2), 101);
        vm.expectRevert(UniswapV3Twap.ZeroWindow.selector);
        h.mean(address(p2), 0);
    }
}
