// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {RiskCommittee} from "../../../src/RiskCommittee.sol";

import {GovBase} from "../../gov/utils/GovBase.sol";
import {GovMockBook} from "../../gov/utils/GovMocks.sol";

/// @notice AREA 4 audit PoCs — RiskCommittee. Each test asserts the SECURE behaviour and fails on the
///         current code.
contract Area4CommitteeTest is GovBase {
    function _liveBook() internal returns (uint256 id, GovMockBook book) {
        _bondAll();
        id = _fileAndApprove(_charter());
        book = _book(id);
        book.setState(BRTypes.BookState.Live);
    }

    // ------------------------------------------------------------------------------------------
    // A4-01: ballots / action approvals of seated-but-UNBONDED members keep counting
    // ------------------------------------------------------------------------------------------

    /// @notice m1 approves, is then slashed for cause by the timelock (below committeeBondBkrn, so
    ///         isBonded(m1) == false, "can no longer vote"), yet its earlier ballot is still counted by
    ///         votesOf(): a single bonded approval (m2) approves the charter and deploys a book.
    function test_audit_unbondedBallotCountsForCharterApproval() public {
        _bondAll();
        uint256 id = _file();
        _vote(m1, id, true);

        vm.prank(timelock);
        committee.slashMember(m1, COMMITTEE_BOND, "CAUSE");
        assertFalse(committee.isBonded(m1), "m1 is no longer bonded");

        _postJury(id, true);
        _vote(m2, id, true); // only ONE bonded approval

        assertEq(
            uint8(_status(id)),
            uint8(BRTypes.CharterStatus.Filed),
            "charter approved with only one bonded member (unbonded ballot counted)"
        );
    }

    /// @notice Same root cause on live-book actions: m1 proposes RETIRE, is slashed below the bond, and
    ///         one bonded approval (m2) executes it.
    function test_audit_unbondedProposerApprovalExecutesAction() public {
        (uint256 id, GovMockBook book) = _liveBook();
        bytes32 retire = committee.RETIRE();
        vm.prank(m1);
        uint256 actionId = committee.proposeAction(id, retire, "");

        vm.prank(timelock);
        committee.slashMember(m1, COMMITTEE_BOND, "CAUSE");
        assertFalse(committee.isBonded(m1));

        vm.prank(m2);
        committee.approveAction(actionId);

        assertFalse(committee.getAction(actionId).executed, "action executed with one bonded approval");
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));
    }

    // ------------------------------------------------------------------------------------------
    // A4-02: action expiry is re-derived from the LIVE committeeWindow -> expired actions revive
    // ------------------------------------------------------------------------------------------

    /// @notice An action that expired (approveAction reverted ActionExpired) becomes executable again
    ///         with one fresh approval as soon as the timelock lengthens committeeWindow (a parameter for
    ///         charter review), executing a stale RETIRE proposal from a past window.
    function test_audit_expiredActionRevivedByWindowChange() public {
        (uint256 id, GovMockBook book) = _liveBook();
        bytes32 retire = committee.RETIRE();
        vm.prank(m1);
        uint256 actionId = committee.proposeAction(id, retire, "");

        vm.warp(block.timestamp + WINDOW + 1 days);
        vm.prank(m2);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.ActionExpired.selector, actionId));
        committee.approveAction(actionId);

        // timelock lengthens the review window (e.g. 48h -> 14d) for unrelated reasons
        cfg.setCommitteeWindow(14 days);

        vm.prank(m2);
        try committee.approveAction(actionId) {} catch {}
        assertFalse(committee.getAction(actionId).executed, "expired action executed after window change");
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));
    }
}
