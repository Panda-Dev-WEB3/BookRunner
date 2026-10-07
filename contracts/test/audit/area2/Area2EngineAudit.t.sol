// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EngineBase} from "../../engine/utils/EngineBase.sol";
import {IPoolEngine} from "../../../src/interfaces/IPoolEngine.sol";

/// @notice Security audit, area 2 (marks / oracle / pool engine). Every test asserts the SECURE behaviour
///         and fails on the audited code.
contract Area2EngineAuditTest is EngineBase {
    uint128 internal constant CAP = 75_000e6;
    uint256 internal constant POOL = 100_000e6;
    uint256 internal constant IF = 25_000e6;

    address internal adA = makeAddr("adapterA");
    address internal longAcct = makeAddr("attackerLong");
    address internal shortAcct = makeAddr("attackerShort");
    address internal keeper = makeAddr("keeper");

    uint256 internal mA;

    function setUp() public {
        _deployCore();
        IPoolEngine.MarketConfig memory c = _defaultCfg(PID_A, CAP); // taker fee 10 bps, IM 10%, MM 5%
        c.fundingVelocityBps = 0; // isolate price PnL
        mA = _createMarket(adA, c);
        _fundPool(adA, mA, POOL, IF);
        _setQuote(adA, mA, 10, 0, CAP); // 10 bps wide
        _price(PID_A, PX);
    }

    function _now() internal view returns (uint64) {
        return uint64(block.timestamp);
    }

    /// @dev What the book (pool cash + IF + fees) holds for the market.
    function _bookSide() internal view returns (uint256) {
        IPoolEngine.MarketState memory s = engine.state(mA);
        return s.poolCashUsd + s.insuranceUsd + s.feesAccruedUsd;
    }

    /// @dev Closes `trader`'s whole position. First tries WITHOUT a price bundle (i.e. at the stored price, the
    ///      attacker's preferred route when the stored price is favourable); if the engine refuses that, closes
    ///      with the current signed print.
    function _closePreferStored(address trader, bytes memory currentPrint) internal {
        int256 size = engine.positionOf(mA, trader).size;
        if (size == 0) return;
        vm.prank(trader);
        try engine.trade(mA, -size, size > 0 ? 0 : type(uint256).max, "") {
            return;
        } catch {}
        vm.prank(trader);
        engine.trade(mA, -size, size > 0 ? 0 : type(uint256).max, currentPrint);
    }

    function _withdrawAll(address trader) internal returns (uint256 amount) {
        amount = engine.positionOf(mA, trader).marginUsd;
        if (amount == 0) return 0;
        vm.prank(trader);
        engine.withdrawMargin(mA, amount);
    }

    // =========================================================================================
    // A2-01  Reductions settle at an arbitrarily stale stored price: riskless two-account option
    // =========================================================================================

    /// @dev Pull mode: nobody pushes on a timer, so the stored price is whatever the last transaction landed.
    ///      The attacker opens a long and an equal short (pool net 0) on a fresh price. Ten minutes later the
    ///      market has moved +10 % (the signed print is public). The losing leg closes WITHOUT carrying a price
    ///      (reduction: no staleness bound) at the stale entry price; the winning leg then carries the fresh
    ///      print and closes at +10 %. The pair has no market exposure yet extracts ~the whole move from the
    ///      pool. Secure behaviour: a reduction cannot settle on a price older than the trade bound, so the
    ///      pair cannot be in profit beyond nothing (it pays spread + fees).
    function test_audit_staleReduceFreeOption() public {
        uint256 dep = 2_000e6;
        _deposit(longAcct, mA, dep);
        _deposit(shortAcct, mA, dep);
        _trade(longAcct, mA, 100e18); // $10k long at ~100.05
        _trade(shortAcct, mA, -100e18); // $10k short at ~99.95
        assertEq(engine.netExposureUsd(mA), 0, "pair is market-neutral for the pool");
        uint256 bookBefore = _bookSide();

        vm.warp(block.timestamp + 10 minutes);
        bytes memory current = _priceData(PID_A, 110e18, _now(), false); // public signed print: +10 %

        _closePreferStored(shortAcct, current); // loser first, at the stale stored 100 if allowed
        vm.prank(longAcct); // winner carries the fresh print
        engine.trade(mA, -100e18, 0, current);
        uint256 out = _withdrawAll(longAcct) + _withdrawAll(shortAcct);

        emit log_named_decimal_uint("attacker USDC out", out, 6);
        emit log_named_decimal_uint("attacker USDC in ", 2 * dep, 6);
        emit log_named_decimal_int("book (pool+IF+fees) delta", int256(_bookSide()) - int256(bookBefore), 6);
        assertLe(out, 2 * dep, "market-neutral pair extracted value from the pool via a stale-price close");
    }

    // =========================================================================================
    // A2-02  Session gap: a market-neutral pair converts the losing leg's gap loss into IF bad debt
    // =========================================================================================

    /// @dev Long + short at max leverage before the session closes (held price). The engine keeps both open
    ///      through the off-hours regime with no extra margin; the session reopens with a 20 % gap. The short is
    ///      liquidated with bad debt (IF pays), the long is paid the full gap. Secure behaviour: a zero-net pair
    ///      cannot extract value from the book's IF / pool (e.g. off-hours margin, or liquidation before the
    ///      gap at the held price).
    function test_audit_sessionGapPairDrainsInsurance() public {
        uint256 dep = 5_100e6; // IM 10 % of $50k + fee + spread
        _deposit(longAcct, mA, dep);
        _deposit(shortAcct, mA, dep);
        _trade(longAcct, mA, 500e18);
        _trade(shortAcct, mA, -500e18);
        uint256 bookBefore = _bookSide();

        // session close: the feed holds the last price; anyone may liquidate whatever is liquidatable now
        vm.warp(block.timestamp + 30);
        bytes memory held = _priceData(PID_A, PX, _now(), true);
        oracle.update(held);
        _tryLiquidate(longAcct, "");
        _tryLiquidate(shortAcct, "");

        // next session opens 20 % higher
        vm.warp(block.timestamp + 16 hours);
        bytes memory open = _priceData(PID_A, 120e18, _now(), false);
        _tryLiquidate(shortAcct, open);
        _tryLiquidate(longAcct, open);
        _closePreferStored(longAcct, open);
        _closePreferStored(shortAcct, open);
        uint256 out = _withdrawAll(longAcct) + _withdrawAll(shortAcct);

        emit log_named_decimal_uint("attacker USDC out", out, 6);
        emit log_named_decimal_uint("attacker USDC in ", 2 * dep, 6);
        emit log_named_decimal_int("book (pool+IF+fees) delta", int256(_bookSide()) - int256(bookBefore), 6);
        emit log_named_decimal_uint("IF after", engine.state(mA).insuranceUsd, 6);
        assertLe(out, 2 * dep, "market-neutral pair extracted the gap from the book's insurance fund");
    }

    function _tryLiquidate(address trader, bytes memory pd) internal {
        if (engine.positionOf(mA, trader).size == 0) return;
        vm.prank(keeper);
        try engine.liquidate(mA, trader, pd) {} catch {}
    }
}
