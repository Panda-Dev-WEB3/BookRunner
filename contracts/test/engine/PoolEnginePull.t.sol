// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EngineBase} from "./utils/EngineBase.sol";
import {PoolEngine} from "../../src/PoolEngine.sol";
import {IAttestedOracle} from "../../src/interfaces/IAttestedOracle.sol";
import {IPoolEngine} from "../../src/interfaces/IPoolEngine.sol";

/// @notice LOW_GAS.md §1 on the engine: `trade(..., priceData)` / `liquidate(..., priceData)` carry the signed
///         prices their transaction needs (`AttestedOracle.update` first), staleness is judged on the price after
///         that in-tx update, and a trade adding risk may only use a price with
///         publishedAt >= block.timestamp - maxTradePriceAge (default 15 s). Reductions and liquidations are not
///         bound by maxTradePriceAge (they keep today's rule: they work at the latest / held price).
contract PoolEnginePullTest is EngineBase {
    uint256 internal constant OTHER_PK = 0xB0B;
    uint128 internal constant MAX_NET = 75_000e6;
    uint256 internal constant POOL = 100_000e6;
    uint256 internal constant IF = 25_000e6;

    address internal adA = makeAddr("adapterA");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");

    uint256 internal mA;
    uint64 internal t0; // publishedAt of the setUp price

    function setUp() public {
        _deployCore();
        IPoolEngine.MarketConfig memory c = _defaultCfg(PID_A, MAX_NET);
        c.fundingVelocityBps = 0;
        mA = _createMarket(adA, c);
        _fundPool(adA, mA, POOL, IF);
        _setQuote(adA, mA, 10, 0, MAX_NET);
        _price(PID_A, PX);
        t0 = oracle.latest(PID_A).publishedAt;
    }

    function _now() internal view returns (uint64) {
        return uint64(block.timestamp);
    }

    function _buyFill(uint256 price) internal pure returns (uint256) {
        return Math.mulDiv(price, 20_010, 20_000, Math.Rounding.Ceil); // spread 10 bps, skew 0
    }

    function _tradeWith(address trader, int256 size, bytes memory pd) internal returns (uint256 fill) {
        vm.prank(trader);
        (fill,) = engine.trade(mA, size, size > 0 ? type(uint256).max : 0, pd);
    }

    // =================================================================== pull trades

    /// @dev Pull mode: nothing pushed for an hour. The legacy entry point refuses new risk on the stale stored
    ///      price; the same trade carrying a fresh signed price fills at that price in one transaction.
    function test_trade_carriesFreshPriceWhenStoredIsStale() public {
        _deposit(alice, mA, 10_000e6);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, t0));
        engine.trade(mA, 1e18, type(uint256).max);

        uint256 fill = _tradeWith(alice, 10e18, _priceData(PID_A, 101e18, _now(), false));
        assertEq(fill, _buyFill(101e18));
        assertEq(oracle.latest(PID_A).priceWad, 101e18);
        assertEq(oracle.latest(PID_A).publishedAt, _now());
        assertEq(engine.positionOf(mA, alice).size, 10e18);
        assertEq(engine.positionOf(mA, alice).entryPriceWad, _buyFill(101e18));
    }

    function test_trade_emptyPriceDataIsTheLegacyTrade() public {
        _deposit(alice, mA, 10_000e6);
        _deposit(bob, mA, 10_000e6);
        vm.prank(alice);
        (uint256 f1, uint256 fee1) = engine.trade(mA, 3e18, type(uint256).max);
        vm.recordLogs();
        vm.prank(bob);
        (uint256 f2, uint256 fee2) = engine.trade(mA, 3e18, type(uint256).max, "");
        assertEq(f1, f2);
        assertEq(fee1, fee2);
        assertEq(oracle.latest(PID_A).publishedAt, t0);
        // empty priceData never reaches the oracle
        assertEq(vm.getRecordedLogs().length, 1, "only the Trade event");
        vm.warp(block.timestamp + 1 hours);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, t0));
        engine.trade(mA, 1e18, type(uint256).max, "");
    }

    /// @dev publishedAt >= block.timestamp - maxTradePriceAge for new risk, evaluated after the in-tx update.
    function test_trade_maxTradePriceAgeBoundsNewRisk() public {
        _deposit(alice, mA, 10_000e6);
        vm.warp(block.timestamp + 1 hours);
        uint64 old = _now() - 16;
        bytes memory pd = _priceData(PID_A, 99e18, old, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, old));
        engine.trade(mA, 1e18, type(uint256).max, pd);
        assertEq(oracle.latest(PID_A).publishedAt, t0, "the reverted tx stored nothing");

        _tradeWith(alice, 1e18, _priceData(PID_A, 99e18, _now() - 15, false)); // exactly 15 s: allowed
        assertEq(engine.positionOf(mA, alice).size, 1e18);
        // one second later the same stored price no longer opens risk
        vm.warp(block.timestamp + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, _now() - 16));
        engine.trade(mA, 1e18, type(uint256).max);
    }

    /// @dev A trader holding an old favourable print cannot use it: older than the stored price -> skipped
    ///      (the fill uses the stored price); newer than stored but older than maxTradePriceAge -> refused.
    function test_trade_cannotPickOldFavourablePrint() public {
        _deposit(alice, mA, 10_000e6);
        vm.warp(block.timestamp + 1);
        bytes memory cheap = _priceData(PID_A, 90e18, _now(), false); // a print at 90, kept for later
        vm.warp(block.timestamp + 4);
        _price(PID_A, 100e18); // a newer price landed
        uint256 fill = _tradeWith(alice, 1e18, cheap);
        assertEq(fill, _buyFill(100e18), "older than stored: skipped, filled at the stored price");
        assertEq(oracle.latest(PID_A).priceWad, 100e18);
    }

    function test_trade_oldPrintNewerThanStoredButOutsideWindowRefused() public {
        _deposit(alice, mA, 10_000e6);
        bytes memory cheap = _priceData(PID_A, 90e18, _now() + 1, false); // signed at t0 + 1
        vm.warp(block.timestamp + 60); // no pushes since t0: the print is newer than stored ...
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, t0 + 1));
        engine.trade(mA, 1e18, type(uint256).max, cheap); // ... but 59 s old: no new risk on it
    }

    function test_trade_maxTradePriceAgeParamAndMinWithOtherBounds() public {
        _deposit(alice, mA, 10_000e6);
        vm.warp(block.timestamp + 1 hours);
        cfg.setMaxTradePriceAge(30);
        _tradeWith(alice, 1e18, _priceData(PID_A, 100e18, _now() - 30, false));
        // maxPriceAge below maxTradePriceAge: the smaller bound wins (the 11 s old print is not even landed:
        // stale on arrival; the stored 30 s old one is refused)
        cfg.setMaxPriceAge(10);
        uint64 at = _now() - 11;
        bytes memory pd = _priceData(PID_A, 100e18, at, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, _now() - 30));
        engine.trade(mA, 1e18, type(uint256).max, pd);
        _tradeWith(alice, 1e18, _priceData(PID_A, 100e18, _now() - 10, false));
        // NEW_RISK_MAX_PRICE_AGE still caps a lax maxTradePriceAge
        cfg.setMaxPriceAge(300);
        cfg.setMaxTradePriceAge(3600);
        vm.warp(block.timestamp + 1 hours);
        at = _now() - 61;
        pd = _priceData(PID_A, 100e18, at, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, at));
        engine.trade(mA, 1e18, type(uint256).max, pd);
        _tradeWith(alice, 1e18, _priceData(PID_A, 100e18, _now() - 60, false));
        assertEq(engine.positionOf(mA, alice).size, 3e18);
    }

    /// @dev Reductions keep today's rule: they work at the latest stored price however old (red-team: stale
    ///      oracle blocks new risk only) and with a carried price older than maxTradePriceAge.
    function test_trade_reductionsNotBoundByMaxTradePriceAge() public {
        _deposit(alice, mA, 10_000e6);
        _trade(alice, mA, 10e18);
        vm.warp(block.timestamp + 1 hours);
        _trade(alice, mA, -2e18); // legacy reduce at the stale stored price
        _tradeWith(alice, -3e18, _priceData(PID_A, 100e18, _now() - 200, false)); // 200 s old print
        assertEq(oracle.latest(PID_A).publishedAt, _now() - 200);
        _tradeWith(alice, -5e18, "");
        assertEq(engine.positionOf(mA, alice).size, 0);
    }

    /// @dev Lookback guard: after an idle hour a short holds a print from 50 minutes ago at 90 (newer than the
    ///      stored price, far below the market). Carrying it lands nothing (stale on arrival), so the close
    ///      fills at the stored price — or at the current print if the trader carries that one.
    function test_trade_reductionCannotCherryPickOldPrint() public {
        _deposit(alice, mA, 10_000e6);
        _trade(alice, mA, -10e18); // short at ~100
        vm.warp(block.timestamp + 1 hours);
        bytes memory dip = _priceData(PID_A, 90e18, _now() - 50 minutes, false);
        uint256 fill = _tradeWith(alice, 5e18, dip); // buy to close
        assertEq(fill, _buyFill(PX), "old print skipped: closed at the stored price");
        assertEq(oracle.latest(PID_A).priceWad, PX);
        assertEq(oracle.latest(PID_A).publishedAt, t0);
        fill = _tradeWith(alice, 5e18, _priceData(PID_A, 103e18, _now(), false));
        assertEq(fill, _buyFill(103e18), "the current print is what moves the price");
        assertEq(engine.positionOf(mA, alice).size, 0);
    }

    function test_trade_heldPriceDataBlocksNewRiskOnly() public {
        _deposit(alice, mA, 10_000e6);
        _trade(alice, mA, 5e18);
        vm.warp(block.timestamp + 10);
        bytes memory held = _priceData(PID_A, 100e18, _now(), true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.OffHours.selector, mA));
        engine.trade(mA, 1e18, type(uint256).max, held);
        _tradeWith(alice, -1e18, held); // reduce works on the held price
        assertTrue(oracle.latest(PID_A).held);
    }

    function test_trade_badSignatureRevertsTrade() public {
        _deposit(alice, mA, 10_000e6);
        vm.warp(block.timestamp + 10);
        bytes memory forged = _priceDataBy(OTHER_PK, PID_A, 50e18, _now(), false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, vm.addr(OTHER_PK)));
        engine.trade(mA, 1e18, type(uint256).max, forged);
        vm.prank(alice); // reductions too: the whole tx reverts on a bad bundle
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, vm.addr(OTHER_PK)));
        engine.trade(mA, -1e18, 0, forged);
        assertEq(oracle.latest(PID_A).priceWad, PX);
        assertEq(engine.positionOf(mA, alice).size, 0);
    }

    /// @dev Replaying a bundle is harmless: the second carry is skipped, and once the price it stored is older
    ///      than maxTradePriceAge it no longer opens risk.
    function test_trade_replayedPriceData() public {
        _deposit(alice, mA, 10_000e6);
        _deposit(bob, mA, 10_000e6);
        vm.warp(block.timestamp + 1 hours);
        bytes memory pd = _priceData(PID_A, 100e18, _now(), false);
        _tradeWith(alice, 1e18, pd);
        vm.warp(block.timestamp + 15);
        _tradeWith(bob, 1e18, pd); // replay: skipped, stored price still within the window
        vm.warp(block.timestamp + 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, _now() - 16));
        engine.trade(mA, 1e18, type(uint256).max, pd);
    }

    /// @dev Bundles with other underlyings are stored too (the engine does not filter): harmless, the market
    ///      still reads its own underlying.
    function test_trade_bundleWithOtherUnderlyingOnly() public {
        _deposit(alice, mA, 10_000e6);
        vm.warp(block.timestamp + 1 hours);
        bytes memory other = _priceData(PID_B, 5e18, _now(), false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, t0));
        engine.trade(mA, 1e18, type(uint256).max, other);
    }

    // =================================================================== pull liquidations

    function test_liquidate_carriesThePriceThatMakesItLiquidatable() public {
        _deposit(alice, mA, 110e6);
        _trade(alice, mA, 10e18);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotLiquidatable.selector, alice));
        engine.liquidate(mA, alice);
        vm.warp(block.timestamp + 30);
        bytes memory crash = _priceData(PID_A, 93e18, _now(), false);
        uint256 kBefore = usdc.balanceOf(keeper);
        vm.prank(keeper);
        uint256 reward = engine.liquidate(mA, alice, crash);
        assertGt(reward, 0);
        assertEq(usdc.balanceOf(keeper), kBefore + reward);
        assertEq(engine.positionOf(mA, alice).size, 0);
        assertEq(oracle.latest(PID_A).priceWad, 93e18);
    }

    /// @dev Liquidations are not bound by maxTradePriceAge: a carried price older than that (but not stale
    ///      on arrival) liquidates, and so does a held price.
    function test_liquidate_oldOrHeldPriceStillLiquidates() public {
        _deposit(alice, mA, 110e6);
        _deposit(bob, mA, 110e6);
        _trade(alice, mA, 10e18);
        _trade(bob, mA, 10e18);
        vm.warp(block.timestamp + 2 hours);
        bytes memory old = _priceData(PID_A, 93e18, _now() - 290, false);
        vm.prank(keeper);
        engine.liquidate(mA, alice, old);
        assertEq(engine.positionOf(mA, alice).size, 0);
        bytes memory held = _priceData(PID_A, 92e18, _now(), true);
        vm.prank(keeper);
        engine.liquidate(mA, bob, held);
        assertEq(engine.positionOf(mA, bob).size, 0);
    }

    /// @dev Lookback guard for liquidators: a dip print from 50 minutes ago (newer than the stored price) does
    ///      not land, so it cannot liquidate a trader who is healthy at every price that can be stored.
    function test_liquidate_cannotCherryPickOldDip() public {
        _deposit(alice, mA, 110e6);
        _trade(alice, mA, 10e18);
        vm.warp(block.timestamp + 1 hours);
        bytes memory dip = _priceData(PID_A, 93e18, _now() - 50 minutes, false);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotLiquidatable.selector, alice));
        engine.liquidate(mA, alice, dip);
        assertEq(oracle.latest(PID_A).publishedAt, t0);
        // the same dip, published now, does liquidate
        vm.prank(keeper);
        engine.liquidate(mA, alice, _priceData(PID_A, 93e18, _now(), false));
        assertEq(engine.positionOf(mA, alice).size, 0);
    }

    function test_liquidate_badSignatureReverts() public {
        _deposit(alice, mA, 110e6);
        _trade(alice, mA, 10e18);
        vm.warp(block.timestamp + 1);
        bytes memory forged = _priceDataBy(OTHER_PK, PID_A, 50e18, _now(), false);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IAttestedOracle.BadSigner.selector, vm.addr(OTHER_PK)));
        engine.liquidate(mA, alice, forged);
        assertEq(engine.positionOf(mA, alice).size, 10e18);
        // and the empty bundle is the legacy call
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.NotLiquidatable.selector, alice));
        engine.liquidate(mA, alice, "");
    }

    // =================================================================== stored-price readers

    /// @dev withdrawMargin / withdrawLiquidity keep their signatures and read the stored price: a caller that
    ///      needs a fresh one lands `oracle.update` first (anyone may), then calls them.
    function test_storedPriceReaders_afterSeparateUpdate() public {
        _deposit(alice, mA, 10_000e6);
        _trade(alice, mA, 10e18);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, t0));
        engine.withdrawMargin(mA, 1e6);
        vm.prank(adA);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, t0));
        engine.withdrawLiquidity(mA, 1e6, adA);

        bytes memory pd = _priceData(PID_A, 100e18, _now(), false);
        vm.prank(stranger);
        oracle.update(pd);
        vm.prank(alice);
        engine.withdrawMargin(mA, 1e6);
        vm.prank(adA);
        engine.withdrawLiquidity(mA, 1e6, adA);
    }

    // =================================================================== fuzz

    function testFuzz_trade_newRiskAgeBound(uint32 age, uint32 maxTradeAge) public {
        uint256 a = bound(age, 0, 2 hours);
        uint32 m = uint32(bound(maxTradeAge, 1, 300));
        cfg.setMaxTradePriceAge(m);
        _deposit(alice, mA, 10_000e6);
        vm.warp(block.timestamp + 3 hours);
        uint64 at = uint64(block.timestamp - a);
        bytes memory pd = _priceData(PID_A, 100e18, at, false);
        uint256 bound_ = Math.min(m, engine.NEW_RISK_MAX_PRICE_AGE());
        // a print older than maxPriceAge is not landed: the trade sees the setUp price
        uint64 used = a > cfg.maxPriceAge() ? t0 : at;
        vm.prank(alice);
        if (a > bound_) {
            vm.expectRevert(abi.encodeWithSelector(PoolEngine.StalePrice.selector, PID_A, used));
            engine.trade(mA, 1e18, type(uint256).max, pd);
        } else {
            engine.trade(mA, 1e18, type(uint256).max, pd);
            assertEq(engine.positionOf(mA, alice).size, 1e18);
        }
        // a reduction never depends on the age
        if (engine.positionOf(mA, alice).size != 0) _tradeWith(alice, -1e18, "");
    }
}
