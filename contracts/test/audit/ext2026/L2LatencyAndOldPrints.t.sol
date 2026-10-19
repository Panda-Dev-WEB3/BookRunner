// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IBookrunnerDesk} from "../../../src/interfaces/IBookrunnerDesk.sol";
import {IPoolEngine} from "../../../src/interfaces/IPoolEngine.sol";
import {BookrunnerConfig} from "../../../src/BookrunnerConfig.sol";
import {MandateBase} from "../../mandate/utils/MandateBase.sol";
import {EngineBase} from "../../engine/utils/EngineBase.sol";

/// @notice Audit 2026-10 lead "Old prints": a desk key could value its swaps at any stored print up to maxPriceAge
///         (300 s) old, and relay such a print itself. Key-initiated swaps (Hedge, key Flatten) now need the traded
///         token's price within the engine's trade bound, min(maxPriceAge, maxTradePriceAge) (15 s); the RISK
///         flatten keeps its never-blocked-by-a-stale-price rule.
contract L2DeskOldPrintsTest is MandateBase {
    function _exposedAndFunded() internal {
        adapter.setExposure(-20_000e6);
        _fundDesk(15_000e6);
    }

    /// @dev PoC: the stored price is 200 s old (inside maxPriceAge); the key's hedge was valued at it.
    function test_lead_poc_keyHedgeOnOldPrint_refused() public {
        _exposedAndFunded();
        uint64 at = uint64(block.timestamp);
        vm.warp(block.timestamp + 200);
        IBookrunnerDesk.Action memory a = _hedgeAction(address(nvda), true, 10_000e6, 1);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSignature("StaleTradePrice(address,uint64)", address(nvda), at));
        desk.execute(a);

        _refreshPrices(); // a fresh print: the same hedge goes through
        _exec(key, a);
        assertGt(nvda.balanceOf(address(desk)), 0);
    }

    function test_lead_keyHedge_boundIsMaxTradePriceAge() public {
        _exposedAndFunded();
        vm.warp(block.timestamp + 15); // exactly the bound: allowed
        _exec(key, _hedgeAction(address(nvda), true, 5000e6, 1));
        vm.warp(block.timestamp + 1); // 16 s
        vm.prank(key);
        vm.expectRevert();
        desk.execute(_hedgeAction(address(nvda), true, 5000e6, 1));
    }

    function test_lead_keyFlattenOnOldPrint_refused_riskFlattenRuns() public {
        _exposedAndFunded();
        uint256 out = _buyNvda(10_000e6);
        adapter.setExposure(0); // venue flat: selling spot is not judged against the band
        uint64 at = uint64(block.timestamp);
        vm.warp(block.timestamp + 200);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSignature("StaleTradePrice(address,uint64)", address(nvda), at));
        desk.execute(_flattenAction(address(nvda), out, 0));

        // the RISK role's emergency flatten is never blocked by price age
        vm.prank(risk);
        desk.execute(_flattenAction(address(nvda), out, 0));
        assertEq(nvda.balanceOf(address(desk)), 0);
    }
}

/// @notice Audit 2026-10 L-2 (pull-oracle latency arbitrage): accepted residual, bounded on-chain. A trader can open
///         at the stored price and close on a newer print in one transaction; every engine trade needs a price at
///         most maxTradePriceAge old, which governance can no longer raise above MAX_TRADE_PRICE_AGE (15 s), so the
///         edge is the price move within 15 s minus the spread and two taker fees, and the M-3 loss budget caps the
///         pool's loss per period whatever the channel.
contract L2LatencyBoundTest is EngineBase {
    uint128 internal constant MAX_NET = 75_000e6;
    address internal adA = makeAddr("adapterA");
    address internal alice = makeAddr("alice");
    uint256 internal mA;

    function setUp() public {
        _deployCore();
        IPoolEngine.MarketConfig memory c = _defaultCfg(PID_A, MAX_NET);
        c.fundingVelocityBps = 0;
        mA = _createMarket(adA, c);
        _fundPool(adA, mA, 100_000e6, 25_000e6);
        _setQuote(adA, mA, 10, 0, MAX_NET);
        _price(PID_A, PX);
    }

    /// @dev The auditor's PoC ($50k at a 40 bp move, stored price 15 s old): the round trip still pays, as accepted;
    ///      the profit is exactly the move minus the half-spread on each leg and two taker fees.
    function test_L2_poc_roundTripEdgeIsMoveMinusSpreadAndFees() public {
        _deposit(alice, mA, 20_000e6);
        vm.warp(block.timestamp + 15); // stored price at the bound
        uint256 size = 500e18; // $50k at $100
        uint256 eqBefore = uint256(engine.traderEquityUsd(mA, alice));
        vm.prank(alice);
        engine.trade(mA, int256(size), type(uint256).max); // open at the stored 100
        uint256 up = Math.mulDiv(PX, 10_040, 10_000); // a newer print 40 bp higher
        bytes memory newer = _priceData(PID_A, up, uint64(block.timestamp), false);
        vm.prank(alice);
        engine.trade(mA, -int256(size), 0, newer); // relay it and close in the same block
        uint256 eqAfter = uint256(engine.traderEquityUsd(mA, alice));
        // 40 bp of $50k = $200; minus 5 bp per leg of spread and 10 bp per leg of fee on ~$50k = ~$150
        assertApproxEqAbs(eqAfter - eqBefore, 49.7e6, 0.2e6, "edge = move - spread - fees");
    }

    /// @dev The bound on that window can no longer be widened: maxTradePriceAge <= MAX_TRADE_PRICE_AGE (15 s).
    function test_L2_maxTradePriceAge_cappedOnChain() public {
        BookrunnerConfig real = new BookrunnerConfig(address(this));
        real.setParam("maxTradePriceAge", 15);
        vm.expectRevert(
            abi.encodeWithSelector(BookrunnerConfig.ParamOutOfRange.selector, bytes32("maxTradePriceAge"), 16)
        );
        real.setParam("maxTradePriceAge", 16);
        assertEq(real.maxTradePriceAge(), 15);
    }
}
