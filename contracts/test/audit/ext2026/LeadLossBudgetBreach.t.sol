// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {EngineBase} from "../../engine/utils/EngineBase.sol";
import {PoolEngine} from "../../../src/PoolEngine.sol";
import {IPoolEngine} from "../../../src/interfaces/IPoolEngine.sol";

/// @title Audit 2026-10 M-3 follow-up (Task 3 review minor 5): a spent loss budget leaves an on-chain trace.
/// @notice A spent budget makes new risk revert (LossBudgetExceeded), so nothing was emitted and nothing off-chain
///         could see the breach except by calling the view. Fix: `LossBudgetBreached(marketId, period, loss, budget)`,
///         once per market and period, from the first successful transaction that observes the breach (a
///         reduction, a close, a liquidation, a close-out) or from the permissionless `pokeLossBudget`.
contract LeadLossBudgetBreachTest is EngineBase {
    event LossBudgetBreached(uint256 indexed marketId, uint64 period, int256 lossUsd, uint256 budgetUsd);

    address internal ad = makeAddr("adapter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");
    uint128 internal constant MAX_NET = 75_000e6;
    uint256 internal constant POOL = 100_000e6;
    uint256 internal mid;
    uint64 internal period;

    function setUp() public {
        _deployCore();
        IPoolEngine.MarketConfig memory c = _defaultCfg(PID_A, MAX_NET);
        c.fundingVelocityBps = 0;
        mid = _createMarket(ad, c);
        _fundPool(ad, mid, POOL, 25_000e6);
        _setQuote(ad, mid, 10, 0, MAX_NET);
        // start at the beginning of a loss period (markInterval 300 s)
        vm.warp((block.timestamp / 300 + 1) * 300);
        period = uint64(block.timestamp / 300 + 1);
        _price(PID_A, PX);
        _deposit(alice, mid, 10_000e6);
        _deposit(bob, mid, 1_000e6);
        _trade(alice, mid, 500e18); // anchors the period at 100,000; pool short 500 units
        _price(PID_A, 117e18); // the pool loses ~8,500 > the 8,000 budget
    }

    function _breachLogs() internal returns (uint256 n) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == LossBudgetBreached.selector) n++;
        }
    }

    /// @notice A reduction observing the breach emits the event once; later transactions in the period do not.
    function test_lead_lossBudgetBreach_emittedOncePerPeriod() public {
        (,,, int256 loss, uint256 budget, bool blocked) = engine.lossBudget(mid);
        assertTrue(blocked);
        // the reduction realises part of the trader's gain at the sell fill (spread in the pool's favour)
        vm.recordLogs();
        _trade(alice, mid, -10e18);
        assertEq(_breachLogs(), 1, "reported by the reduction");
        (,,, int256 lossAfter,,) = engine.lossBudget(mid);
        assertApproxEqAbs(lossAfter, loss, 10e6);
        // new risk still reverts, and nothing more is emitted in this period
        vm.prank(bob);
        vm.expectPartialRevert(PoolEngine.LossBudgetExceeded.selector);
        engine.trade(mid, 1e18, type(uint256).max);
        vm.recordLogs();
        _trade(alice, mid, -10e18);
        engine.pokeLossBudget(mid);
        assertEq(_breachLogs(), 0, "once per period");
        assertGt(loss, int256(budget));
    }

    function test_lead_lossBudgetBreach_eventFields() public {
        _trade(alice, mid, -1e18); // first observation
        // reproduce the fields at the next period's breach instead: re-anchor, lose again
        vm.warp(block.timestamp + 300);
        uint64 p2 = uint64(block.timestamp / 300 + 1);
        _price(PID_A, 117e18);
        _trade(bob, mid, 1e18); // anchors p2 (new risk: allowed, the budget is fresh)
        _price(PID_A, 140e18);
        (,, int256 anchor, int256 loss, uint256 budget, bool blocked) = engine.lossBudget(mid);
        assertTrue(blocked);
        assertEq(budget, uint256(anchor) * 800 / 1e4);
        vm.expectEmit(true, false, false, true, address(engine));
        emit LossBudgetBreached(mid, p2, loss, budget);
        engine.pokeLossBudget(mid);
    }

    /// @notice A pure price move with no trade: the poke (anyone) records it; within budget it emits nothing.
    function test_lead_lossBudgetBreach_poke() public {
        vm.recordLogs();
        vm.prank(keeper);
        engine.pokeLossBudget(mid);
        assertEq(_breachLogs(), 1);
        // a market within its budget: no event
        address ad2 = makeAddr("adapter2");
        uint256 m2 = _createMarket(ad2, _defaultCfg(PID_B, MAX_NET));
        _fundPool(ad2, m2, POOL, 0);
        _setQuote(ad2, m2, 10, 0, MAX_NET);
        _price(PID_B, PX);
        _deposit(bob, m2, 1_000e6);
        _trade(bob, m2, 10e18);
        vm.recordLogs();
        engine.pokeLossBudget(m2);
        assertEq(_breachLogs(), 0);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.UnknownMarket.selector, uint256(99)));
        engine.pokeLossBudget(99);
    }

    /// @notice A liquidation observing the breach reports it.
    function test_lead_lossBudgetBreach_liquidationReports() public {
        vm.warp(block.timestamp + 300);
        _price(PID_A, 117e18);
        _trade(bob, mid, -50e18); // anchors the new period (bob short 50 @ ~116.94, margin 1,000)
        _price(PID_A, 140e18); // the pool loses ~10k net on alice's long; bob's short is past its margin
        assertTrue(engine.isLiquidatable(mid, bob));
        vm.recordLogs();
        vm.prank(keeper);
        engine.liquidate(mid, bob);
        assertEq(_breachLogs(), 1);
    }

    /// @notice No anchor in the current period (no trade yet): nothing to report, whatever the price did.
    function test_lead_lossBudgetBreach_noAnchorNoEvent() public {
        vm.warp(block.timestamp + 300);
        _price(PID_A, 200e18);
        vm.recordLogs();
        engine.pokeLossBudget(mid);
        assertEq(_breachLogs(), 0);
    }
}
