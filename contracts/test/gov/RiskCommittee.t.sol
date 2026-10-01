// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IRiskCommittee} from "../../src/interfaces/IRiskCommittee.sol";
import {IMarketCharter} from "../../src/interfaces/IMarketCharter.sol";
import {RiskCommittee} from "../../src/RiskCommittee.sol";

import {GovBase} from "./utils/GovBase.sol";
import {GovMockStaking, GovMockBook, GovMockBookNoFlag, GovMockMandate} from "./utils/GovMocks.sol";

contract RiskCommitteeTest is GovBase {
    address internal m4 = makeAddr("member4");

    function setUp() public override {
        super.setUp();
        _fundMember(m4);
    }

    // ------------------------------------------------------------------------------------------
    // constructor / membership views
    // ------------------------------------------------------------------------------------------

    function test_constructor_validation() public {
        vm.expectRevert(RiskCommittee.ZeroAddress.selector);
        new RiskCommittee(address(0), [m1, m2, m3]);
        vm.expectRevert(RiskCommittee.ZeroAddress.selector);
        new RiskCommittee(address(cfg), [m1, address(0), m3]);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.DuplicateMember.selector, m1));
        new RiskCommittee(address(cfg), [m1, m2, m1]);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.DuplicateMember.selector, m2));
        new RiskCommittee(address(cfg), [m1, m2, m2]);
    }

    function test_constructor_emitsMemberSet() public {
        vm.expectEmit(true, false, false, true);
        emit IRiskCommittee.MemberSet(0, m1);
        vm.expectEmit(true, false, false, true);
        emit IRiskCommittee.MemberSet(1, m2);
        vm.expectEmit(true, false, false, true);
        emit IRiskCommittee.MemberSet(2, m3);
        new RiskCommittee(address(cfg), [m1, m2, m3]);
    }

    function test_members() public view {
        address[3] memory ms = committee.members();
        assertEq(ms[0], m1);
        assertEq(ms[1], m2);
        assertEq(ms[2], m3);
        assertTrue(committee.isMember(m1));
        assertTrue(committee.isMember(m3));
        assertFalse(committee.isMember(outsider));
        assertFalse(committee.isMember(address(0)));
        assertFalse(committee.isBonded(m1), "seated but not bonded");
    }

    // ------------------------------------------------------------------------------------------
    // bond / releaseBond
    // ------------------------------------------------------------------------------------------

    function test_bond_locksCommitteeBond() public {
        vm.expectEmit(true, false, false, true, address(committee));
        emit IRiskCommittee.MemberBonded(m1, COMMITTEE_BOND);
        _bond(m1);
        assertTrue(committee.isBonded(m1));
        assertEq(committee.bondOf(m1), COMMITTEE_BOND);
        assertEq(staking.lockOf(m1, committee.BOND_LOCK_ID()), COMMITTEE_BOND);
        assertEq(staking.lockerOf(m1, committee.BOND_LOCK_ID()), address(committee));
    }

    function test_bond_nonMemberReverts() public {
        vm.prank(outsider);
        vm.expectRevert(RiskCommittee.NotMember.selector);
        committee.bond();
    }

    function test_bond_twiceReverts() public {
        _bond(m1);
        vm.prank(m1);
        vm.expectRevert(RiskCommittee.AlreadyBonded.selector);
        committee.bond();
    }

    function test_bond_insufficientStakeReverts() public {
        cfg.setCommitteeBond(2_000_000e18);
        vm.prank(m1);
        vm.expectRevert(GovMockStaking.Insufficient.selector);
        committee.bond();
    }

    function test_bond_raisedRequirementSuspendsUntilRebond() public {
        _bond(m1);
        cfg.setCommitteeBond(COMMITTEE_BOND * 2);
        assertFalse(committee.isBonded(m1));
        _bond(m1); // unlocks the old lock and re-locks the new requirement
        assertTrue(committee.isBonded(m1));
        assertEq(staking.lockOf(m1, committee.BOND_LOCK_ID()), COMMITTEE_BOND * 2);
        assertEq(staking.lockedOf(m1), COMMITTEE_BOND * 2);
    }

    function test_bond_zeroRequirement() public {
        cfg.setCommitteeBond(0);
        _bond(m1);
        assertTrue(committee.isBonded(m1));
        assertEq(staking.lockedOf(m1), 0);
        vm.prank(m1);
        vm.expectRevert(RiskCommittee.AlreadyBonded.selector);
        committee.bond();
    }

    function test_releaseBond_onlyAfterReplacement() public {
        _bond(m1);
        vm.prank(m1);
        vm.expectRevert(RiskCommittee.StillSeated.selector);
        committee.releaseBond();

        _setMember(0, m4);
        assertFalse(committee.isBonded(m1));

        vm.expectEmit(true, false, false, true, address(committee));
        emit RiskCommittee.MemberBondReleased(m1, COMMITTEE_BOND);
        vm.prank(m1);
        committee.releaseBond();
        assertEq(committee.bondOf(m1), 0);
        assertEq(staking.lockedOf(m1), 0);

        vm.prank(m1);
        vm.expectRevert(RiskCommittee.NoBond.selector);
        committee.releaseBond();
    }

    function test_releaseBond_neverBondedReverts() public {
        vm.prank(outsider);
        vm.expectRevert(RiskCommittee.NoBond.selector);
        committee.releaseBond();
    }

    function test_reseatedMemberMustRebond() public {
        _bond(m1);
        _setMember(0, m4);
        _setMember(0, m1); // back in the seat, old lock never released
        assertFalse(committee.isBonded(m1), "seat change resets bonded status");
        _bond(m1);
        assertTrue(committee.isBonded(m1));
        assertEq(staking.lockedOf(m1), COMMITTEE_BOND, "re-lock replaces, never stacks");
    }

    function test_bondStakingPinnedAcrossConfigChange() public {
        _bond(m1);
        _bond(m2);
        assertEq(committee.bondStakingOf(m1), address(staking));

        GovMockStaking staking2 = new GovMockStaking(address(cfg), address(bkrn));
        vm.prank(timelock);
        staking2.setLocker(address(committee), true);
        cfg.setStaking(address(staking2));

        // slashing and release target the staking that holds the lock
        vm.prank(timelock);
        committee.slashMember(m1, 1e18, "X");
        assertEq(staking.lockOf(m1, committee.BOND_LOCK_ID()), COMMITTEE_BOND - 1e18);
        _setMember(0, m4);
        vm.prank(m1);
        committee.releaseBond();
        assertEq(staking.lockedOf(m1), 0);

        // re-bonding migrates the lock: unlock in the old staking, lock in the new one
        _setMember(1, makeAddr("tmp"));
        _setMember(1, m2);
        bkrn.mint(m2, COMMITTEE_BOND);
        vm.startPrank(m2);
        bkrn.approve(address(staking2), COMMITTEE_BOND);
        staking2.stake(COMMITTEE_BOND);
        committee.bond();
        vm.stopPrank();
        assertEq(staking.lockedOf(m2), 0);
        assertEq(staking2.lockOf(m2, committee.BOND_LOCK_ID()), COMMITTEE_BOND);
        assertEq(committee.bondStakingOf(m2), address(staking2));
    }

    // ------------------------------------------------------------------------------------------
    // setMember / slashMember (timelock)
    // ------------------------------------------------------------------------------------------

    function test_setMember_onlyTimelock() public {
        vm.prank(m1);
        vm.expectRevert(RiskCommittee.NotTimelock.selector);
        committee.setMember(0, m4);
    }

    function test_setMember_validation() public {
        vm.startPrank(timelock);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.BadSeat.selector, uint8(3)));
        committee.setMember(3, m4);
        vm.expectRevert(RiskCommittee.ZeroAddress.selector);
        committee.setMember(0, address(0));
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.DuplicateMember.selector, m2));
        committee.setMember(0, m2);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.DuplicateMember.selector, m1));
        committee.setMember(0, m1);
        vm.stopPrank();
    }

    function test_setMember_replacesSeat() public {
        _bondAll();
        vm.expectEmit(true, false, false, true, address(committee));
        emit IRiskCommittee.MemberSet(1, m4);
        _setMember(1, m4);
        assertEq(committee.members()[1], m4);
        assertFalse(committee.isMember(m2));
        assertFalse(committee.isBonded(m2));
        assertFalse(committee.isBonded(m4), "newcomer must bond");
        assertTrue(committee.isBonded(m1));
    }

    function test_slashMember_onlyTimelock() public {
        _bond(m1);
        vm.prank(m2);
        vm.expectRevert(RiskCommittee.NotTimelock.selector);
        committee.slashMember(m1, 1, "X");
    }

    function test_slashMember_amountBounds() public {
        _bond(m1);
        vm.startPrank(timelock);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.BadSlashAmount.selector, 0, COMMITTEE_BOND));
        committee.slashMember(m1, 0, "X");
        vm.expectRevert(
            abi.encodeWithSelector(RiskCommittee.BadSlashAmount.selector, COMMITTEE_BOND + 1, COMMITTEE_BOND)
        );
        committee.slashMember(m1, COMMITTEE_BOND + 1, "X");
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.BadSlashAmount.selector, 1, 0));
        committee.slashMember(m2, 1, "X");
        vm.stopPrank();
    }

    function test_slashMember_partialSuspendsVotingUntilRebond() public {
        _bond(m1);
        vm.expectEmit(true, false, false, true, address(committee));
        emit IRiskCommittee.MemberSlashed(m1, 1000e18, "NEGLIGENCE");
        vm.prank(timelock);
        committee.slashMember(m1, 1000e18, "NEGLIGENCE");

        assertEq(bkrn.balanceOf(slashRecipient), 1000e18);
        assertEq(committee.bondOf(m1), COMMITTEE_BOND - 1000e18);
        assertFalse(committee.isBonded(m1));

        uint256 id = _file();
        vm.prank(m1);
        vm.expectRevert(RiskCommittee.NotBondedMember.selector);
        committee.vote(id, true);

        _bond(m1);
        assertTrue(committee.isBonded(m1));
        assertEq(staking.lockOf(m1, committee.BOND_LOCK_ID()), COMMITTEE_BOND);
    }

    function test_slashMember_formerMemberBeforeRelease() public {
        _bond(m1);
        _setMember(0, m4);
        vm.prank(timelock);
        committee.slashMember(m1, COMMITTEE_BOND, "CAUSE");
        assertEq(committee.bondOf(m1), 0);
        vm.prank(m1);
        vm.expectRevert(RiskCommittee.NoBond.selector);
        committee.releaseBond();
    }

    // ------------------------------------------------------------------------------------------
    // postJuryVerdict
    // ------------------------------------------------------------------------------------------

    function test_postJury_onlyJuryRole() public {
        uint256 id = _file();
        vm.prank(outsider);
        vm.expectRevert(RiskCommittee.NotJury.selector);
        committee.postJuryVerdict(id, CID, true);
        vm.prank(m1);
        vm.expectRevert(RiskCommittee.NotJury.selector);
        committee.postJuryVerdict(id, CID, true);
    }

    function test_postJury_recordsOnce() public {
        uint256 id = _file();
        vm.expectEmit(true, false, false, true, address(committee));
        emit IRiskCommittee.JuryVerdictPosted(id, CID, false);
        _postJury(id, false);
        (bytes32 cid, bool rec, bool posted) = committee.juryVerdict(id);
        assertEq(cid, CID);
        assertFalse(rec);
        assertTrue(posted);

        vm.prank(jury);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.JuryAlreadyPosted.selector, id));
        committee.postJuryVerdict(id, keccak256("other"), true);
    }

    function test_postJury_zeroCidReverts() public {
        uint256 id = _file();
        vm.prank(jury);
        vm.expectRevert(RiskCommittee.BadCid.selector);
        committee.postJuryVerdict(id, bytes32(0), true);
    }

    function test_postJury_requiresOpenCharter() public {
        vm.prank(jury);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.CharterNotOpen.selector, 9));
        committee.postJuryVerdict(9, CID, true);

        uint256 id = _file();
        vm.warp(block.timestamp + WINDOW);
        vm.prank(jury);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.CharterNotOpen.selector, id));
        committee.postJuryVerdict(id, CID, true);
    }

    // ------------------------------------------------------------------------------------------
    // vote / thresholds
    // ------------------------------------------------------------------------------------------

    function test_vote_requiresBondedSeat() public {
        uint256 id = _file();
        vm.prank(m1);
        vm.expectRevert(RiskCommittee.NotBondedMember.selector);
        committee.vote(id, true);
        vm.prank(outsider);
        vm.expectRevert(RiskCommittee.NotBondedMember.selector);
        committee.vote(id, true);
    }

    function test_vote_once() public {
        _bondAll();
        uint256 id = _file();
        vm.expectEmit(true, true, false, true, address(committee));
        emit IRiskCommittee.Voted(id, m1, true);
        _vote(m1, id, true);
        assertTrue(committee.hasVoted(id, m1));
        assertFalse(committee.hasVoted(id, m2));
        vm.prank(m1);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.AlreadyVoted.selector, id, m1));
        committee.vote(id, false);
    }

    function test_vote_requiresOpenCharter() public {
        _bondAll();
        vm.prank(m1);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.CharterNotOpen.selector, 5));
        committee.vote(5, true);

        uint256 id = _file();
        vm.warp(block.timestamp + WINDOW);
        vm.prank(m1);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.CharterNotOpen.selector, id));
        committee.vote(id, true);
    }

    function test_vote_afterFinalizeReverts() public {
        _bondAll();
        uint256 id = _fileAndApprove(_charter());
        vm.prank(m3);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.CharterNotOpen.selector, id));
        committee.vote(id, true);
    }

    function test_threshold_juryApprove_twoApprovals() public {
        _bondAll();
        uint256 id = _file();
        _postJury(id, true);
        _vote(m1, id, true);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Filed), "1 approval is not enough");

        vm.expectEmit(true, false, false, true, address(committee));
        emit IRiskCommittee.Decided(id, true);
        _vote(m2, id, true);

        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Approved));
        assertTrue(committee.isFinalized(id));
        assertEq(charter.get(id).juryCid, CID);
        assertTrue(factory.bookOf(id) != address(0));
        (uint8 a, uint8 r) = committee.votesOf(id);
        assertEq(a, 2);
        assertEq(r, 0);
    }

    function test_threshold_approvalImpossibleBeforeVerdict() public {
        _bondAll();
        uint256 id = _file();
        _vote(m1, id, true);
        _vote(m2, id, true);
        _vote(m3, id, true);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Filed), "3 approvals without verdict");
        assertFalse(committee.tryFinalize(id));

        _postJury(id, true);
        assertTrue(committee.tryFinalize(id));
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Approved));
        assertFalse(committee.tryFinalize(id), "idempotent");
    }

    function test_threshold_juryRejectRequiresThreeOfThree() public {
        _bondAll();
        uint256 id = _file();
        _postJury(id, false);
        _vote(m1, id, true);
        _vote(m2, id, true);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Filed), "2 approvals vs jury reject");
        assertFalse(committee.tryFinalize(id));
        _vote(m3, id, true);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Approved));
    }

    function test_threshold_juryRejectSplitVoteExpires() public {
        _bondAll();
        uint256 id = _file();
        _postJury(id, false);
        _vote(m1, id, true);
        _vote(m2, id, true);
        _vote(m3, id, false);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Filed));
        vm.warp(block.timestamp + WINDOW);
        assertFalse(committee.tryFinalize(id));
        charter.expire(id);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Expired));
    }

    function test_threshold_twoRejectionsReject_noVerdictNeeded() public {
        _bondAll();
        uint256 before = usdc.balanceOf(sponsor);
        uint256 id = _file();
        _vote(m1, id, false);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Filed));
        _vote(m2, id, false);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Rejected));
        assertEq(charter.get(id).juryCid, bytes32(0));
        assertEq(usdc.balanceOf(sponsor), before, "refunded");
        assertEq(staking.lockedOf(sponsor), 0, "unlocked");
    }

    function test_threshold_rejectEvenWithJuryApprove() public {
        _bondAll();
        uint256 id = _file();
        _postJury(id, true);
        _vote(m1, id, true);
        _vote(m2, id, false);
        _vote(m3, id, false);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Rejected));
        assertEq(charter.get(id).juryCid, CID);
    }

    function test_threshold_mixedThenApprove() public {
        _bondAll();
        uint256 id = _file();
        _postJury(id, true);
        _vote(m1, id, false);
        _vote(m2, id, true);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Filed));
        _vote(m3, id, true);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Approved));
    }

    function test_paused_approvalDeferredUntilUnpause() public {
        _bondAll();
        uint256 id = _file();
        _postJury(id, true);
        cfg.setNewBooksPaused(true);
        _vote(m1, id, true);
        _vote(m2, id, true); // threshold met; vote is recorded but approval deferred
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Filed));
        assertFalse(committee.isFinalized(id));
        assertFalse(committee.tryFinalize(id));

        cfg.setNewBooksPaused(false);
        assertTrue(committee.tryFinalize(id));
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Approved));
    }

    function test_paused_rejectionStillFinalizes() public {
        _bondAll();
        uint256 id = _file();
        cfg.setNewBooksPaused(true);
        _vote(m1, id, false);
        _vote(m2, id, false);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Rejected));
    }

    function test_tryFinalize_unknownOrClosedReturnsFalse() public {
        assertFalse(committee.tryFinalize(77));
        uint256 id = _file();
        assertFalse(committee.tryFinalize(id));
    }

    // ------------------------------------------------------------------------------------------
    // replaced members
    // ------------------------------------------------------------------------------------------

    function test_replacedMemberVotesNoLongerCount() public {
        _bondAll();
        uint256 id = _file();
        _postJury(id, true);
        _vote(m1, id, true);
        (uint8 a,) = committee.votesOf(id);
        assertEq(a, 1);

        _setMember(0, m4);
        (a,) = committee.votesOf(id);
        assertEq(a, 0, "replaced member's approval dropped");
        assertTrue(committee.hasVoted(id, m1), "ballot kept per address");

        _vote(m2, id, true);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Filed), "only 1 counting approval");

        vm.prank(m1);
        vm.expectRevert(RiskCommittee.NotBondedMember.selector);
        committee.vote(id, true);

        vm.prank(m4);
        vm.expectRevert(RiskCommittee.NotBondedMember.selector);
        committee.vote(id, true);

        _bond(m4);
        _vote(m4, id, true);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Approved));
    }

    function test_replacedMemberRejectionsNoLongerCount() public {
        _bondAll();
        uint256 id = _file();
        _vote(m1, id, false);
        _setMember(0, m4);
        _vote(m2, id, false);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Filed));
        (, uint8 r) = committee.votesOf(id);
        assertEq(r, 1);
    }

    /// @notice Fuzz the decision rule over every ballot pattern, order and jury state.
    function testFuzz_decisionRule(uint8 pattern, uint8 order, bool posted, bool recommendApprove) public {
        _bondAll();
        uint256 id = _file();
        if (posted) _postJury(id, recommendApprove);

        address[3] memory ms = [m1, m2, m3];
        uint8[3] memory perm = _perm(order % 6);
        uint8 approvals;
        uint8 rejections;
        bool done;
        bool approvedExpected;
        for (uint256 i; i < 3; ++i) {
            uint256 pow = perm[i] == 0 ? 1 : perm[i] == 1 ? 3 : 9;
            uint256 ballot = (uint256(pattern) / pow) % 3; // member's base-3 digit: 0 none, 1 approve, 2 reject
            if (ballot == 0) continue;
            address m = ms[perm[i]];
            if (done) {
                vm.prank(m);
                vm.expectRevert(abi.encodeWithSelector(RiskCommittee.CharterNotOpen.selector, id));
                committee.vote(id, ballot == 1);
                continue;
            }
            _vote(m, id, ballot == 1);
            if (ballot == 1) ++approvals;
            else ++rejections;
            if (rejections >= 2) {
                done = true;
                approvedExpected = false;
            } else if (posted && approvals >= (recommendApprove ? 2 : 3)) {
                done = true;
                approvedExpected = true;
            }
        }

        BRTypes.CharterStatus s = _status(id);
        if (!done) {
            assertEq(uint8(s), uint8(BRTypes.CharterStatus.Filed));
        } else if (approvedExpected) {
            assertEq(uint8(s), uint8(BRTypes.CharterStatus.Approved));
        } else {
            assertEq(uint8(s), uint8(BRTypes.CharterStatus.Rejected));
        }
        assertEq(committee.isFinalized(id), done);
    }

    function _perm(uint8 k) internal pure returns (uint8[3] memory p) {
        if (k == 0) p = [0, 1, 2];
        else if (k == 1) p = [0, 2, 1];
        else if (k == 2) p = [1, 0, 2];
        else if (k == 3) p = [1, 2, 0];
        else if (k == 4) p = [2, 0, 1];
        else p = [2, 1, 0];
    }

    // ------------------------------------------------------------------------------------------
    // live-book actions
    // ------------------------------------------------------------------------------------------

    function _liveBook() internal returns (uint256 id, GovMockBook book) {
        _bondAll();
        id = _fileAndApprove(_charter());
        book = _book(id);
        book.setState(BRTypes.BookState.Live);
    }

    function _newMandate() internal pure returns (BRTypes.Mandate memory m) {
        m = _mandate();
        m.maxInventoryUsd = 25_000e6;
        m.minQuoteWidthBps = 20;
        m.killAtDrawdownBps = -500;
    }

    function _propose(address m, uint256 bookId, bytes32 kind, bytes memory data) internal returns (uint256) {
        vm.prank(m);
        return committee.proposeAction(bookId, kind, data);
    }

    function _approveAction(address m, uint256 actionId) internal {
        vm.prank(m);
        committee.approveAction(actionId);
    }

    function test_action_remandate() public {
        (uint256 id,) = _liveBook();
        BRTypes.Mandate memory nm = _newMandate();
        bytes32 kind = committee.REMANDATE();

        vm.expectEmit(true, true, false, true, address(committee));
        emit IRiskCommittee.ActionProposed(1, id, kind, m1);
        uint256 actionId = _propose(m1, id, kind, abi.encode(nm));
        assertEq(actionId, 1);
        assertEq(committee.actionCount(), 1);
        assertEq(committee.actionApprovals(actionId), 1, "proposer approves");
        assertTrue(committee.hasApprovedAction(actionId, m1));

        GovMockMandate mandate = GovMockMandate(factory.componentsOf(id).mandate);
        assertEq(mandate.remandateCount(), 0);

        vm.expectEmit(true, false, false, true, address(committee));
        emit IRiskCommittee.ActionExecuted(actionId);
        _approveAction(m2, actionId);

        assertEq(mandate.remandateCount(), 1);
        assertEq(keccak256(abi.encode(mandate.getMandate())), keccak256(abi.encode(nm)));
        assertTrue(committee.getAction(actionId).executed);

        vm.prank(m3);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.ActionAlreadyExecuted.selector, actionId));
        committee.approveAction(actionId);
    }

    function test_action_retire() public {
        (uint256 id, GovMockBook book) = _liveBook();
        bytes32 kind = committee.RETIRE();
        uint256 actionId = _propose(m2, id, kind, "");
        _approveAction(m3, actionId);
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Retiring));
    }

    function test_action_slashSponsor_defaultAndCustomReason() public {
        (uint256 id, GovMockBook book) = _liveBook();
        book.setSponsorAbandoned(true);
        bytes32 kind = committee.SLASH_SPONSOR();
        uint256 actionId = _propose(m1, id, kind, "");
        vm.expectEmit(true, true, false, true, address(charter));
        emit IMarketCharter.SponsorSlashed(id, sponsor, SPONSOR_BOND, kind);
        _approveAction(m3, actionId);
        assertEq(bkrn.balanceOf(slashRecipient), SPONSOR_BOND);

        // custom reason (second book)
        uint256 id2 = _fileAndApprove(_charter());
        GovMockBook book2 = _book(id2);
        book2.setSponsorAbandoned(true);
        uint256 actionId2 = _propose(m1, id2, kind, abi.encode(bytes32("SKIN_BELOW_10PCT")));
        vm.expectEmit(true, true, false, true, address(charter));
        emit IMarketCharter.SponsorSlashed(id2, sponsor, SPONSOR_BOND, "SKIN_BELOW_10PCT");
        _approveAction(m2, actionId2);
    }

    function test_action_revokeKey() public {
        (uint256 id,) = _liveBook();
        address key = makeAddr("desk key");
        bytes32 kind = committee.REVOKE_KEY();
        uint256 actionId = _propose(m3, id, kind, abi.encode(key));
        _approveAction(m1, actionId);
        GovMockMandate mandate = GovMockMandate(factory.componentsOf(id).mandate);
        assertEq(mandate.lastRevokedKey(), key);
        assertEq(mandate.lastRevokeReason(), committee.COMMITTEE_REASON());
    }

    function test_action_proposeValidation() public {
        (uint256 id,) = _liveBook();
        bytes32 remandate = committee.REMANDATE();
        bytes32 retire = committee.RETIRE();
        bytes32 slash = committee.SLASH_SPONSOR();
        bytes32 revoke = committee.REVOKE_KEY();

        vm.prank(outsider);
        vm.expectRevert(RiskCommittee.NotBondedMember.selector);
        committee.proposeAction(id, retire, "");

        vm.startPrank(m1);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.UnknownBook.selector, 99));
        committee.proposeAction(99, retire, "");

        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.UnknownActionKind.selector, bytes32("PAUSE")));
        committee.proposeAction(id, "PAUSE", "");

        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.BadActionData.selector, remandate));
        committee.proposeAction(id, remandate, abi.encode(uint256(1)));

        BRTypes.Mandate memory bad = _newMandate();
        bad.killAtDrawdownBps = 0;
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.InvalidMandate.selector, bytes32("BAD_MANDATE")));
        committee.proposeAction(id, remandate, abi.encode(bad));

        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.BadActionData.selector, retire));
        committee.proposeAction(id, retire, abi.encode(uint256(1)));

        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.BadActionData.selector, slash));
        committee.proposeAction(id, slash, abi.encode(uint256(1), uint256(2)));

        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.BadActionData.selector, revoke));
        committee.proposeAction(id, revoke, "");

        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.BadActionData.selector, revoke));
        committee.proposeAction(id, revoke, abi.encode(address(0)));

        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.BadActionData.selector, revoke));
        committee.proposeAction(id, revoke, abi.encode(type(uint256).max));
        vm.stopPrank();
    }

    function test_action_approveValidation() public {
        (uint256 id,) = _liveBook();
        bytes32 retire = committee.RETIRE();

        vm.prank(m1);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.UnknownAction.selector, 1));
        committee.approveAction(1);

        uint256 actionId = _propose(m1, id, retire, "");

        vm.prank(m1);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.AlreadyApproved.selector, actionId, m1));
        committee.approveAction(actionId);

        vm.prank(outsider);
        vm.expectRevert(RiskCommittee.NotBondedMember.selector);
        committee.approveAction(actionId);

        vm.warp(block.timestamp + WINDOW);
        vm.prank(m2);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.ActionExpired.selector, actionId));
        committee.approveAction(actionId);
    }

    function test_action_replacedProposerApprovalDropped() public {
        (uint256 id, GovMockBook book) = _liveBook();
        bytes32 retire = committee.RETIRE();
        uint256 actionId = _propose(m1, id, retire, "");
        _setMember(0, m4);
        assertEq(committee.actionApprovals(actionId), 0);

        _approveAction(m2, actionId);
        assertFalse(committee.getAction(actionId).executed, "m1's approval no longer counts");
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));

        _bond(m4);
        _approveAction(m4, actionId);
        assertTrue(committee.getAction(actionId).executed);
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Retiring));
    }

    function test_action_failedExecutionRevertsApproval() public {
        (uint256 id, GovMockBook book) = _liveBook();
        book.setState(BRTypes.BookState.Subscription); // book.retire() will revert NotLive
        bytes32 retire = committee.RETIRE();
        uint256 actionId = _propose(m1, id, retire, "");
        vm.prank(m2);
        vm.expectRevert(GovMockBookNoFlag.NotLive.selector);
        committee.approveAction(actionId);
        assertFalse(committee.hasApprovedAction(actionId, m2));
        assertFalse(committee.getAction(actionId).executed);

        book.setState(BRTypes.BookState.Live);
        _approveAction(m2, actionId);
        assertTrue(committee.getAction(actionId).executed);
    }

    function test_action_onlyCommitteeContractReachesCharterActions() public {
        (uint256 id, GovMockBook book) = _liveBook();
        book.setSponsorAbandoned(true);
        // members cannot bypass the 2-of-3 by calling MarketCharter directly
        vm.prank(m1);
        vm.expectRevert();
        charter.slashSponsor(id, "X");
    }
}
