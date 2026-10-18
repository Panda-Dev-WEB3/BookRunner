// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EngineBase} from "../../engine/utils/EngineBase.sol";
import {PoolEngine} from "../../../src/PoolEngine.sol";
import {StockTokenRegistry} from "../../../src/StockTokenRegistry.sol";
import {IStockTokenRegistry} from "../../../src/interfaces/IStockTokenRegistry.sol";
import {MockStockToken} from "../../../src/mocks/MockStockToken.sol";

/// @title Audit remediation N-1 (new finding from the M-2 review): PoolEngine per-share positions across a split.
/// @notice Engine positions are sized in units of the market's price id (shares) and are never rebased, and a
///         split's `effectiveAt` is public days ahead. A trader shorts before a 10:1 split; at the reopen the
///         per-share price prints at 1/10 and the short books ~90% of notional from the pool (a reverse split
///         gives the same to a long). Fix: while an out-of-band change of the market's token (any component,
///         for an index) is pre-approved or staged, new risk reverts SplitPending (close-only); while the price
///         predates the change (split window), every voluntary trade reverts SplitWindow. Liquidations stay open.
contract N1EngineSplitTest is EngineBase {
    uint128 internal constant MAX_NET = 1_000_000e6;
    uint256 internal constant POOL = 500_000e6;
    uint256 internal constant IF = 100_000e6;
    uint256 internal constant SAT = T0 + 2 days;

    StockTokenRegistry internal registry;
    MockStockToken internal nvda;
    MockStockToken internal tsla;
    address internal ad = makeAddr("adapter");
    address internal adIdx = makeAddr("adapterIdx");
    address internal alice = makeAddr("alice");
    uint256 internal mid; // NVDA market (PID_B)

    function setUp() public {
        _deployCore();
        registry = new StockTokenRegistry(address(cfg), address(0));
        cfg.setStockRegistry(address(registry));
        nvda = new MockStockToken("NVIDIA Stock Token", "NVDA", 1e18);
        nvda.updateMultiplier(1e18, 0);
        tsla = new MockStockToken("Tesla Stock Token", "TSLA", 1e18);
        tsla.updateMultiplier(1e18, 0);
        vm.startPrank(timelock);
        registry.register(address(nvda), PID_B, 1e18, 0);
        registry.register(address(tsla), bytes32("TSLA"), 1e18, 0);
        registry.setMultiplierSource(address(nvda), true);
        registry.setMultiplierSource(address(tsla), true);
        vm.stopPrank();
        mid = _createMarket(ad, _defaultCfg(PID_B, MAX_NET));
        _fundPool(ad, mid, POOL, IF);
        _setQuote(ad, mid, 10, 0, MAX_NET);
        vm.warp(block.timestamp + 1);
        _price(PID_B, PX);
        _deposit(alice, mid, 5_000e6);
    }

    function _stageSplit(MockStockToken tok, uint256 m, bool preApprove) internal {
        tok.updateMultiplier(m, SAT);
        if (preApprove) {
            vm.prank(timelock);
            registry.setNextMultiplierAnchor(address(tok), m);
        }
    }

    /// @notice The exploit the gate removes (no registry = no gate, the audited engine): a 100-unit short opened
    ///         at $100 before a 10:1 split books ~$9,000 (90% of its $10,000 notional) at the reopen print.
    function test_N1_exploit_withoutGate_shortTakes90PercentAtTheReopen() public {
        _stageSplit(nvda, 10e18, true);
        cfg.setStockRegistry(address(0));
        _trade(alice, mid, -100e18);
        vm.warp(SAT + 2 days);
        _price(PID_B, PX / 10); // the reopen: post-split per-share price
        int256 equity = engine.traderEquityUsd(mid, alice);
        assertGt(equity, int256(5_000e6 + 8_900e6)); // margin + ~90% of notional, paid by the pool
    }

    /// @notice Fixed: with the split pre-approved (or only staged on the token), opening or increasing a
    ///         position reverts SplitPending.
    function test_N1_poc_shortBeforeSplit_reverts() public {
        _stageSplit(nvda, 10e18, true);
        (bool pending, bool window) = registry.splitGate(PID_B, uint64(block.timestamp));
        assertTrue(pending);
        assertFalse(window);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.SplitPending.selector, mid));
        engine.trade(mid, -100e18, 0);
        // a reverse split on the long side
        vm.prank(timelock);
        registry.setNextMultiplierAnchor(address(nvda), 0);
        _stageSplit(nvda, 0.1e18, false); // staged on the token, not (yet) pre-approved: pending too
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.SplitPending.selector, mid));
        engine.trade(mid, 100e18, type(uint256).max);
    }

    /// @notice Close-only: a position opened before the announcement can be reduced or closed, not increased;
    ///         margin cannot be withdrawn against it.
    function test_N1_pending_closeOnly() public {
        _trade(alice, mid, -100e18);
        _stageSplit(nvda, 10e18, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.SplitPending.selector, mid));
        engine.trade(mid, -1e18, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.SplitPending.selector, mid));
        engine.withdrawMargin(mid, 1e6);
        _trade(alice, mid, 40e18); // reduce
        _trade(alice, mid, 60e18); // close
        assertEq(engine.positionOf(mid, alice).size, 0);
    }

    /// @notice Split window in an open session: the last pre-split print is still fresh, every voluntary trade
    ///         (closes too) reverts SplitWindow until the oracle prints after the change; after the reprice
    ///         and the governance re-anchor + cleanup the market trades normally.
    function test_N1_window_everyTradeReverts_untilRepriced() public {
        _trade(alice, mid, -10e18);
        _stageSplit(nvda, 10e18, true);
        vm.warp(SAT - 3);
        _price(PID_B, PX);
        vm.warp(SAT + 5); // the print is 8 s old: fresh for trades (15 s), but pre-split
        (, bool window) = registry.splitGate(PID_B, uint64(SAT - 3));
        assertTrue(window);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.SplitWindow.selector, mid));
        engine.trade(mid, 10e18, type(uint256).max); // even the close
        _price(PID_B, PX / 10); // first post-split print
        _trade(alice, mid, 10e18); // close works again (still close-only until cleanup)
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.SplitPending.selector, mid));
        engine.trade(mid, -1e18, 0);
        vm.startPrank(timelock);
        registry.setMultiplier(address(nvda), 10e18);
        registry.setNextMultiplierAnchor(address(nvda), 0);
        vm.stopPrank();
        vm.warp(block.timestamp + 1);
        _price(PID_B, PX / 10); // a print after the re-anchor stamp
        _trade(alice, mid, -1e18);
        assertEq(engine.positionOf(mid, alice).size, -1e18);
    }

    /// @notice An index market (price id of the index level) is gated by any component's split.
    function test_N1_indexMarket_componentSplitGates() public {
        IStockTokenRegistry.IndexComponent[] memory cs = new IStockTokenRegistry.IndexComponent[](2);
        cs[0] = IStockTokenRegistry.IndexComponent({token: address(nvda), weightBps: 6000});
        cs[1] = IStockTokenRegistry.IndexComponent({token: address(tsla), weightBps: 4000});
        vm.prank(timelock);
        registry.registerIndex(keccak256("BKRN.INDEX.RHX5"), PID_A, cs);
        uint256 idx = _createMarket(adIdx, _defaultCfg(PID_A, MAX_NET));
        _fundPool(adIdx, idx, POOL, IF);
        _setQuote(adIdx, idx, 10, 0, MAX_NET);
        _price(PID_A, PX);
        _deposit(alice, idx, 5_000e6);
        _trade(alice, idx, -10e18); // no change pending: trades
        _stageSplit(tsla, 3e18, true); // a 3:1 split of one component
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PoolEngine.SplitPending.selector, idx));
        engine.trade(idx, -10e18, 0);
        _trade(alice, idx, 10e18); // closing is allowed
    }

    /// @notice In-band drift (a dividend reinvestment staged on the token) is not a split: no gate.
    function test_N1_inBandChange_notGated() public {
        nvda.updateMultiplier(1.01e18, SAT);
        (bool pending,) = registry.splitGate(PID_B, uint64(block.timestamp));
        assertFalse(pending);
        _trade(alice, mid, -10e18);
    }
}
