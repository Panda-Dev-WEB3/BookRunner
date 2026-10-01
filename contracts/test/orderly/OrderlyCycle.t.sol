// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {OrderlyAdapter} from "../../src/OrderlyAdapter.sol";
import {BRTypes} from "../../src/interfaces/BRTypes.sol";

import {OrderlyFixture} from "./utils/OrderlyFixture.sol";

/// @notice End-to-end Orderly builder cycles against MockOrderlyVault, mirroring ops-venue's job order.
contract OrderlyCycleTest is OrderlyFixture {
    /// deposit -> report -> withdraw request -> confirm -> operatorWithdraw -> sweepToVault
    function test_fullCapitalCycle() public {
        uint256 idle0 = uwVault.idle();

        // 1. window close deploys IF + MM through the vault
        _deploy(IF, IF_TARGET);
        _deploy(MM, MM_INVENTORY);
        assertEq(uwVault.idle(), idle0 - 100_000e6);
        assertEq(adapter.deployedValueUsd(), 100_000e6);
        assertEq(bookMock.flowNonce(), 2);

        // 2. ops-venue reports venue state (MM made 1,200 USDC, holds a short)
        vm.warp(block.timestamp + 120);
        _report(25_000e6, 76_200e6, -8000e6);
        assertEq(adapter.deployedValueUsd(), 101_200e6);
        assertEq(adapter.netExposureUsd(), -8000e6);
        assertEq(adapter.valuationAt(), uint64(block.timestamp));
        // the venue's MM PnL is realised on Orderly's side (simulated as a credit to the account)
        _creditVenueFees(MM, 1200e6);

        // 3. keeper recalls MM liquidity for redemptions
        uint256 nonce = _recall(MM, 20_000e6);
        assertEq(bookMock.flowNonce(), 3);
        assertEq(adapter.deployedValueUsd(), 101_200e6, "request alone changes nothing");

        // 4. ops-venue executes on Orderly (delegate signer, receiver = adapter) and confirms
        vm.warp(block.timestamp + 30);
        _confirm(nonce);
        assertEq(adapter.marginEquityUsd(), int256(56_200e6));
        assertEq(adapter.inTransitUsd(), 20_000e6);
        assertEq(adapter.deployedValueUsd(), 101_200e6, "confirmation is NAV-neutral");

        // 5. Orderly pays the withdrawal to the adapter
        _payOut(MM, 20_000e6);
        assertEq(usdc.balanceOf(address(adapter)), 20_000e6);
        assertEq(adapter.deployedValueUsd(), 101_200e6, "landed principal still counted until swept");

        // 6. anyone sweeps it into the vault — once the mark of the period that just ended is applied
        assertFalse(adapter.sweepOpen(), "a period boundary passed: gate closed until its mark");
        _applyCurrentMark();
        uint256 navBefore = _navUsd();
        uint256 swept = adapter.sweepToVault();
        assertEq(swept, 20_000e6);
        assertEq(uwVault.idle(), idle0 - 80_000e6);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(adapter.deployedValueUsd(), 81_200e6);
        assertEq(_navUsd(), navBefore);

        // 7. a fresh report after the flow reconciles venue-side
        vm.warp(block.timestamp + 60);
        _report(25_000e6, 56_200e6, -8000e6);
        assertEq(adapter.deployedValueUsd(), 81_200e6);
        assertEq(ov.balanceOf(adapter.accountId(MM)), 56_200e6);
        assertEq(usdc.violations(), 0);
    }

    /// builder fee settlement: credit on Orderly -> earmark -> withdrawal lands -> forward to router
    function test_feeSettlementCycle() public {
        _deploy(IF, IF_TARGET);
        _deploy(MM, MM_INVENTORY);
        uint64 period = _firstFeePeriod();
        vm.warp(uint256(period) + 45);
        _applyCurrentMark();

        // Orderly settles the builder's 50% taker share (simulated into the MM account)
        _creditVenueFees(MM, 830e6);

        // ops-venue earmarks first so a permissionless sweep cannot reclassify the fee as principal
        vm.prank(ops);
        assertEq(adapter.sweepFees(period, 830e6), 0);
        _payOut(MM, 830e6);
        assertEq(adapter.sweepToVault(), 0, "earmarked fee flow is not vault-bound");
        assertEq(adapter.forwardPendingFees(), 830e6);

        assertEq(router.pendingGross(), 830e6);
        assertEq(router.lastSource(), BRTypes.SRC_VENUE_TAKER_SHARE);
        assertEq(adapter.totalFeesForwardedUsd(), 830e6);
        assertEq(usdc.violations(), 0);
    }

    /// The mark-window gate closes the double-count race: a mark snapshot taken after periodEnd includes
    /// landed-but-unswept principal; no sweep can move it into vault.idle() until that mark is applied.
    function test_markWindowGate_preventsDoubleCount() public {
        _deploy(MM, MM_INVENTORY);
        uint256 n = _recall(MM, 10_000e6);
        _confirm(n);
        _payOut(MM, 10_000e6);

        _warpToNextPeriod(5);
        // mark service snapshot at a block after periodEnd
        uint256 snapshotDeployed = adapter.deployedValueUsd();
        uint256 idleAtSnapshot = uwVault.idle();

        // an attacker tries to sweep before the mark is applied
        vm.prank(alice);
        vm.expectRevert();
        adapter.sweepToVault();

        // Book.applyMark: nav = live idle + snapshot deployed — unchanged by the blocked sweep
        assertEq(uwVault.idle() + snapshotDeployed, idleAtSnapshot + snapshotDeployed);
        _applyCurrentMark();

        // after application the sweep is free and NAV-neutral for the next snapshot
        uint256 navBefore = _navUsd();
        adapter.sweepToVault();
        assertEq(_navUsd(), navBefore);
    }

    /// Retirement: IF + MM recalled, swept, deployed value reaches exactly zero for the final mark.
    function test_windDownToZeroDeployedValue() public {
        _deploy(IF, IF_TARGET);
        _deploy(MM, MM_INVENTORY);
        bookMock.setState(BRTypes.BookState.Retiring);
        uint256 a = _recall(IF, IF_TARGET);
        uint256 b = _recall(MM, MM_INVENTORY);
        _confirm(a);
        _confirm(b);
        _payOut(IF, IF_TARGET);
        _payOut(MM, MM_INVENTORY);
        adapter.sweepToVault();
        vm.warp(block.timestamp + 10);
        _report(0, 0, 0);
        assertEq(adapter.deployedValueUsd(), 0);
        assertEq(uwVault.idle(), 1_000_000e6);
        assertEq(usdc.balanceOf(address(adapter)), 0);
    }

    /// Venue withdrawal fee: recorded at confirmation so in-transit clears exactly (no phantom asset).
    function test_withdrawalFee_noPhantomInTransit() public {
        _deploy(MM, MM_INVENTORY);
        uint256 n = _recall(MM, 10_000e6);
        vm.prank(ops);
        adapter.confirmWithdrawWithFee(n, 1e6);
        bytes32 mmId = adapter.accountId(MM);
        vm.prank(orderlyOperator);
        ov.operatorWithdrawWithFee(mmId, address(adapter), 10_000e6, 1e6);
        assertEq(adapter.sweepToVault(), 9999e6);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(adapter.deployedValueUsd(), 65_000e6);
    }

    /// NAV neutrality of all on-chain flows (fuzz): vault idle + deployed value is conserved by deposits,
    /// requests, confirmations and sweeps when nothing is lost on the venue.
    function testFuzz_flowsAreNavNeutral(uint96 ifAmt, uint96 mmAmt, uint96 recallMm, uint96 landed) public {
        ifAmt = uint96(bound(ifAmt, 1, 200_000e6));
        mmAmt = uint96(bound(mmAmt, 1, 500_000e6));
        recallMm = uint96(bound(recallMm, 1, mmAmt));
        landed = uint96(bound(landed, 0, recallMm));
        uint256 nav0 = _navUsd();

        _deploy(IF, ifAmt);
        _deploy(MM, mmAmt);
        assertEq(_navUsd(), nav0);
        uint256 n = _recall(MM, recallMm);
        assertEq(_navUsd(), nav0);
        _confirm(n);
        assertEq(_navUsd(), nav0);
        if (landed > 0) _payOut(MM, landed);
        assertEq(_navUsd(), nav0);
        adapter.sweepToVault();
        assertEq(_navUsd(), nav0);
        assertEq(adapter.inTransitUsd(), uint256(recallMm) - landed);
        assertEq(usdc.violations(), 0);
    }
}
