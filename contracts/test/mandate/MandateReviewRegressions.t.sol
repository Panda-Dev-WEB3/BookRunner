// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IBookrunnerDesk} from "../../src/interfaces/IBookrunnerDesk.sol";
import {IMMMandate} from "../../src/interfaces/IMMMandate.sol";
import {BookrunnerDesk} from "../../src/BookrunnerDesk.sol";
import {MMMandate} from "../../src/MMMandate.sol";
import {MandateBase} from "./utils/MandateBase.sol";
import {MandateMockAdapter} from "./utils/MandateMocks.sol";

/// @notice Regressions for the adversarial-review findings on MMMandate / BookrunnerDesk. Only the pre-fix ABI
///         is used (new errors by selector) so every test compiles against, and FAILS on, the old code.
contract MandateReviewRegressionsTest is MandateBase {
    bytes4 internal constant SLIPPAGE_BUDGET_EXCEEDED = bytes4(keccak256("SlippageBudgetExceeded(uint256,uint256)"));

    function _sellAction(uint256 tokens) internal view returns (IBookrunnerDesk.Action memory a) {
        a = _hedgeAction(address(nvda), false, tokens, 0);
    }

    function _tokensFor(uint256 usd) internal pure returns (uint256) {
        return usd * 1e12 * 1e18 / NVDA_PX;
    }

    // =================================================================== risk-flatten-no-slippage

    /// @dev PoC: a compromised RISK key dumps the desk's NVDA into its own thin pool (99% below the oracle)
    ///      with minAmountOut 0. With a fresh price the RISK Flatten is now bounded (riskMaxSlippageBps, 10%).
    function test_regression_riskFlattenBoundedWhenPriceFresh() public {
        adapter.setExposure(-20_000e6);
        _fundDesk(15_000e6);
        uint256 tokens = _buyNvda(15_000e6);
        router.setHaircutBps(9900);
        vm.prank(risk);
        vm.expectPartialRevert(BookrunnerDesk.SlippageTooHigh.selector);
        desk.execute(_flattenAction(address(nvda), tokens, 0));
        assertEq(nvda.balanceOf(address(desk)), tokens);
        // a normal emergency unwind (5% below the oracle) still goes through
        router.setHaircutBps(500);
        _exec(risk, _flattenAction(address(nvda), tokens, 0));
        assertEq(nvda.balanceOf(address(desk)), 0);
    }

    /// @dev ...and the emergency path is still never blocked by a stale price (no bound can be computed).
    function test_riskFlatten_stalePriceStillNeverBlocked() public {
        adapter.setExposure(-20_000e6);
        _fundDesk(15_000e6);
        uint256 tokens = _buyNvda(15_000e6);
        vm.warp(block.timestamp + 301);
        router.setHaircutBps(9000);
        _exec(risk, _flattenAction(address(nvda), tokens, 0));
        assertEq(nvda.balanceOf(address(desk)), 0);
    }

    // =================================================================== key-flatten-bypasses-band-offhours

    /// @dev PoC: venue -50k, desk 45k NVDA (ratio 9000), feed held. A Hedge sell of everything reverts
    ///      OffHoursNewRisk; the same sale as a key Flatten used to succeed (|net| -5k -> -50k off-hours).
    function test_regression_keyFlattenMeetsOffHoursRule() public {
        adapter.setExposure(-50_000e6);
        _fundDesk(45_000e6);
        uint256 tokens = _buyNvda(45_000e6);
        oracle.setHeld(NVDA_ID, true);
        vm.prank(key);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.execute(_sellAction(tokens));
        vm.prank(key);
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        desk.execute(_flattenAction(address(nvda), tokens, 0));
        assertEq(nvda.balanceOf(address(desk)), tokens);
        // RISK (reduce-only emergency role) is not subject to it
        _exec(risk, _flattenAction(address(nvda), tokens, 0));
    }

    /// @dev On-hours variant: selling the whole hedge drops the ratio 9000 -> 0, below the 5000 band floor.
    function test_regression_keyFlattenMeetsBand() public {
        adapter.setExposure(-50_000e6);
        _fundDesk(45_000e6);
        uint256 tokens = _buyNvda(45_000e6);
        vm.prank(key);
        vm.expectPartialRevert(IMMMandate.HedgeRatioOutOfBand.selector);
        desk.execute(_flattenAction(address(nvda), tokens, 0));
        // an in-band trim is fine (45k -> 40k: ratio 8000)
        _exec(key, _flattenAction(address(nvda), _tokensFor(5000e6), 0));
        // with a long venue exposure the spot hedge offsets nothing: selling it always reduces net risk
        adapter.setExposure(30_000e6);
        _exec(key, _flattenAction(address(nvda), nvda.balanceOf(address(desk)), 0));
        assertEq(nvda.balanceOf(address(desk)), 0);
    }

    // =================================================================== no-cumulative-slippage-budget

    /// @dev PoC: a key churns in-band round trips through its own pool 2.9% off the oracle (each leg passes the
    ///      3% per-swap bound). The desk now caps key swaps' cumulative loss vs the oracle per mark period at
    ///      200 bps of maxInventoryUsd (50k -> 1,000 USDC).
    function test_regression_keySwapChurnBoundedByPeriodBudget() public {
        adapter.setExposure(-50_000e6);
        _fundDesk(55_000e6);
        _buyNvda(40_000e6); // ratio 8000
        router.setHaircutBps(290);
        _exec(key, _sellAction(_tokensFor(12_000e6))); // in band (5600), loss ~348
        _exec(key, _hedgeAction(address(nvda), true, 12_000e6, 0)); // in band, loss ~348 (696)
        vm.prank(key);
        vm.expectPartialRevert(SLIPPAGE_BUDGET_EXCEEDED);
        desk.execute(_sellAction(_tokensFor(12_000e6))); // +348 -> 1,044 > 1,000
        // the budget is per mark period
        vm.warp(block.timestamp + cfg.markInterval());
        _refreshPrices();
        _exec(key, _sellAction(_tokensFor(12_000e6)));
    }

    // =================================================================== band-unenforced-naked-spot

    /// @dev PoC: near-flat venue (-1k, below the 5% band threshold of 50k): a key used to be able to buy up to
    ///      the FundDesk cap of spot as a naked long. Spot legs below the threshold now keep the net book
    ///      position |exposure + hedge| within max(its prior value, 5% of maxInventory).
    function test_regression_nakedSpotBelowBandThresholdBounded() public {
        adapter.setExposure(-1000e6);
        _fundDesk(20_000e6);
        vm.prank(key);
        vm.expectPartialRevert(IMMMandate.InventoryLimit.selector);
        desk.execute(_hedgeAction(address(nvda), true, 20_000e6, 0));
        // a small offsetting buy (net -1k -> +2k) stays within 5% (2.5k)
        _exec(key, _hedgeAction(address(nvda), true, 3000e6, 0));
        // selling back is always fine
        _exec(key, _sellAction(nvda.balanceOf(address(desk))));
    }

    // =================================================================== remandate-stale-engine-quote (unit)

    function test_regression_remandateAppliesNewTermsToEngineAdapter() public {
        BRTypes.Mandate memory m = _defaultMandate();
        m.maxInventoryUsd = 30_000e6;
        vm.prank(committee);
        mandate.remandate(m);
        assertEq(adapter.applyMandateCalls(), 1);
        assertTrue(adapter.reduceOnly());
    }

    function test_remandate_adapterHookFailureReverts_orderlyBooksSkipIt() public {
        adapter.setRevertApplyMandate(true);
        vm.prank(committee);
        vm.expectRevert(bytes("applyMandate reverts"));
        mandate.remandate(_defaultMandate());
        // Orderly book: no engine hook
        (, MMMandate m2,,, MandateMockAdapter a2) = _newBook(8, BRTypes.VENUE_ORDERLY);
        vm.prank(committee);
        m2.remandate(_defaultMandate());
        assertEq(a2.applyMandateCalls(), 0);
    }
}
