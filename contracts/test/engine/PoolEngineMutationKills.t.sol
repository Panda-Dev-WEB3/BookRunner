// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {EngineBase} from "./utils/EngineBase.sol";
import {PoolEngine} from "../../src/PoolEngine.sol";
import {IPoolEngine} from "../../src/interfaces/IPoolEngine.sol";

/// @title Mutation-testing kills for PoolEngine (audit 2026-10, Task 7c; docs/MUTATION-2026-10.md)
/// @notice Pins behaviour that a surviving mutant of src/PoolEngine.sol changed without any existing test noticing.
contract PoolEngineMutationKillsTest is EngineBase {
    address internal adA = makeAddr("adapterA");
    address internal alice = makeAddr("alice");
    uint256 internal mA;

    function setUp() public {
        _deployCore();
        mA = _createMarket(adA, _defaultCfg(PID_A, 75_000e6));
        _fundPool(adA, mA, 100_000e6, 25_000e6);
        _setQuote(adA, mA, 10, 0, 75_000e6);
        _price(PID_A, PX);
    }

    /// @dev Kills the deletion of `m.reduceOnly = true` in startCloseOut: scheduling a close-out on a market that is
    ///      not reduce-only yet makes it reduce-only at once (new risk refused, reductions allowed).
    function test_mut_startCloseOut_makesTheMarketReduceOnly() public {
        _deposit(alice, mA, 1000e6);
        _trade(alice, mA, 5e18);
        assertFalse(engine.state(mA).reduceOnly);
        vm.prank(adA);
        engine.startCloseOut(mA, 1 days);
        assertTrue(engine.state(mA).reduceOnly);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.MarketReduceOnly.selector, mA));
        engine.trade(mA, 1e18, type(uint256).max);
        engine.trade(mA, -5e18, 0); // closing still works
        vm.stopPrank();
        IPoolEngine.Position memory p = engine.positionOf(mA, alice);
        assertEq(p.size, 0);
    }
}
