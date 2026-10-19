// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {MarketCharter} from "../../../src/MarketCharter.sol";
import {RiskCommittee} from "../../../src/RiskCommittee.sol";
import {GovBase} from "../../gov/utils/GovBase.sol";

/// @notice Audit 2026-10, privileged operations (D):
///         - committee state keyed only by charter id: repointing config.charter() reused the old verdicts and
///           ballots for the new charter contract's ids;
///         - charter deadline read live: a committeeWindow change retroactively expired or revived charters.
contract DPrivilegedGovTest is GovBase {
    MarketCharter internal charter2;

    function setUp() public override {
        super.setUp();
        _bondAll();
        charter2 = new MarketCharter(address(cfg));
        vm.prank(timelock);
        staking.setLocker(address(charter2), true);
    }

    /// @dev Timelock repoints config.charter() to a new MarketCharter (redeploy), whose ids restart at 1.
    function _repointCharter() internal {
        cfg.setCharter(address(charter2));
    }

    function _file2() internal returns (uint256 id) {
        vm.prank(sponsor);
        usdc.approve(address(charter2), type(uint256).max);
        vm.prank(sponsor);
        id = charter2.file(_charter());
    }

    // ------------------------------------------------------------------ committee keyed by charter address

    /// @dev PoC: charter #1 on the old MarketCharter got the jury verdict and one approval. After the repoint, the
    ///      new contract's charter #1 inherited both: one more approval approved it, with the old charter's jury CID
    ///      and a ballot nobody cast on it.
    function test_D_poc_repointedCharter_doesNotReuseVerdictOrBallots() public {
        uint256 id = _file();
        _postJury(id, true);
        _vote(m1, id, true);

        _repointCharter();
        uint256 id2 = _file2();
        assertEq(id2, id, "same id on the new charter contract");

        (,, bool posted) = committee.juryVerdict(id2);
        assertFalse(posted, "no verdict for the new charter yet");
        assertFalse(committee.hasVoted(id2, m1), "m1 has not voted on the new charter");
        (uint8 approvals,) = committee.votesOf(id2);
        assertEq(approvals, 0, "old ballots do not count");

        _vote(m2, id2, true); // one approval on the new charter
        assertEq(uint8(charter2.get(id2).status), uint8(BRTypes.CharterStatus.Filed), "not approved by one ballot");

        _postJury(id2, true); // the new charter's own verdict can be posted
        _vote(m1, id2, true);
        assertEq(uint8(charter2.get(id2).status), uint8(BRTypes.CharterStatus.Approved));
        assertEq(charter2.get(id2).juryCid, CID);
    }

    /// @dev A charter id finalized on the old contract must not block the same id on the new one. (Approving it
    ///      would still need a fresh BookFactory: the factory keys books by id, BookExists; see the register.)
    function test_D_finalizedOnOldCharter_doesNotCloseNewId() public {
        uint256 id = _fileAndApprove(_charter());
        assertTrue(committee.isFinalized(id));
        _repointCharter();
        uint256 id2 = _file2();
        assertFalse(committee.isFinalized(id2), "finalized flag belongs to the old charter");
        _postJury(id2, false);
        _vote(m1, id2, false);
        _vote(m2, id2, false);
        assertEq(uint8(charter2.get(id2).status), uint8(BRTypes.CharterStatus.Rejected));
        assertTrue(committee.isFinalized(id2));
    }

    /// @dev A live-book action proposed against the old charter contract's book ids cannot execute after a
    ///      repoint (it would act on whatever the new charter maps that id to).
    function test_D_actionProposedBeforeRepoint_cannotExecuteAfter() public {
        uint256 id = _fileAndApprove(_charter());
        bytes32 retireKind = committee.RETIRE();
        vm.prank(m1);
        uint256 actionId = committee.proposeAction(id, retireKind, "");
        _repointCharter();
        vm.expectRevert(abi.encodeWithSignature("CharterChanged(uint256)", actionId));
        vm.prank(m2);
        committee.approveAction(actionId);
    }

    // ------------------------------------------------------------------ charter deadline stored at filing

    /// @dev PoC: shortening the window after filing expired a charter retroactively.
    function test_D_poc_windowShortened_doesNotExpireFiledCharter() public {
        uint256 id = _file();
        uint256 deadline = block.timestamp + WINDOW;
        assertEq(charter.decisionDeadline(id), deadline);
        cfg.setCommitteeWindow(1 days);
        vm.warp(block.timestamp + 1 days + 1);

        assertEq(charter.decisionDeadline(id), deadline, "deadline fixed at filing");
        assertTrue(charter.isOpen(id));
        vm.expectRevert(abi.encodeWithSelector(MarketCharter.DecisionWindowOpen.selector, id, deadline));
        charter.expire(id);

        _postJury(id, true);
        _vote(m1, id, true);
        _vote(m2, id, true);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Approved), "still decidable in its own window");
    }

    /// @dev PoC: lengthening the window after expiry revived a charter the sponsor could already refund.
    function test_D_poc_windowLengthened_doesNotReviveCharter() public {
        uint256 id = _file();
        uint256 deadline = block.timestamp + WINDOW;
        vm.warp(deadline);
        cfg.setCommitteeWindow(WINDOW * 3);

        assertFalse(charter.isOpen(id), "expired at its own deadline");
        vm.prank(jury);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.CharterNotOpen.selector, id));
        committee.postJuryVerdict(id, CID, true);
        vm.prank(m1);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.CharterNotOpen.selector, id));
        committee.vote(id, true);

        charter.expire(id);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Expired));
    }

    function test_D_decide_usesStoredDeadline() public {
        uint256 id = _file();
        uint256 deadline = block.timestamp + WINDOW;
        cfg.setCommitteeWindow(WINDOW * 3);
        vm.warp(deadline);
        vm.prank(address(committee));
        vm.expectRevert(abi.encodeWithSelector(MarketCharter.DecisionWindowClosed.selector, id, deadline));
        charter.decide(id, false, bytes32(0));
    }
}
