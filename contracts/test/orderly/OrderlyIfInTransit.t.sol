// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {OrderlyAdapter} from "../../src/OrderlyAdapter.sol";

import {OrderlyFixture} from "./utils/OrderlyFixture.sol";

/// @notice [2026-10 pool follow-up m-6] The IF part of the adapter's in-transit (`insuranceInTransitUsd`): the mark signs
///         insuranceEquityUsd() + insuranceInTransitUsd() as the IF equity, so an IF deposit or recall in flight is never
///         read as an IF draw. The IF part follows confirmations, failures, write-offs and sweeps, never exceeds
///         `inTransitUsd`, and a sweep (which cannot tell an IF payout from an MM one) clears it first.
contract OrderlyIfInTransitTest is OrderlyFixture {
    address internal constant BUILDER_IF_EOA = address(0xB1F0);

    function setUp() public override {
        super.setUp();
        _deploy(IF, 25_000e6);
        _deploy(MM, 75_000e6);
        vm.warp(block.timestamp + 10);
        _report(25_000e6, 75_000e6, 0);
        _applyCurrentMark();
    }

    /// @dev What the mark signs as the IF equity (services/mark markInsuranceEquityUsd).
    function _signedIf() internal view returns (uint256) {
        return adapter.insuranceEquityUsd() + adapter.insuranceInTransitUsd();
    }

    function test_depositInFlight_isIfEquityAtOnce_andNoEarlierReportCanUndoIt() public {
        uint64 before = uint64(block.timestamp) + 3;
        vm.warp(block.timestamp + 5);
        _deploy(IF, 5_000e6); // the venue credits it later (cross-chain): the adapter counts it now
        assertEq(adapter.insuranceEquityUsd(), 30_000e6);
        assertEq(_signedIf(), 30_000e6, "a deposit in flight is no IF draw");
        uint64 flowAt = adapter.lastFlowAt();
        vm.prank(ops); // a venue snapshot taken before the deposit cannot overwrite it
        vm.expectRevert(abi.encodeWithSelector(OrderlyAdapter.ReportPredatesFlow.selector, before, flowAt));
        adapter.report(25_000e6, 75_000e6, 0, before);
    }

    function test_ifRecallInFlight_staysIfEquity_untilSwept() public {
        uint256 nav0 = _navUsd();
        uint256 n = _recall(IF, 10_000e6);
        assertEq(_signedIf(), 25_000e6, "Requested: still venue-side");
        _confirm(n);
        assertEq(adapter.insuranceEquityUsd(), 15_000e6);
        assertEq(adapter.inTransitUsd(), 10_000e6);
        assertEq(adapter.insuranceInTransitUsd(), 10_000e6, "the IF part of in-transit");
        assertEq(_signedIf(), 25_000e6, "a recall in flight is no IF draw");
        assertEq(_navUsd(), nav0);
        _payOut(IF, 10_000e6);
        assertEq(adapter.sweepToVault(), 10_000e6);
        assertEq(adapter.insuranceInTransitUsd(), 0);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(_signedIf(), 15_000e6, "back in the vault: no longer IF equity");
    }

    function test_mmRecall_neverIfInTransit() public {
        uint256 n = _recall(MM, 20_000e6);
        _confirm(n);
        assertEq(adapter.inTransitUsd(), 20_000e6);
        assertEq(adapter.insuranceInTransitUsd(), 0);
        assertEq(_signedIf(), 25_000e6);
    }

    function test_venueFee_ifPartIsNetOfIt() public {
        uint256 n = _recall(IF, 10_000e6);
        vm.prank(ops);
        adapter.confirmWithdrawWithFee(n, 1e6);
        assertEq(adapter.insuranceInTransitUsd(), 10_000e6 - 1e6);
        assertEq(adapter.inTransitUsd(), 10_000e6 - 1e6);
    }

    function test_failedIfWithdrawal_backVenueSide_notInTransit() public {
        uint256 n = _recall(IF, 10_000e6);
        _confirm(n);
        vm.prank(ops);
        adapter.failWithdraw(n);
        assertEq(adapter.insuranceInTransitUsd(), 0);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(adapter.insuranceEquityUsd(), 25_000e6);
        assertEq(_signedIf(), 25_000e6, "counted once, venue-side");
    }

    function test_failedMmWithdrawal_leavesTheIfPart() public {
        uint256 i = _recall(IF, 10_000e6);
        _confirm(i);
        uint256 m = _recall(MM, 20_000e6);
        _confirm(m);
        vm.prank(ops);
        adapter.failWithdraw(m);
        assertEq(adapter.inTransitUsd(), 10_000e6);
        assertEq(adapter.insuranceInTransitUsd(), 10_000e6);
    }

    /// @notice Both in flight, only the MM payout landed: the sweep cannot tell which landed and clears the IF part first
    ///         (understated, never overstated: at worst Backstop cover waits for a later mark); the IF payout landing later
    ///         is swept as the remaining principal.
    function test_mixedSweep_clearsTheIfPartFirst_neverOverstates() public {
        uint256 i = _recall(IF, 10_000e6);
        _confirm(i);
        uint256 m = _recall(MM, 20_000e6);
        _confirm(m);
        assertEq(adapter.insuranceInTransitUsd(), 10_000e6);
        _payOut(MM, 20_000e6);
        assertEq(adapter.sweepToVault(), 20_000e6);
        assertEq(adapter.inTransitUsd(), 10_000e6);
        assertEq(adapter.insuranceInTransitUsd(), 0, "cleared first");
        _payOut(IF, 10_000e6);
        assertEq(adapter.sweepToVault(), 10_000e6);
        assertEq(adapter.inTransitUsd(), 0);
        assertEq(adapter.insuranceInTransitUsd(), 0);
    }

    function test_partialSweep_ifPartWithinWhatIsLeft() public {
        uint256 i = _recall(IF, 10_000e6);
        _confirm(i);
        _payOut(IF, 4_000e6); // part of it landed (a test venue paying in two transfers)
        assertEq(adapter.sweepToVault(), 4_000e6);
        assertEq(adapter.inTransitUsd(), 6_000e6);
        assertEq(adapter.insuranceInTransitUsd(), 6_000e6);
    }

    function test_writtenOffOperatorPayout_leavesTheIfPart() public {
        // builder IF mode needs an empty IF account: recall the setUp IF first
        uint256 r = _recall(IF, 25_000e6);
        _confirm(r);
        _payOut(IF, 25_000e6);
        adapter.sweepToVault();
        vm.prank(timelock);
        adapter.setIfAccountOwner(BUILDER_IF_EOA);
        _deploy(IF, 25_000e6);
        uint256 n = _recall(IF, 10_000e6);
        _confirm(n);
        assertEq(adapter.insuranceInTransitUsd(), 10_000e6);
        vm.warp(block.timestamp + adapter.WRITE_OFF_MIN_AGE());
        vm.prank(ops);
        adapter.writeOffOperatorPayout(n);
        assertEq(adapter.insuranceInTransitUsd(), 0, "written off: neither in transit nor IF equity");
        assertEq(adapter.inTransitUsd(), 0);
    }

    /// @notice Any sequence of IF / MM recalls (confirmed at once), venue failures, payouts and sweeps: the IF part never
    ///         exceeds in-transit nor the IF amounts confirmed and still unpaid or unswept.
    function testFuzz_ifPart_boundedByInTransit(uint256[16] calldata seeds) public {
        uint256[] memory nonces = new uint256[](16);
        bool[] memory paid = new bool[](16);
        uint256 n;
        for (uint256 k; k < seeds.length; ++k) {
            uint256 s = seeds[k];
            uint256 op = s % 4;
            if (op == 0) {
                uint8 account = (s >> 8) % 2 == 0 ? IF : MM;
                uint256 cap = account == IF ? adapter.insuranceEquityUsd() : uint256(adapter.marginEquityUsd());
                uint256 amt = bound(s >> 16, 0, cap);
                if (amt == 0) continue;
                nonces[n] = _recall(account, amt);
                _confirm(nonces[n++]);
            } else if (op < 3 && n > 0) {
                uint256 j = (s >> 8) % n;
                OrderlyAdapter.WithdrawRequest memory w = adapter.withdrawRequest(nonces[j]);
                if (w.status != OrderlyAdapter.WithdrawStatus.Confirmed || paid[j]) continue;
                if (op == 1) {
                    vm.prank(ops);
                    adapter.failWithdraw(nonces[j]); // the venue credited it back
                } else {
                    paid[j] = true;
                    _payOut(w.account, w.amount);
                }
            } else if (op == 3) {
                adapter.sweepToVault();
            }
            assertLe(adapter.insuranceInTransitUsd(), adapter.inTransitUsd(), "IF part <= in transit");
            uint256 ifOpen;
            for (uint256 j; j < n; ++j) {
                OrderlyAdapter.WithdrawRequest memory w = adapter.withdrawRequest(nonces[j]);
                if (w.account == IF && w.status == OrderlyAdapter.WithdrawStatus.Confirmed) ifOpen += w.amount;
            }
            assertLe(adapter.insuranceInTransitUsd(), ifOpen, "IF part <= IF confirmed and not failed");
        }
    }
}
