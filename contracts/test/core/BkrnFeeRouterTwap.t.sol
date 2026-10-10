// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BkrnFeeRouter} from "../../src/BkrnFeeRouter.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {CoreFixture} from "./utils/CoreFixture.sol";
import {CoreMockOracle} from "./utils/CoreMocks.sol";
import {UniV3MockFactory, UniV3MockPool, UniV3MockRouter} from "../mocks/UniswapV3Mocks.sol";

/// @notice BKRN buyback reference from a Uniswap v3 TWAP (REF_TWAP), the source switch between
///         REF_FIXED / REF_TWAP / REF_ATTESTED, the bounds, and an end-to-end buyback through a faithful
///         SwapRouter02 stand-in priced by the pool's reserves.
contract BkrnFeeRouterTwapTest is CoreFixture {
    UniV3MockFactory internal v3;
    UniV3MockRouter internal v3router;
    UniV3MockPool internal pool; // BKRN/USDC 0.3%
    int24 internal tick20; // tick of 20 BKRN per USDC in this pool's orientation

    uint8 internal constant FIXED = 0;
    uint8 internal constant TWAP = 1;
    uint8 internal constant ATTESTED = 2;

    function setUp() public override {
        super.setUp();
        v3 = new UniV3MockFactory();
        v3router = new UniV3MockRouter(v3);
        v3.setRouter(address(v3router));
        // raw ratio 20e18 / 1e6 = 2e13 (token1 per token0): tick 306282 if USDC is token0, else -306283
        tick20 = address(usdc) < address(bkrn) ? int24(306_282) : int24(-306_283);
        pool = v3.createPool(address(usdc), address(bkrn), 3000, tick20);
        // reserves at 20 BKRN / USDC: 1,000,000 USDC + 20,000,000 BKRN
        usdc.mint(address(pool), 1_000_000e6);
        vm.prank(liquidity);
        bkrn.transfer(address(pool), 20_000_000e18);
        vm.warp(block.timestamp + 1 hours); // build observation history
    }

    function _useTwap(uint32 window, uint24 dev) internal {
        vm.startPrank(admin);
        feeRouter.setTwapParams(address(pool), window, dev);
        feeRouter.setReferenceSource(TWAP);
        vm.stopPrank();
    }

    function _carry(uint256 amount) internal {
        usdc.mint(address(feeRouter), amount);
        vm.prank(address(router));
        feeRouter.notifyCarry(BOOK_ID, amount);
    }

    // ------------------------------------------------------------------ configuration bounds

    function test_setTwapParams_bounds() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.NotAdmin.selector, keeper));
        feeRouter.setTwapParams(address(pool), 30 minutes, 200);

        vm.startPrank(admin);
        vm.expectRevert(BkrnFeeRouter.BadTwapParams.selector); // no code
        feeRouter.setTwapParams(makeAddr("eoa"), 30 minutes, 200);
        vm.expectRevert(BkrnFeeRouter.BadTwapParams.selector); // window too short
        feeRouter.setTwapParams(address(pool), 10 minutes - 1, 200);
        vm.expectRevert(BkrnFeeRouter.BadTwapParams.selector); // window too long
        feeRouter.setTwapParams(address(pool), 2 days + 1, 200);
        vm.expectRevert(BkrnFeeRouter.BadTwapParams.selector); // deviation 0
        feeRouter.setTwapParams(address(pool), 30 minutes, 0);
        vm.expectRevert(BkrnFeeRouter.BadTwapParams.selector); // deviation too wide
        feeRouter.setTwapParams(address(pool), 30 minutes, 2001);
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        UniV3MockPool wrong = v3.createPool(address(usdc), address(other), 3000, 0);
        vm.expectRevert(BkrnFeeRouter.BadTwapParams.selector); // not the BKRN/settlement pool
        feeRouter.setTwapParams(address(wrong), 30 minutes, 200);

        vm.expectEmit(false, false, false, true, address(feeRouter));
        emit BkrnFeeRouter.TwapParamsSet(address(pool), 30 minutes, 200);
        feeRouter.setTwapParams(address(pool), 30 minutes, 200);
        vm.stopPrank();
        assertEq(feeRouter.twapPool(), address(pool));
        assertEq(uint256(feeRouter.twapWindow()), 30 minutes);
        assertEq(uint256(feeRouter.twapMaxTickDeviation()), 200);
        // configuring does not switch the source
        assertEq(uint256(feeRouter.referenceSource()), FIXED);
    }

    function test_setReferenceSource_requiresConfiguredSource() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.NotAdmin.selector, keeper));
        feeRouter.setReferenceSource(TWAP);

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.BadReferenceSource.selector, TWAP));
        feeRouter.setReferenceSource(TWAP);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.BadReferenceSource.selector, ATTESTED));
        feeRouter.setReferenceSource(ATTESTED);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.BadReferenceSource.selector, uint8(3)));
        feeRouter.setReferenceSource(3);

        feeRouter.setTwapParams(address(pool), 30 minutes, 200);
        vm.expectEmit(false, false, false, true, address(feeRouter));
        emit BkrnFeeRouter.ReferenceSourceSet(TWAP);
        feeRouter.setReferenceSource(TWAP);
        assertEq(uint256(feeRouter.referenceSource()), TWAP);
        feeRouter.setReferenceSource(FIXED);
        assertEq(feeRouter.referenceBkrnPerUsdc(), 20e18);
        vm.stopPrank();
    }

    /// @dev setBkrnPriceId keeps its pre-TWAP meaning: non-zero selects ATTESTED, zero returns to FIXED
    ///      only from ATTESTED (a TWAP selection is left alone).
    function test_setBkrnPriceId_sourceSemantics() public {
        CoreMockOracle o = new CoreMockOracle();
        o.set("BKRN", 0.04e18, false, false);
        vm.startPrank(admin);
        config.setAddress("oracle", address(o));
        feeRouter.setBkrnPriceId("BKRN");
        assertEq(uint256(feeRouter.referenceSource()), ATTESTED);
        assertEq(feeRouter.referenceBkrnPerUsdc(), 25e18);
        feeRouter.setBkrnPriceId(bytes32(0));
        assertEq(uint256(feeRouter.referenceSource()), FIXED);

        feeRouter.setTwapParams(address(pool), 30 minutes, 200);
        feeRouter.setReferenceSource(TWAP);
        feeRouter.setBkrnPriceId(bytes32(0));
        assertEq(uint256(feeRouter.referenceSource()), TWAP);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ TWAP reads

    function test_twapReference_matchesPoolPrice() public {
        _useTwap(30 minutes, 200);
        assertApproxEqRel(feeRouter.referenceBkrnPerUsdc(), 20e18, 2e14); // tick granularity ~1bp
        assertEq(feeRouter.referenceBkrnPerUsdc(), feeRouter.twapBkrnPerUsdc());
        // floor = amountIn x ref x 95%
        assertApproxEqRel(feeRouter.buybackFloor(10e6), 190e18, 2e14);
    }

    /// @dev A spot push that the window has not absorbed is refused (TwapDeviation); once the move is
    ///      old enough the mean follows it and buybacks resume at the new level.
    function test_twap_refusesWhileSpotDeviates_thenFollows() public {
        _useTwap(30 minutes, 200);
        int24 pushed = tick20 + (address(usdc) < address(bkrn) ? int24(-1000) : int24(1000)); // BKRN +10%
        pool.setTick(pushed);
        vm.expectPartialRevert(BkrnFeeRouter.TwapDeviation.selector);
        feeRouter.referenceBkrnPerUsdc();
        vm.expectPartialRevert(BkrnFeeRouter.TwapDeviation.selector);
        feeRouter.buybackFloor(1e6);

        // 2 minutes later the mean moved only ~67 ticks: still refused
        vm.warp(block.timestamp + 2 minutes);
        vm.expectPartialRevert(BkrnFeeRouter.TwapDeviation.selector);
        feeRouter.referenceBkrnPerUsdc();

        // after a full window the mean is the new level (~18.1 BKRN per USDC)
        vm.warp(block.timestamp + 30 minutes);
        assertApproxEqRel(feeRouter.referenceBkrnPerUsdc(), 18.0967e18, 1e15);
    }

    function test_twap_failsClosedWithoutHistoryOrPool() public {
        // window longer than the pool's observation history ("OLD" in the pool)
        _useTwap(2 days, 200);
        vm.expectRevert(bytes("OLD"));
        feeRouter.referenceBkrnPerUsdc();
        _carry(2e6);
        vm.prank(keeper);
        vm.expectRevert(bytes("OLD"));
        feeRouter.executeBuyback(1e6, 0);
        assertEq(feeRouter.buybackPending(), 1e6);
    }

    // ------------------------------------------------------------------ end to end

    function test_buyback_throughV3Router_withTwapFloor() public {
        _stake(alice, 1e18);
        _useTwap(30 minutes, 200);
        vm.prank(admin);
        feeRouter.setBuybackRouter(address(v3router));
        _carry(2000e6); // 1000 USDC pending

        uint256 floor = feeRouter.buybackFloor(1000e6);
        vm.prank(keeper);
        uint256 out = feeRouter.executeBuyback(1000e6, 0);
        assertGe(out, floor);
        assertEq(uint256(v3router.lastFee()), 3000); // pinned tier
        assertEq(feeRouter.buybackPending(), 0);
        assertEq(bkrn.balanceOf(address(staking)) >= out, true);
    }

    /// @dev The pool's reserves are drained to an off-TWAP price within one block (sandwich setup): the
    ///      TWAP floor makes the buyback revert instead of filling at the manipulated price.
    function test_buyback_manipulatedReserves_reverts() public {
        _useTwap(30 minutes, 200);
        vm.prank(admin);
        feeRouter.setBuybackRouter(address(v3router));
        _carry(2000e6);
        // someone dumps USDC into the pool -> BKRN 3x more expensive at spot (reserves only; tick unchanged)
        usdc.mint(address(pool), 2_000_000e6);
        vm.prank(keeper);
        vm.expectRevert(bytes("Too little received"));
        feeRouter.executeBuyback(1000e6, 0);
        assertEq(feeRouter.buybackPending(), 1000e6);
    }
}
