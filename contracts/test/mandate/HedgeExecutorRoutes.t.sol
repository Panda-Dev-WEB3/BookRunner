// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IBookrunnerDesk} from "../../src/interfaces/IBookrunnerDesk.sol";
import {HedgeExecutor} from "../../src/HedgeExecutor.sol";
import {BookrunnerDesk} from "../../src/BookrunnerDesk.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MandateBase} from "./utils/MandateBase.sol";
import {UniV3MockFactory, UniV3MockPool, UniV3MockRouter} from "../mocks/UniswapV3Mocks.sol";

/// @dev Desk-shaped caller (book() + forwards swaps) for direct executor calls.
contract RouteFakeDesk {
    address public book;
    HedgeExecutor internal immutable exec;

    constructor(HedgeExecutor e, address b) {
        exec = e;
        book = b;
    }

    function swap(bytes32 venue, address tin, address tout, uint24 fee, uint256 amountIn, uint256 minOut)
        external
        returns (uint256)
    {
        IERC20(tin).approve(address(exec), amountIn);
        return exec.swapExactIn(venue, tin, tout, fee, amountIn, minOut, address(this));
    }
}

/// @notice HedgeExecutor against a faithful SwapRouter02 stand-in (pools looked up by tier, reserves-priced
///         swaps with price impact and fees, transferFrom pulls, multi-hop paths): governance routes per
///         Stock Token, pool-existence checks, poolFee pinning, hop routes, and the desk's oracle bound.
contract HedgeExecutorRoutesTest is MandateBase {
    UniV3MockFactory internal v3;
    UniV3MockRouter internal v3router;
    HedgeExecutor internal ex;
    RouteFakeDesk internal fake;
    MockERC20 internal weth;
    UniV3MockPool internal poolUsdcNvda; // 0.05%, 190 USDC / NVDA, deep
    address internal fakeBook = makeAddr("routeFakeBook");

    event RouteSet(bytes32 indexed venue, address indexed asset, uint24 fee, address hop, uint24 hopFee);

    function setUp() public override {
        super.setUp();
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        v3 = new UniV3MockFactory();
        v3router = new UniV3MockRouter(v3);
        v3.setRouter(address(v3router));

        poolUsdcNvda = _pool(address(usdc), 19_000_000e6, address(nvda), 100_000e18, 500);
        _pool(address(usdc), 40_000_000e6, address(weth), 10_000e18, 500); // WETH $4000
        _pool(address(weth), 4750e18, address(nvda), 100_000e18, 3000); // 0.0475 WETH / NVDA

        ex = new HedgeExecutor(address(cfg), address(v3router));
        vm.startPrank(timelock);
        ex.setV3Factory(address(v3));
        ex.setRoute(UNIV3, address(nvda), 500, address(0), 0);
        vm.stopPrank();

        fake = new RouteFakeDesk(ex, fakeBook);
        BRTypes.BookComponents memory c;
        c.book = fakeBook;
        c.desk = address(fake);
        factory.register(98, c);
        usdc.mint(address(fake), 1_000_000e6);
    }

    function _pool(address a, uint256 amtA, address b, uint256 amtB, uint24 fee) internal returns (UniV3MockPool p) {
        p = v3.createPool(a, b, fee, 0);
        MockERC20(a).mint(address(p), amtA);
        MockERC20(b).mint(address(p), amtB);
    }

    /// @dev x*y=k after the input fee (what the faithful pool charges).
    function _cp(uint256 rin, uint256 rout, uint256 amountIn, uint24 fee) internal pure returns (uint256) {
        uint256 inAfter = amountIn * (1e6 - fee) / 1e6;
        return rout * inAfter / (rin + inAfter);
    }

    // ------------------------------------------------------------------ governance

    function test_setRoute_authAndValidation() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.Unauthorized.selector, stranger));
        ex.setRoute(UNIV3, address(tsla), 500, address(0), 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.Unauthorized.selector, stranger));
        ex.setV3Factory(address(0));

        vm.startPrank(timelock);
        vm.expectRevert(HedgeExecutor.BadVenue.selector);
        ex.setRoute(bytes32(0), address(nvda), 500, address(0), 0);
        vm.expectRevert(HedgeExecutor.ZeroAddress.selector);
        ex.setRoute(UNIV3, address(0), 500, address(0), 0);
        vm.expectRevert(HedgeExecutor.BadRoute.selector); // the settlement token is not a hedge asset
        ex.setRoute(UNIV3, address(usdc), 500, address(0), 0);
        vm.expectRevert(HedgeExecutor.BadRoute.selector); // fee >= 1e6
        ex.setRoute(UNIV3, address(nvda), 1_000_000, address(0), 0);
        vm.expectRevert(HedgeExecutor.BadRoute.selector); // direct route with a hop fee
        ex.setRoute(UNIV3, address(nvda), 500, address(0), 3000);
        vm.expectRevert(HedgeExecutor.BadRoute.selector); // hop route without a hop fee
        ex.setRoute(UNIV3, address(nvda), 500, address(weth), 0);
        vm.expectRevert(HedgeExecutor.BadRoute.selector); // hop == asset
        ex.setRoute(UNIV3, address(nvda), 500, address(nvda), 3000);
        vm.expectRevert(HedgeExecutor.BadRoute.selector); // hop == settlement
        ex.setRoute(UNIV3, address(nvda), 500, address(usdc), 3000);
        vm.expectRevert(HedgeExecutor.BadRoute.selector); // clearing takes no hop
        ex.setRoute(UNIV3, address(nvda), 0, address(weth), 0);

        vm.expectEmit(true, true, false, true, address(ex));
        emit RouteSet(UNIV3, address(nvda), 500, address(weth), 3000);
        ex.setRoute(UNIV3, address(nvda), 500, address(weth), 3000);
        (uint24 f, address hop, uint24 hf) = ex.routeOf(UNIV3, address(nvda));
        assertEq(uint256(f), 500);
        assertEq(hop, address(weth));
        assertEq(uint256(hf), 3000);

        vm.expectEmit(true, true, false, true, address(ex));
        emit RouteSet(UNIV3, address(nvda), 0, address(0), 0);
        ex.setRoute(UNIV3, address(nvda), 0, address(0), 0);
        (f,,) = ex.routeOf(UNIV3, address(nvda));
        assertEq(uint256(f), 0);
        vm.stopPrank();
    }

    function test_setRoute_requiresExistingPools() public {
        vm.startPrank(timelock);
        vm.expectRevert(
            abi.encodeWithSelector(HedgeExecutor.PoolNotFound.selector, address(usdc), address(nvda), uint24(10_000))
        );
        ex.setRoute(UNIV3, address(nvda), 10_000, address(0), 0);
        vm.expectRevert(
            abi.encodeWithSelector(HedgeExecutor.PoolNotFound.selector, address(weth), address(nvda), uint24(500))
        );
        ex.setRoute(UNIV3, address(nvda), 500, address(weth), 500);
        vm.expectRevert(
            abi.encodeWithSelector(HedgeExecutor.PoolNotFound.selector, address(usdc), address(tsla), uint24(500))
        );
        ex.setRoute(UNIV3, address(tsla), 500, address(0), 0);
        // UNIV4 routes are not checked against the v3 factory
        ex.setRoute(UNIV4, address(tsla), 500, address(0), 0);
        // without a factory, no check (devnet MockSwapRouter)
        ex.setV3Factory(address(0));
        ex.setRoute(UNIV3, address(tsla), 500, address(0), 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ swaps

    function test_directRoute_buyAndSell_poolPriced() public {
        uint256 expectOut = _cp(19_000_000e6, 100_000e18, 19_000e6, 500);
        uint256 out = fake.swap(UNIV3, address(usdc), address(nvda), 0, 19_000e6, 0);
        assertEq(out, expectOut);
        assertEq(nvda.balanceOf(address(fake)), expectOut);
        assertEq(uint256(v3router.lastFee()), 500); // the governance tier, caller passed 0
        assertLt(out, 100e18); // fee + price impact: < 19,000 / 190

        uint256 rin = nvda.balanceOf(address(poolUsdcNvda));
        uint256 rout = usdc.balanceOf(address(poolUsdcNvda));
        uint256 back = fake.swap(UNIV3, address(nvda), address(usdc), 500, out, 0);
        assertEq(back, _cp(rin, rout, out, 500));
        assertLt(back, 19_000e6); // round trip pays two fees
        assertEq(usdc.balanceOf(address(ex)), 0);
        assertEq(nvda.balanceOf(address(ex)), 0);
        assertEq(usdc.allowance(address(ex), address(v3router)), 0);
    }

    function test_poolFee_mustBeZeroOrRouteFee() public {
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.PoolFeeMismatch.selector, uint24(3000), uint24(500)));
        fake.swap(UNIV3, address(usdc), address(nvda), 3000, 1000e6, 0);
    }

    function test_routeRequired_andSettlementPairOnly() public {
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.RouteNotSet.selector, UNIV3, address(tsla)));
        fake.swap(UNIV3, address(usdc), address(tsla), 0, 1000e6, 0);

        nvda.mint(address(fake), 1e18);
        vm.expectRevert(
            abi.encodeWithSelector(HedgeExecutor.NotSettlementPair.selector, address(nvda), address(tsla))
        );
        fake.swap(UNIV3, address(nvda), address(tsla), 0, 1e18, 0);

        vm.prank(timelock);
        ex.setRoute(UNIV3, address(nvda), 0, address(0), 0);
        vm.expectRevert(abi.encodeWithSelector(HedgeExecutor.RouteNotSet.selector, UNIV3, address(nvda)));
        fake.swap(UNIV3, address(nvda), address(usdc), 0, 1e18, 0);
    }

    function test_minOut_enforcedByRouter() public {
        uint256 expectOut = _cp(19_000_000e6, 100_000e18, 1900e6, 500);
        vm.expectRevert(bytes("Too little received"));
        fake.swap(UNIV3, address(usdc), address(nvda), 0, 1900e6, expectOut + 1);
        assertEq(fake.swap(UNIV3, address(usdc), address(nvda), 0, 1900e6, expectOut), expectOut);
    }

    function test_hopRoute_viaWeth_buyAndSell() public {
        vm.prank(timelock);
        ex.setRoute(UNIV3, address(nvda), 500, address(weth), 3000);
        bytes memory buyPath = abi.encodePacked(address(usdc), uint24(500), address(weth), uint24(3000), address(nvda));
        bytes memory sellPath =
            abi.encodePacked(address(nvda), uint24(3000), address(weth), uint24(500), address(usdc));
        assertEq(ex.pathOf(UNIV3, address(usdc), address(nvda)), buyPath);
        assertEq(ex.pathOf(UNIV3, address(nvda), address(usdc)), sellPath);

        uint256 wethOut = _cp(40_000_000e6, 10_000e18, 4000e6, 500);
        uint256 expectOut = _cp(4750e18, 100_000e18, wethOut, 3000);
        uint256 out = fake.swap(UNIV3, address(usdc), address(nvda), 500, 4000e6, 0);
        assertEq(out, expectOut);
        assertEq(v3router.lastPath(), buyPath);
        assertApproxEqRel(out, 4000e18 / uint256(190), 0.01e18); // ~21 NVDA within 1%

        uint256 back = fake.swap(UNIV3, address(nvda), address(usdc), 0, out, 0);
        assertEq(v3router.lastPath(), sellPath);
        assertApproxEqRel(back, 4000e6, 0.02e18);
        // nothing stranded in the executor or the router (intermediate WETH fully forwarded)
        assertEq(weth.balanceOf(address(v3router)), 0);
        assertEq(weth.balanceOf(address(ex)), 0);
        assertEq(nvda.balanceOf(address(ex)), 0);
        assertEq(usdc.balanceOf(address(ex)), 0);
    }

    /// @dev "minOut from the oracle minus slippage" is enforced by the desk on the measured result: a deep
    ///      pool at the oracle price fills; an off-oracle (thin / manipulated) pool reverts the whole hedge.
    function test_realDesk_oracleBoundOnPoolPrice() public {
        cfg.setHedgeExecutor(address(ex));
        _fundDesk(10_000e6);
        adapter.setExposure(-20_000e6);

        IBookrunnerDesk.Action memory a;
        a.kind = IBookrunnerDesk.ActionKind.Hedge;
        a.data = abi.encode(address(nvda), true, uint256(5700e6), uint256(0), uint24(0), UNIV3);
        a.proof = _proof(address(nvda), UNIV3);
        uint256 out = abi.decode(_exec(key, a), (uint256));
        assertEq(out, _cp(19_000_000e6, 100_000e18, 5700e6, 500));
        assertEq(nvda.balanceOf(address(desk)), out);

        // governance repoints NVDA to a 1% pool priced 25% above the oracle (190 -> 250)
        _pool(address(usdc), 250_000e6, address(nvda), 1000e18, 10_000);
        vm.prank(timelock);
        ex.setRoute(UNIV3, address(nvda), 10_000, address(0), 0);
        a.data = abi.encode(address(nvda), true, uint256(1000e6), uint256(0), uint24(0), UNIV3);
        vm.prank(key);
        vm.expectPartialRevert(BookrunnerDesk.SlippageTooHigh.selector);
        desk.execute(a);
    }
}
