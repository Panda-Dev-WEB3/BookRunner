// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IMarketCharter} from "../../src/interfaces/IMarketCharter.sol";
import {RiskCommittee} from "../../src/RiskCommittee.sol";

import {GovBase} from "./utils/GovBase.sol";
import {GovMockBook, GovMockMandate, GovMockAdapter} from "./utils/GovMocks.sol";

/// @notice End-to-end charter lifecycle (ARCHITECTURE.md §3.1, §3.4, §3.6) through all three gov
///         contracts with mocked book components.
contract GovLifecycleTest is GovBase {
    function setUp() public override {
        super.setUp();
        _bondAll();
    }

    function test_lifecycle_fileJuryVotesApproveCreateRemandateRetire() public {
        uint256 sponsorUsdc0 = usdc.balanceOf(sponsor);
        BRTypes.Charter memory c = _charter();

        // 1. sponsor files: fee escrowed, bond locked
        uint256 id = _file(c);
        assertEq(usdc.balanceOf(address(charter)), FEE);
        assertEq(staking.lockedOf(sponsor), SPONSOR_BOND);

        // 2. jury verdict, 3. committee 2-of-3
        vm.warp(block.timestamp + 6 hours);
        _postJury(id, true);
        _vote(m3, id, true);
        _vote(m1, id, true);

        // 4. approved -> fee forwarded, factory created and wired the book
        IMarketCharter.CharterRecord memory r = charter.get(id);
        assertEq(uint8(r.status), uint8(BRTypes.CharterStatus.Approved));
        assertEq(r.juryCid, CID);
        assertEq(usdc.balanceOf(expenseRecipient), FEE);
        assertEq(usdc.balanceOf(sponsor), sponsorUsdc0 - FEE);
        BRTypes.BookComponents memory comps = factory.componentsOf(id);
        assertEq(comps.book, r.book);
        assertTrue(factory.isComponent(comps.adapter));
        assertEq(GovMockAdapter(comps.adapter).symbol(), c.symbol);
        assertTrue(staking.isLocker(comps.mandate));

        // window closes, book goes live (Book cluster) — simulated
        GovMockBook book = GovMockBook(comps.book);
        book.setState(BRTypes.BookState.Live);

        // 5. breach -> committee re-mandates (2-of-3) and revokes a key
        BRTypes.Mandate memory nm = c.mandate;
        nm.maxInventoryUsd = 20_000e6;
        bytes32 remandate = committee.REMANDATE();
        vm.prank(m2);
        uint256 a1 = committee.proposeAction(id, remandate, abi.encode(nm));
        vm.prank(m3);
        committee.approveAction(a1);
        assertEq(GovMockMandate(comps.mandate).getMandate().maxInventoryUsd, 20_000e6);

        address key = makeAddr("rogue key");
        bytes32 revokeKey = committee.REVOKE_KEY();
        vm.prank(m1);
        uint256 a2 = committee.proposeAction(id, revokeKey, abi.encode(key));
        vm.prank(m2);
        committee.approveAction(a2);
        assertEq(GovMockMandate(comps.mandate).lastRevokedKey(), key);

        // 6. sponsor retires; book winds down and reports Retired -> bond released
        vm.prank(sponsor);
        charter.retire(id);
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Retiring));
        assertEq(staking.lockedOf(sponsor), SPONSOR_BOND, "bond held until Retired");
        book.finalize();
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Retired));
        assertEq(staking.lockedOf(sponsor), 0);
        assertEq(staking.stakedOf(sponsor), 1_000_000e18, "nothing slashed");
    }

    function test_lifecycle_rejectRefundsFeeAndBond() public {
        uint256 sponsorUsdc0 = usdc.balanceOf(sponsor);
        uint256 id = _file();
        _postJury(id, false);
        _vote(m1, id, false);
        _vote(m2, id, false);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Rejected));
        assertEq(usdc.balanceOf(sponsor), sponsorUsdc0);
        assertEq(usdc.balanceOf(address(charter)), 0);
        assertEq(usdc.balanceOf(expenseRecipient), 0);
        assertEq(staking.lockedOf(sponsor), 0);
        assertEq(factory.bookCount(), 0);
    }

    function test_lifecycle_expiresAfter48h() public {
        uint256 sponsorUsdc0 = usdc.balanceOf(sponsor);
        uint256 id = _file();
        _postJury(id, true);
        _vote(m1, id, true);

        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert();
        charter.expire(id);

        vm.warp(block.timestamp + 1);
        vm.prank(m2);
        vm.expectRevert(abi.encodeWithSelector(RiskCommittee.CharterNotOpen.selector, id));
        committee.vote(id, true);
        assertFalse(committee.tryFinalize(id));

        charter.expire(id);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Expired));
        assertEq(usdc.balanceOf(sponsor), sponsorUsdc0);
        assertEq(staking.lockedOf(sponsor), 0);
        assertEq(factory.bookCount(), 0);
    }

    function test_lifecycle_juryRejectRequiresUnanimity() public {
        uint256 id = _file(_engineCharter());
        _postJury(id, false);
        _vote(m1, id, true);
        _vote(m2, id, true);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Filed));
        _vote(m3, id, true);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Approved));
        BRTypes.BookComponents memory comps = factory.componentsOf(id);
        assertEq(GovMockAdapter(comps.adapter).book(), comps.book);
        assertEq(GovMockAdapter(comps.adapter).venueKind(), BRTypes.VENUE_POOL_ENGINE);
    }

    function test_lifecycle_pausedNewBooks() public {
        uint256 id = _file();
        _postJury(id, true);

        cfg.setNewBooksPaused(true); // guardian kill-switch
        BRTypes.Charter memory c = _charter();
        vm.prank(sponsor);
        vm.expectRevert(IMarketCharter.NewBooksPaused.selector);
        charter.file(c);

        _vote(m1, id, true);
        _vote(m2, id, true);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Filed), "no new book while paused");
        assertEq(factory.bookCount(), 0);

        cfg.setNewBooksPaused(false);
        assertTrue(committee.tryFinalize(id));
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Approved));
        assertEq(factory.bookCount(), 1);
    }

    function test_lifecycle_cancelledWindowReleasesBond() public {
        uint256 id = _fileAndApprove(_charter());
        GovMockBook book = _book(id);
        book.setState(BRTypes.BookState.Cancelled); // closeWindow failed (e.g. SPONSOR_SKIN)
        charter.closeCancelled(id);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Retired));
        assertEq(staking.lockedOf(sponsor), 0);
    }

    function test_lifecycle_abandonedSponsorSlashedByCommittee() public {
        uint256 id = _fileAndApprove(_charter());
        GovMockBook book = _book(id);
        book.setState(BRTypes.BookState.Live);
        book.setSponsorAbandoned(true); // sponsor redeemed below 10% of Junior

        bytes32 slashKind = committee.SLASH_SPONSOR();
        vm.prank(m1);
        uint256 a = committee.proposeAction(id, slashKind, "");
        vm.prank(m3);
        committee.approveAction(a);

        assertEq(bkrn.balanceOf(slashRecipient), SPONSOR_BOND);
        assertEq(staking.stakedOf(sponsor), 1_000_000e18 - SPONSOR_BOND);
        assertEq(charter.bondOutstanding(id), 0);

        // committee then retires the book
        bytes32 retireKind = committee.RETIRE();
        vm.prank(m2);
        uint256 b = committee.proposeAction(id, retireKind, "");
        vm.prank(m1);
        committee.approveAction(b);
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Retiring));
        book.finalize();
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Retired));
    }

    function test_lifecycle_memberRotationMidReview() public {
        address m4 = makeAddr("member4");
        _fundMember(m4);
        uint256 id = _file();
        _postJury(id, true);
        _vote(m1, id, true);

        // timelock rotates m1 out (slash-then-replace batch) before the charter is decided
        vm.startPrank(timelock);
        committee.slashMember(m1, COMMITTEE_BOND / 10, "CONFLICT");
        committee.setMember(0, m4);
        vm.stopPrank();

        _vote(m2, id, true);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Filed), "m1's vote dropped");

        _bond(m4);
        _vote(m4, id, true);
        assertEq(uint8(_status(id)), uint8(BRTypes.CharterStatus.Approved));

        vm.prank(m1);
        committee.releaseBond();
        assertEq(staking.lockedOf(m1), 0);
        assertEq(staking.stakedOf(m1), 1_000_000e18 - COMMITTEE_BOND / 10);
    }
}
