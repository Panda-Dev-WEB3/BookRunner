// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BkrnFeeRouter} from "../../src/BkrnFeeRouter.sol";
import {BuybackGuard} from "../../src/BuybackGuard.sol";
import {IBkrnV4Swapper} from "../../src/interfaces/IBkrnV4Swapper.sol";
import {IV4PoolManager} from "../../src/interfaces/external/IUniswapV4.sol";
import {UniswapV3Twap} from "../../src/libraries/UniswapV3Twap.sol";
import {UniswapV4Lib} from "../../src/libraries/UniswapV4Lib.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {CoreFixture} from "./utils/CoreFixture.sol";
import {UniV3MockFactory, UniV3MockPool} from "../mocks/UniswapV3Mocks.sol";
import {MockV4PoolManager, MockWETH} from "../mocks/UniswapV4Mocks.sol";

/// @dev A router stand-in for the guard's sizing reads (venue, pools, route).
contract StubRouter {
    uint8 public buybackVenue;
    address public twapPool;
    address public v4PoolManager;
    IBkrnV4Swapper.V4Route internal _route;

    function setV3(address pool) external {
        buybackVenue = 0;
        twapPool = pool;
    }

    function setV4(address manager, IBkrnV4Swapper.V4Route memory r) external {
        buybackVenue = 1;
        v4PoolManager = manager;
        _route = r;
    }

    function v4Route() external view returns (IBkrnV4Swapper.V4Route memory) {
        return _route;
    }
}

/// @notice Tech update #9 (buyback automation): the ETH reference read on chain from the WETH / USDG Uniswap v3 pool's
///         TWAP (bounded: liquidity floor, spot-vs-mean deviation, per-update move clamp, governance fallback with an
///         expiry), the depth-bounded buyback size (governance impact bound), and the router wiring.
contract BuybackGuardTest is CoreFixture {
    UniV3MockFactory internal v3;
    MockERC20 internal weth;
    UniV3MockPool internal ethPool; // WETH / USDG 0.01%
    BuybackGuard internal guard;
    StubRouter internal stub;
    BuybackGuard internal sizeGuard; // reads the stub router

    /// @dev raw price 2,000e6 / 1e18 = 2e-9 (token1 per token0 when WETH is token0): tick -200,312 (else +200,312)
    int24 internal constant ETH_TICK = 200_312;
    uint256 internal constant ETH_USD = 2000e18;
    uint32 internal constant WINDOW = 30 minutes;

    bool internal wethIs0;

    function setUp() public override {
        super.setUp();
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        wethIs0 = address(weth) < address(usdc);
        v3 = new UniV3MockFactory();
        ethPool = v3.createPool(address(usdc), address(weth), 100, _ethTick(0));
        ethPool.setLiquidity(1e18);
        guard = new BuybackGuard(address(config), address(feeRouter));
        stub = new StubRouter();
        sizeGuard = new BuybackGuard(address(config), address(stub));
        vm.warp(block.timestamp + 2 hours); // observation history longer than the window
        vm.startPrank(admin);
        guard.setEthTwap(address(ethPool), WINDOW, 200, 1e17, 500, 1 hours);
        vm.stopPrank();
    }

    /// @dev Tick of ETH at ~2,000 USDG (+ `off` ticks in the direction of a HIGHER ETH price).
    function _ethTick(int24 off) internal view returns (int24) {
        return wethIs0 ? -ETH_TICK + off : ETH_TICK - off;
    }

    // ------------------------------------------------------------------------------------------- ETH reference: TWAP

    function test_poke_storesThePoolTwap() public {
        uint256 v = guard.pokeEthReference();
        assertApproxEqRel(v, ETH_USD, 0.0005e18);
        assertEq(guard.ethRefWad(), v);
        assertEq(guard.ethRefAt(), block.timestamp);
        (uint256 value, uint8 source, uint64 at) = guard.ethReference();
        assertEq(value, v);
        assertEq(source, 1);
        assertEq(at, block.timestamp);
        assertEq(guard.ethUsdcPerEth(), v);
    }

    function test_poke_meanOfAMovingPool() public {
        // 20 minutes at ETH 2,000, then 10 minutes at +100 ticks (~+1%): window mean = 2,000 x 1.0001^(100/3)
        vm.warp(block.timestamp + 20 minutes);
        ethPool.setTick(_ethTick(100));
        vm.warp(block.timestamp + 10 minutes);
        uint256 v = guard.pokeEthReference();
        assertApproxEqRel(v, ETH_USD * 10_033 / 10_000, 0.001e18);
    }

    function test_poke_refusedWhileThePoolIsThin() public {
        ethPool.setLiquidity(1e17 - 1);
        vm.expectRevert(abi.encodeWithSelector(BuybackGuard.EthPoolThin.selector, uint128(1e17 - 1), uint128(1e17)));
        guard.pokeEthReference();
        ethPool.setLiquidity(1e17);
        guard.pokeEthReference();
    }

    function test_poke_refusedWithoutHistoryForTheWindow() public {
        UniV3MockPool fresh = v3.createPool(address(usdc), address(weth), 500, _ethTick(0));
        fresh.setLiquidity(1e18);
        vm.prank(admin);
        guard.setEthTwap(address(fresh), WINDOW, 200, 1e17, 500, 1 hours);
        vm.expectRevert(bytes("OLD"));
        guard.pokeEthReference();
    }

    function test_poke_notConfigured() public {
        BuybackGuard g = new BuybackGuard(address(config), address(feeRouter));
        vm.expectRevert(BuybackGuard.NotConfigured.selector);
        g.pokeEthReference();
        vm.expectRevert(BuybackGuard.EthReferenceUnavailable.selector);
        g.ethUsdcPerEth();
    }

    function test_poke_minimumInterval() public {
        guard.pokeEthReference();
        vm.warp(block.timestamp + 5 minutes - 1);
        vm.expectRevert(abi.encodeWithSelector(BuybackGuard.TooSoon.selector, guard.ethRefAt() + 5 minutes));
        guard.pokeEthReference();
        vm.warp(block.timestamp + 1);
        guard.pokeEthReference();
    }

    function test_poke_priceOutsideTheSaneRangeIsRefused() public {
        // a pool at ~$50 per ETH (tick shifted by -32,000 ticks ~ x24 down): refused, never stored
        ethPool.setTick(_ethTick(-32_000));
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert();
        guard.pokeEthReference();
        assertEq(guard.ethRefWad(), 0);
    }

    // ------------------------------------------------------------------------------------------- manipulation

    /// @dev A spot push beyond the deviation bound, left in place at the poke: refused (the reference stays).
    function test_manipulation_spotPushBeyondTheBoundIsRefused() public {
        uint256 v0 = guard.pokeEthReference();
        vm.warp(block.timestamp + 6 minutes);
        ethPool.setTick(_ethTick(3000)); // ETH +35% in the same block as the poke
        vm.expectRevert();
        guard.pokeEthReference();
        assertEq(guard.ethRefWad(), v0);
    }

    /// @dev A spot push INSIDE the deviation bound (150 of 200 ticks, ~1.5%) held for the poke's block only: the mean over
    ///      the window did not see it at all (zero duration): the stored reference is unchanged.
    function test_manipulation_oneBlockPushInsideTheBoundDoesNotMoveTheMean() public {
        uint256 v0 = guard.pokeEthReference();
        vm.warp(block.timestamp + 6 minutes);
        ethPool.setTick(_ethTick(150));
        uint256 v1 = guard.pokeEthReference(); // same block as the push
        assertEq(v1, v0, "a push with no time under it is invisible to the mean");
    }

    /// @dev The same push held for one block (12 s) and then reverted: the 30-minute mean moves by 150 x 12 / 1800 = 1
    ///      tick (0.01%), nothing like the push (1.5%). And one 3,000-tick push for one block moves it 20 ticks (0.2%).
    function test_manipulation_oneBlockPushMovesTheTwapByAFractionOfItself() public {
        uint256 v0 = guard.pokeEthReference();
        vm.warp(block.timestamp + 6 minutes);
        ethPool.setTick(_ethTick(3000));
        vm.warp(block.timestamp + 12); // one block under the push
        ethPool.setTick(_ethTick(0)); // reverted by the attacker (or arbitrage)
        vm.warp(block.timestamp + 5 minutes + 1);
        uint256 v1 = guard.pokeEthReference();
        uint256 moved = v1 > v0 ? v1 - v0 : v0 - v1;
        assertLt(moved * 10_000 / v0, 30, "less than 0.3% for a 35% spot push");
        assertGt(moved, 0, "the push is in the average, scaled by its duration");
    }

    /// @dev Sustained for the whole window the move is real: the reference follows, but at most `ethMaxMoveBps` (5%) per
    ///      update and at most one update per MIN_POKE_INTERVAL.
    function test_clamp_aRealMoveIsFollowedAFiveHundredBpsStepAtATime() public {
        uint256 v0 = guard.pokeEthReference();
        ethPool.setTick(_ethTick(1900)); // ETH +21%, and it stays
        vm.warp(block.timestamp + 2 hours);
        uint256 v1 = guard.pokeEthReference();
        assertEq(v1, Math.mulDiv(v0, 10_500, 10_000), "first step: +5% of the previous value");
        vm.warp(block.timestamp + 5 minutes);
        uint256 v2 = guard.pokeEthReference();
        assertEq(v2, Math.mulDiv(v1, 10_500, 10_000));
        vm.warp(block.timestamp + 5 minutes);
        uint256 v3_ = guard.pokeEthReference();
        assertEq(v3_, Math.mulDiv(v2, 10_500, 10_000));
        vm.warp(block.timestamp + 5 minutes);
        uint256 v4 = guard.pokeEthReference();
        // the 4th step would be 2,430: the pool's own TWAP (1.0001^1900 x 2,000 ~ 2,418.5) is the limit
        assertApproxEqRel(v4, 2418.5e18, 0.002e18);
    }

    function test_clamp_downwardsToo() public {
        uint256 v0 = guard.pokeEthReference();
        ethPool.setTick(_ethTick(-1900));
        vm.warp(block.timestamp + 2 hours);
        assertEq(guard.pokeEthReference(), Math.mulDiv(v0, 9500, 10_000));
    }

    function test_firstPokeIsAnchoredOnTheLiveFallback() public {
        vm.prank(admin);
        guard.setEthFallback(1000e18, uint64(block.timestamp + 7 days));
        // the pool says ~2,000, far from the 1,000 fallback: the first stored value is the fallback +5%
        assertEq(guard.pokeEthReference(), 1050e18);
    }

    // ------------------------------------------------------------------------------------------- fallback and expiry

    function test_staleTwapFallsBackToTheUnexpiredGovernanceValue_thenToNothing() public {
        guard.pokeEthReference();
        vm.prank(admin);
        guard.setEthFallback(2100e18, uint64(block.timestamp + 7 days));
        vm.warp(block.timestamp + 1 hours); // still trusted at exactly ethMaxAge
        (, uint8 s,) = guard.ethReference();
        assertEq(s, 1);
        vm.warp(block.timestamp + 1);
        (uint256 v, uint8 s2,) = guard.ethReference();
        assertEq(s2, 2);
        assertEq(v, 2100e18);
        assertEq(guard.ethUsdcPerEth(), 2100e18);
        vm.warp(block.timestamp + 7 days);
        (, uint8 s3,) = guard.ethReference();
        assertEq(s3, 0);
        vm.expectRevert(BuybackGuard.EthReferenceUnavailable.selector);
        guard.ethUsdcPerEth();
        // a poke restores the on-chain reference
        guard.pokeEthReference();
        assertGt(guard.ethUsdcPerEth(), 0);
    }

    function test_setEthFallback_boundsAndClear() public {
        vm.startPrank(admin);
        vm.expectRevert(BuybackGuard.BadParams.selector);
        guard.setEthFallback(99e18, uint64(block.timestamp + 1 days));
        vm.expectRevert(BuybackGuard.BadParams.selector);
        guard.setEthFallback(100_001e18, uint64(block.timestamp + 1 days));
        vm.expectRevert(BuybackGuard.BadParams.selector);
        guard.setEthFallback(2000e18, uint64(block.timestamp)); // already expired
        vm.expectRevert(BuybackGuard.BadParams.selector);
        guard.setEthFallback(2000e18, uint64(block.timestamp + 30 days + 1)); // beyond the ttl
        guard.setEthFallback(2000e18, uint64(block.timestamp + 30 days));
        assertEq(guard.fallbackWad(), 2000e18);
        guard.setEthFallback(0, 0);
        assertEq(guard.fallbackWad(), 0);
        assertEq(guard.fallbackExpiry(), 0);
        vm.stopPrank();
    }

    function test_setEthTwap_validation() public {
        vm.startPrank(admin);
        UniV3MockPool wrongPair = v3.createPool(address(bkrn), address(weth), 3000, 0);
        vm.expectRevert(BuybackGuard.BadParams.selector);
        guard.setEthTwap(address(wrongPair), WINDOW, 200, 1e17, 500, 1 hours); // no settlement token
        MockERC20 other = new MockERC20("Six", "SIX", 6);
        UniV3MockPool sixDec = v3.createPool(address(usdc), address(other), 3000, 0);
        vm.expectRevert(BuybackGuard.BadParams.selector);
        guard.setEthTwap(address(sixDec), WINDOW, 200, 1e17, 500, 1 hours); // other token is not 18 decimals
        vm.expectRevert(BuybackGuard.BadParams.selector);
        guard.setEthTwap(address(0xdead), WINDOW, 200, 1e17, 500, 1 hours); // no code
        vm.expectRevert(BuybackGuard.BadParams.selector);
        guard.setEthTwap(address(ethPool), 9 minutes, 200, 1e17, 500, 1 hours);
        vm.expectRevert(BuybackGuard.BadParams.selector);
        guard.setEthTwap(address(ethPool), 1 days + 1, 200, 1e17, 500, 1 hours);
        vm.expectRevert(BuybackGuard.BadParams.selector);
        guard.setEthTwap(address(ethPool), WINDOW, 0, 1e17, 500, 1 hours);
        vm.expectRevert(BuybackGuard.BadParams.selector);
        guard.setEthTwap(address(ethPool), WINDOW, 2001, 1e17, 500, 1 hours);
        vm.expectRevert(BuybackGuard.BadParams.selector);
        guard.setEthTwap(address(ethPool), WINDOW, 200, 0, 500, 1 hours);
        vm.expectRevert(BuybackGuard.BadParams.selector);
        guard.setEthTwap(address(ethPool), WINDOW, 200, 1e17, 9, 1 hours);
        vm.expectRevert(BuybackGuard.BadParams.selector);
        guard.setEthTwap(address(ethPool), WINDOW, 200, 1e17, 2001, 1 hours);
        vm.expectRevert(BuybackGuard.BadParams.selector);
        guard.setEthTwap(address(ethPool), WINDOW, 200, 1e17, 500, 9 minutes);
        vm.expectRevert(BuybackGuard.BadParams.selector);
        guard.setEthTwap(address(ethPool), WINDOW, 200, 1e17, 500, 1 days + 1);
        vm.stopPrank();
    }

    function test_changingThePoolDropsTheStoredReference() public {
        guard.pokeEthReference();
        UniV3MockPool other = v3.createPool(address(usdc), address(weth), 500, _ethTick(0));
        other.setLiquidity(1e18);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(admin);
        guard.setEthTwap(address(other), WINDOW, 200, 1e17, 500, 1 hours);
        assertEq(guard.ethRefAt(), 0);
        (, uint8 s,) = guard.ethReference();
        assertEq(s, 0);
    }

    function test_governanceOnly() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(BuybackGuard.NotAdmin.selector, alice));
        guard.setEthTwap(address(ethPool), WINDOW, 200, 1e17, 500, 1 hours);
        vm.expectRevert(abi.encodeWithSelector(BuybackGuard.NotAdmin.selector, alice));
        guard.setEthFallback(2000e18, uint64(block.timestamp + 1 days));
        vm.expectRevert(abi.encodeWithSelector(BuybackGuard.NotAdmin.selector, alice));
        guard.setMaxImpactBps(50);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.NotAdmin.selector, alice));
        feeRouter.setBuybackGuard(address(guard));
        vm.stopPrank();
        vm.prank(guardian); // the guardian is not the timelock either
        vm.expectRevert(abi.encodeWithSelector(BuybackGuard.NotAdmin.selector, guardian));
        guard.setMaxImpactBps(50);
    }

    function test_constructor_zero() public {
        vm.expectRevert(BuybackGuard.ZeroAddress.selector);
        new BuybackGuard(address(0), address(feeRouter));
        vm.expectRevert(BuybackGuard.ZeroAddress.selector);
        new BuybackGuard(address(config), address(0));
    }

    /// @dev Any pool history and push: the stored reference always stays within the clamp of the previous value and the
    ///      sane range, and a poke either stores a clamped TWAP or reverts.
    function testFuzz_storedReferenceNeverJumps(int24 off, uint32 wait, uint8 steps) public {
        steps = uint8(bound(steps, 1, 6));
        off = int24(bound(int256(off), -2500, 2500));
        uint256 prev = guard.pokeEthReference();
        for (uint256 i; i < steps; ++i) {
            ethPool.setTick(_ethTick(off));
            vm.warp(block.timestamp + 5 minutes + (uint256(wait) % 3 hours));
            try guard.pokeEthReference() returns (uint256 v) {
                assertLe(v, Math.mulDiv(prev, 10_500, 10_000));
                assertGe(v, Math.mulDiv(prev, 9500, 10_000));
                assertGe(v, 100e18);
                assertLe(v, 100_000e18);
                prev = v;
            } catch {}
        }
    }

    // ------------------------------------------------------------------------------------------- sizing (v3 venue)

    function _bkrnTick() internal view returns (int24) {
        return address(usdc) < address(bkrn) ? int24(306_282) : int24(-306_283);
    }

    function _bkrnPool(uint128 liq) internal returns (UniV3MockPool p) {
        p = v3.createPool(address(usdc), address(bkrn), 3000, _bkrnTick());
        p.setLiquidity(liq);
    }

    /// @dev Exact-sqrt reference for a constant-liquidity position: the quote token that moves the price by `bps`.
    function _expectedSpend(uint128 liq, uint160 sqrtP, bool quoteIsToken1, uint256 bps, uint256 feePips)
        internal
        pure
        returns (uint256)
    {
        uint256 s = Math.sqrt((10_000 + bps) * 1e36 / 10_000); // sqrt(1 + bps/1e4) x 1e18
        uint256 q = quoteIsToken1
            ? Math.mulDiv(uint256(liq), uint256(sqrtP), 1 << 96) * (s - 1e18) / 1e18
            : Math.mulDiv(uint256(liq), 1 << 96, uint256(sqrtP)) * (s - 1e18) / 1e18;
        return q * 1e6 / (1e6 - feePips);
    }

    function test_size_v3VenueFromThePoolsLiquidity() public {
        UniV3MockPool p = _bkrnPool(1e18);
        stub.setV3(address(p));
        (uint160 sp,,,,,,) = p.slot0();
        uint256 cap = sizeGuard.maxBuyback();
        assertGt(cap, 0);
        assertApproxEqRel(cap, _expectedSpend(1e18, sp, p.token1() == address(usdc), 100, 3000), 0.004e18);
        // more liquidity, proportionally bigger; half the impact, about half
        p.setLiquidity(4e18);
        assertApproxEqRel(sizeGuard.maxBuyback(), cap * 4, 0.0001e18);
        vm.prank(admin);
        sizeGuard.setMaxImpactBps(50);
        assertApproxEqRel(sizeGuard.maxBuyback(), cap * 2, 0.0001e18);
    }

    function test_size_defaultImpactIs100AndBounded() public {
        assertEq(sizeGuard.maxImpactBps(), 100);
        vm.startPrank(admin);
        vm.expectRevert(BuybackGuard.BadParams.selector);
        sizeGuard.setMaxImpactBps(0);
        vm.expectRevert(BuybackGuard.BadParams.selector);
        sizeGuard.setMaxImpactBps(1001);
        sizeGuard.setMaxImpactBps(1000);
        vm.stopPrank();
        assertEq(sizeGuard.maxImpactBps(), 1000);
    }

    function test_size_noPoolMeansNoDepthCap_emptyPoolMeansZero() public {
        assertEq(sizeGuard.maxBuyback(), type(uint256).max);
        UniV3MockPool p = _bkrnPool(0);
        stub.setV3(address(p));
        assertEq(sizeGuard.maxBuyback(), 0);
    }

    // ------------------------------------------------------------------------------------------- the router

    function _pending(uint256 amount) internal {
        usdc.mint(address(feeRouter), amount);
        feeRouter.notifyMigration(amount);
    }

    function test_router_refusesAboveTheDepthCap_andSplitsAcrossCalls() public {
        UniV3MockPool p = _bkrnPool(1e18);
        vm.startPrank(admin);
        feeRouter.setTwapParams(address(p), 30 minutes, 200); // depth source only: the reference stays fixed
        feeRouter.setBuybackGuard(address(guard));
        vm.stopPrank();
        uint256 cap = guard.maxBuyback();
        assertGt(cap, 1e6);
        assertLt(cap, 10_000_000e6, "the depth cap, not maxBuybackPerCall, binds");
        _pending(cap * 5 / 2);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.BuybackTooLarge.selector, cap + 1, cap));
        feeRouter.executeBuyback(cap + 1, 0);

        // the pending amount goes out in chunks of at most the cap
        vm.startPrank(keeper);
        feeRouter.executeBuyback(cap, 0);
        feeRouter.executeBuyback(cap, 0);
        feeRouter.executeBuyback(cap / 2, 0);
        vm.stopPrank();
        assertEq(feeRouter.buybackPending(), 0);
        assertEq(feeRouter.totalBuybackUsdc(), cap * 5 / 2);
    }

    function test_router_noGuardKeepsTheOldBehaviour() public {
        _pending(400_000e6);
        vm.prank(keeper);
        feeRouter.executeBuyback(400_000e6, 0); // far above any depth cap: only maxBuybackPerCall applies
        assertEq(feeRouter.buybackPending(), 0);
    }

    function test_router_guardWithoutADepthSourceDoesNotBlock() public {
        vm.prank(admin);
        feeRouter.setBuybackGuard(address(guard)); // no twapPool configured on the router
        assertEq(guard.maxBuyback(), type(uint256).max);
        _pending(1_000e6);
        vm.prank(keeper);
        feeRouter.executeBuyback(1_000e6, 0);
    }

    function test_router_setBuybackGuard_emitsAndClears() public {
        vm.startPrank(admin);
        vm.expectEmit(address(feeRouter));
        emit BkrnFeeRouter.BuybackGuardSet(address(guard));
        feeRouter.setBuybackGuard(address(guard));
        assertEq(feeRouter.buybackGuard(), address(guard));
        feeRouter.setBuybackGuard(address(0));
        assertEq(feeRouter.buybackGuard(), address(0));
        vm.stopPrank();
    }

    /// @dev The ETH reference of REF_FIXED_ETH comes from the guard once set (the legacy fixed value is ignored).
    function test_router_fixedEthReferenceUsesTheGuard() public {
        vm.startPrank(admin);
        feeRouter.setEthReference(1000e18, 40_000e18); // legacy: 40 BKRN per USDG at 1,000 per ETH
        feeRouter.setReferenceSource(3);
        vm.stopPrank();
        assertEq(feeRouter.referenceBkrnPerUsdc(), 40e18);
        vm.prank(admin);
        feeRouter.setBuybackGuard(address(guard));
        uint256 v = guard.pokeEthReference(); // ~2,000
        assertEq(feeRouter.referenceBkrnPerUsdc(), Math.mulDiv(40_000e18, 1e18, v));
        // no usable reference (stale TWAP, no fallback): the reference reverts instead of guessing
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(BuybackGuard.EthReferenceUnavailable.selector);
        feeRouter.referenceBkrnPerUsdc();
    }
}

/// @notice The guard against the real v4 buyback routes (MockV4PoolManager): sizing of a direct and a via-ETH route, and a
///         via-ETH buyback priced with the guard's TWAP ETH reference instead of the timelock-set value.
contract BuybackGuardV4Test is CoreFixture {
    UniV3MockFactory internal v3;
    MockERC20 internal wethErc;
    UniV3MockPool internal ethPool;
    MockV4PoolManager internal pm;
    BuybackGuard internal guard;
    StubRouter internal stub;
    BuybackGuard internal sizeGuard;
    IV4PoolManager.PoolKey internal directKey;
    IV4PoolManager.PoolKey internal ethBkrnKey;
    IV4PoolManager.PoolKey internal ethUsdcKey;

    uint256 internal constant ETH_USD = 2000e18;
    uint256 internal constant BKRN_ETH = 40_000e18; // 20 BKRN per USDG x 2,000
    uint128 internal constant L = 1e22;

    function setUp() public override {
        super.setUp();
        wethErc = new MockERC20("Wrapped Ether", "WETH", 18);
        v3 = new UniV3MockFactory();
        bool wethIs0 = address(wethErc) < address(usdc);
        ethPool = v3.createPool(address(usdc), address(wethErc), 100, wethIs0 ? int24(-200_312) : int24(200_312));
        ethPool.setLiquidity(1e18);
        pm = new MockV4PoolManager();
        guard = new BuybackGuard(address(config), address(feeRouter));
        stub = new StubRouter();
        sizeGuard = new BuybackGuard(address(config), address(stub));
        directKey = _key(address(usdc), address(bkrn), 3000);
        ethBkrnKey = _key(address(0), address(bkrn), 0);
        ethUsdcKey = _key(address(0), address(usdc), 500);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(admin);
        guard.setEthTwap(address(ethPool), 30 minutes, 200, 1e17, 500, 1 hours);
    }

    function _key(address a, address b, uint24 fee) internal pure returns (IV4PoolManager.PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return IV4PoolManager.PoolKey(c0, c1, fee, 60, address(0));
    }

    function _route(uint8 kind, IV4PoolManager.PoolKey memory k) internal view returns (IBkrnV4Swapper.V4Route memory r) {
        r.kind = kind;
        r.bkrnPool = k;
        if (kind == 1) r.ethPool = ethUsdcKey;
    }

    function _expectedUsdc(uint128 liq, uint160 sqrtP, bool quoteIsToken1, uint256 bps, uint256 fee) internal pure returns (uint256) {
        uint256 s = Math.sqrt((10_000 + bps) * 1e36 / 10_000);
        uint256 q = quoteIsToken1
            ? Math.mulDiv(uint256(liq), uint256(sqrtP), 1 << 96) * (s - 1e18) / 1e18
            : Math.mulDiv(uint256(liq), 1 << 96, uint256(sqrtP)) * (s - 1e18) / 1e18;
        return fee == 0 ? q : q * 1e6 / (1e6 - fee);
    }

    function test_size_directRouteFromTheV4PoolsLiquidity() public {
        uint160 sp = UniswapV4Lib.priceLimit(20e18, 6, 18, address(usdc) < address(bkrn));
        pm.initialize(directKey, sp, L);
        stub.setV4(address(pm), _route(0, directKey));
        uint256 cap = sizeGuard.maxBuyback();
        assertGt(cap, 0);
        assertApproxEqRel(cap, _expectedUsdc(L, sp, directKey.currency1 == address(usdc), 100, 3000), 0.004e18);
        // an LP pulls liquidity: the next buyback is smaller
        pm.setLiquidity(directKey, L / 2);
        assertApproxEqRel(sizeGuard.maxBuyback(), cap / 2, 0.0001e18);
    }

    function test_size_viaEthRouteIsConvertedAtTheEthReference() public {
        uint160 sp = UniswapV4Lib.priceLimit(BKRN_ETH, 18, 18, true); // ETH is currency0
        pm.initialize(ethBkrnKey, sp, L);
        stub.setV4(address(pm), _route(1, ethBkrnKey));
        vm.expectRevert(BuybackGuard.EthReferenceUnavailable.selector); // no ETH reference yet: nothing is guessed
        sizeGuard.maxBuyback();
        vm.startPrank(admin);
        sizeGuard.setEthTwap(address(ethPool), 30 minutes, 200, 1e17, 500, 1 hours);
        sizeGuard.setEthFallback(ETH_USD, uint64(block.timestamp + 1 days));
        vm.stopPrank();
        uint256 ethCap = _expectedUsdc(L, sp, false, 100, 0); // ETH is the quote (currency0), static fee 0
        assertApproxEqRel(sizeGuard.maxBuyback(), ethCap * 2000 / 1e12, 0.004e18);
    }

    function test_size_noRouteOrUninitializedPoolMeansNoCap() public {
        stub.setV4(address(pm), _route(0, directKey)); // pool never initialized
        assertEq(sizeGuard.maxBuyback(), type(uint256).max);
        IBkrnV4Swapper.V4Route memory none;
        stub.setV4(address(pm), none);
        assertEq(sizeGuard.maxBuyback(), type(uint256).max);
    }

    /// @dev The legacy timelock-set ETH reference is wildly off; with the guard the via-ETH buyback prices with the TWAP and
    ///      lands. Without a usable reference it fails safe (the settlement token stays pending).
    function test_router_viaEthBuybackUsesTheGuardsEthReference() public {
        uint160 spBkrn = UniswapV4Lib.priceLimit(BKRN_ETH, 18, 18, true);
        uint160 spEth = UniswapV4Lib.priceLimit(ETH_USD, 18, 6, true);
        pm.initialize(ethBkrnKey, spBkrn, 219_089_023_002_066_449_000_000);
        pm.initialize(ethUsdcKey, spEth, 48_989_794_855_663_561);
        usdc.mint(address(pm), 5_000_000e6);
        vm.prank(liquidity);
        bkrn.transfer(address(pm), 30_000_000e18);
        vm.deal(address(pm), 2000 ether);
        _stake(alice, 1e18);
        vm.startPrank(admin);
        feeRouter.setBuybackParams(0, 20e18, 500, 1_000_000e6);
        feeRouter.setV4PoolManager(address(pm));
        feeRouter.setEthReference(100_000e18, BKRN_ETH); // legacy value, 50x the market: would refuse every swap
        vm.stopPrank();

        guard.pokeEthReference();
        vm.startPrank(admin);
        feeRouter.setBuybackGuard(address(guard));
        feeRouter.setV4Route(_route(1, ethBkrnKey));
        feeRouter.setBuybackVenue(1);
        vm.stopPrank();

        uint256 cap = guard.maxBuyback();
        assertGt(cap, 100e6);
        _pending(cap + 1_000e6);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(BkrnFeeRouter.BuybackTooLarge.selector, cap + 1, cap));
        feeRouter.executeBuyback(cap + 1, 0);
        uint256 amount = cap < 100e6 ? cap : 100e6;
        vm.prank(keeper);
        uint256 out = feeRouter.executeBuyback(amount, 0);
        assertGt(out, 0);
        assertGe(out, feeRouter.buybackFloor(amount));
        assertEq(feeRouter.totalBuybackUsdc(), amount);

        // the TWAP goes stale and there is no fallback: the via-ETH buyback fails safe (nothing is guessed)
        vm.warp(block.timestamp + 2 hours);
        vm.prank(keeper);
        vm.expectRevert(BuybackGuard.EthReferenceUnavailable.selector);
        feeRouter.executeBuyback(1e6, 0);
        assertEq(feeRouter.buybackPending(), cap + 1_000e6 - amount);
    }

    function _pending(uint256 amount) internal {
        usdc.mint(address(feeRouter), amount);
        feeRouter.notifyMigration(amount);
    }
}
