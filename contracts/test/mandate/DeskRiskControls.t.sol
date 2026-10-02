// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IMMMandate} from "../../src/interfaces/IMMMandate.sol";
import {BookrunnerDesk} from "../../src/BookrunnerDesk.sol";
import {MandateBase} from "./utils/MandateBase.sol";

/// @notice New desk / mandate controls: RISK Flatten bound + per-period key slippage budget (timelock
///         params, accounting) and MMMandate.checkFlatten.
contract DeskRiskControlsTest is MandateBase {
    event RiskSlippageParamsSet(uint16 riskMaxSlippageBps, uint16 periodSlippageBudgetBps);

    function test_defaults() public view {
        assertEq(desk.riskMaxSlippageBps(), 1000);
        assertEq(desk.periodSlippageBudgetBps(), 200);
        assertEq(desk.DEFAULT_RISK_MAX_SLIPPAGE_BPS(), 1000);
        assertEq(desk.DEFAULT_PERIOD_SLIPPAGE_BUDGET_BPS(), 200);
    }

    function test_setRiskSlippageParams_onlyTimelockAndBounded() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.Unauthorized.selector, stranger));
        desk.setRiskSlippageParams(500, 100);
        vm.startPrank(timelock);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.BadSlippage.selector, uint16(2001)));
        desk.setRiskSlippageParams(2001, 100);
        vm.expectRevert(abi.encodeWithSelector(BookrunnerDesk.BadSlippage.selector, uint16(10_001)));
        desk.setRiskSlippageParams(500, 10_001);
        vm.expectEmit(false, false, false, true, address(desk));
        emit RiskSlippageParamsSet(500, 50);
        desk.setRiskSlippageParams(500, 50);
        vm.stopPrank();
        assertEq(desk.riskMaxSlippageBps(), 500);
        assertEq(desk.periodSlippageBudgetBps(), 50);
    }

    function test_riskFlatten_boundFollowsParam() public {
        adapter.setExposure(-20_000e6);
        _fundDesk(10_000e6);
        uint256 tokens = _buyNvda(10_000e6);
        router.setHaircutBps(800);
        vm.prank(timelock);
        desk.setRiskSlippageParams(500, 200);
        vm.prank(risk);
        vm.expectPartialRevert(BookrunnerDesk.SlippageTooHigh.selector);
        desk.execute(_flattenAction(address(nvda), tokens, 0));
        vm.prank(timelock);
        desk.setRiskSlippageParams(900, 200);
        _exec(risk, _flattenAction(address(nvda), tokens, 0));
    }

    function test_slippageBudget_accountsLossesOnlyAndPerPeriod() public {
        adapter.setExposure(-50_000e6);
        _fundDesk(30_000e6);
        uint256 period = block.timestamp / cfg.markInterval();
        _buyNvda(20_000e6); // at the oracle price: only valuation rounding dust
        uint256 u0 = desk.slippageUsedUsd(period);
        assertLe(u0, 1);
        router.setBonusBps(100); // better than the oracle: never charged
        _buyNvda(1000e6);
        assertEq(desk.slippageUsedUsd(period), u0);
        router.setBonusBps(0);
        router.setHaircutBps(200);
        _buyNvda(5000e6);
        assertApproxEqAbs(desk.slippageUsedUsd(period), 100e6, 1e6);
        // the RISK path is never charged
        uint256 used = desk.slippageUsedUsd(period);
        _exec(risk, _flattenAction(address(nvda), 1e18, 0));
        assertEq(desk.slippageUsedUsd(period), used);
        // budget 0: any loss reverts
        vm.prank(timelock);
        desk.setRiskSlippageParams(1000, 0);
        vm.prank(key);
        vm.expectPartialRevert(BookrunnerDesk.SlippageBudgetExceeded.selector);
        desk.execute(_hedgeAction(address(nvda), true, 1000e6, 0));
    }

    // ------------------------------------------------------------------ checkFlatten (view)

    function test_checkFlatten_rules() public {
        // inactive key
        vm.expectRevert(abi.encodeWithSelector(IMMMandate.NotDeskKey.selector, stranger));
        mandate.checkFlatten(stranger, 10_000e6, 0);
        // long venue exposure: always fine
        adapter.setExposure(20_000e6);
        mandate.checkFlatten(key, 10_000e6, 0);
        // short venue: band (in band / strictly closer)
        adapter.setExposure(-20_000e6);
        mandate.checkFlatten(key, 20_000e6, 12_000e6); // 10000 -> 6000 in band
        mandate.checkFlatten(key, 30_000e6, 26_000e6); // 15000 -> 13000 closer
        vm.expectPartialRevert(IMMMandate.HedgeRatioOutOfBand.selector);
        mandate.checkFlatten(key, 12_000e6, 4000e6); // 6000 -> 2000
        // off-hours: must not grow |exposure + hedge|
        oracle.setHeld(NVDA_ID, true);
        mandate.checkFlatten(key, 30_000e6, 25_000e6); // |10k| -> |5k|
        vm.expectRevert(IMMMandate.OffHoursNewRisk.selector);
        mandate.checkFlatten(key, 20_000e6, 12_000e6); // |0| -> |8k|
        // killed: no key is active
        vm.prank(risk);
        mandate.kill("X");
        vm.expectRevert(IMMMandate.MandateKilled.selector);
        mandate.checkFlatten(key, 20_000e6, 0);
    }

    function test_checkFlatten_retiringAlwaysAllowed() public {
        adapter.setExposure(-20_000e6);
        oracle.setHeld(NVDA_ID, true);
        book.callSetRetiring();
        mandate.checkFlatten(key, 20_000e6, 0);
    }
}
