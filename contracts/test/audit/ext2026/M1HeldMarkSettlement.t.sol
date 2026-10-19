// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {Book} from "../../../src/Book.sol";
import {BookLogic} from "../../../src/libraries/BookLogic.sol";
import {BookFixture} from "../../book/utils/BookFixture.sol";

/// @title External audit 2026-10, M-1: redemptions settled at off-hours "held" marks.
/// @notice Finding: the mark service keeps signing marks while the oracle holds the underlying's price
///         (session closed), valuing the book at the held Friday price. A Junior holder whose notice fits
///         inside the closed session redeems at the pre-gap value and the reopen gap falls on the holders
///         who stayed (PoC: the sponsor's Junior loses 60% instead of 20%; the early exiter avoids a 4k loss).
///         Fix: marks carry a signed `held` flag; a held mark applies P&L but settles no redemption bucket
///         and no top-up round. They settle at the first non-held mark (or, for a hold longer than
///         BookLogic.MAX_HELD_DEFERRAL, at the held mark after that: a long hold defers, never blocks).
///
///         Book: Senior alice 40k + bob 30k, Junior sponsor 10k + carol 20k (sponsor = 1/3 of Junior),
///         IF 25k + MM 75k on the venue, Junior notice 900 s (3 mark intervals of 300 s).
contract M1HeldMarkSettlementTest is BookFixture {
    uint256 internal constant GAP_LOSS = 6000e6; // 20% of the 30k Junior

    function setUp() public {
        _setUpBook();
        _goLive();
        _markWithPnl(0); // "Friday close": the last live mark before the session closes
    }

    /// @dev Carol queues her whole Junior position right after the Friday close; the price is then held
    ///      for 4 mark intervals (her 900 s notice ends inside the closed session); the market reopens
    ///      with a 6k loss. Returns (carol's redemption assets, sponsor's Junior value) after reopen.
    function _closedSessionRun(bool carolExits) internal returns (uint256 carolAssets, uint256 sponsorValue) {
        if (carolExits) {
            vm.prank(carol);
            junior.requestRedeem(20_000e6, carol, carol);
        }
        for (uint256 i; i < 4; i++) {
            _heldMarkWithPnl(0); // held Friday price: deployed value unchanged
        }
        _recall(30_000e6); // venue -> vault idle so settled claims are funded (NAV unchanged)
        _markWithPnl(-int256(GAP_LOSS)); // reopen: first non-held mark carries the gap
        carolAssets =
            carolExits ? junior.claimableAssets(carol) : junior.convertToAssets(junior.balanceOf(carol));
        sponsorValue = junior.convertToAssets(junior.balanceOf(sponsor));
    }

    // =========================================================================================
    // PoC (regression) + control
    // =========================================================================================

    /// @notice Auditor's PoC. Before the fix: carol's bucket settled at a held mark at 1.00 (20k, no loss),
    ///         the whole 6k gap hit the sponsor's 10k (60% loss). After: her bucket settles at the reopen
    ///         mark, so both lose 20%, exactly as in the control run.
    function test_M1_poc_earlyExiterSharesTheGapLossProRata() public {
        (uint256 carolAssets, uint256 sponsorValue) = _closedSessionRun(true);
        assertEq(carolAssets, 16_000e6, "carol bears her 20% of the gap");
        assertEq(sponsorValue, 8000e6, "sponsor's Junior loses 20%, not 60%");
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 70_000e6, "Senior untouched");
        assertEq(j, 8000e6);
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
    }

    /// @notice Control run (nobody exits): the gap is shared pro rata, 20% each.
    function test_M1_control_noExit_lossProRata() public {
        (uint256 carolValue, uint256 sponsorValue) = _closedSessionRun(false);
        assertEq(carolValue, 16_000e6);
        assertEq(sponsorValue, 8000e6);
    }

    // =========================================================================================
    // held-mark semantics
    // =========================================================================================

    function test_M1_heldMark_appliesPnl_butSettlesNothing() public {
        vm.prank(carol);
        uint256 rid = junior.requestRedeem(5000e6, carol, carol);
        vm.prank(alice);
        uint256 sid = senior.requestRedeem(10_000e6, alice, alice); // Senior: no notice
        uint256 lastJ = junior.lastSettledIndex();
        uint256 lastS = senior.lastSettledIndex();

        for (uint256 i; i < 4; i++) {
            _heldMarkWithPnl(-750e6); // -3k over the hold
        }
        // P&L applied: Junior absorbed the held-mark losses
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 70_000e6);
        assertEq(j, 27_000e6);
        assertEq(book.sharePrice(BRTypes.JUNIOR), 0.9e18, "price tracks the post-P&L NAV");
        // ... but no bucket settled
        assertEq(junior.pendingRedeemRequest(rid, carol), 5000e6);
        assertEq(senior.pendingRedeemRequest(sid, alice), 10_000e6);
        assertEq(junior.lastSettledIndex(), lastJ);
        assertEq(senior.lastSettledIndex(), lastS);
        assertEq(book.unfundedClaims(), 0);
        assertEq(book.heldSince(), book.lastMarkPeriodEnd() - 3 * INTERVAL);

        _recall(20_000e6);
        _markWithPnl(0); // first non-held mark settles both at the post-hold prices
        assertEq(junior.claimableAssets(carol), 4500e6);
        assertEq(senior.claimableAssets(alice), 10_000e6);
        assertEq(book.heldSince(), 0, "hold run ended");
    }

    function test_M1_heldMark_emitsMarkHeld() public {
        uint256 id = _prepareMark(0, true);
        vm.expectEmit(true, true, false, true, address(book));
        emit Book.MarkHeld(BOOK_ID, id, book.lastMarkPeriodEnd() + INTERVAL, false);
        book.applyMark(id);
    }

    function test_M1_requestRedeem_unblockedDuringHold() public {
        _heldMarkWithPnl(0);
        vm.prank(carol);
        uint256 rid = junior.requestRedeem(1000e6, carol, carol);
        assertGt(rid, 0);
        vm.prank(alice);
        senior.requestRedeem(1000e6, alice, alice);
        assertEq(junior.pendingRedeemRequest(rid, carol), 1000e6);
    }

    function test_M1_topUp_deferredUntilFirstNonHeldMark() public {
        vm.prank(sponsor);
        book.openTopUp(uint32(INTERVAL), 0, 6000e6);
        _deposit(junior, dave, 6000e6);
        // the round ends during the hold
        _heldMarkWithPnl(0);
        _heldMarkWithPnl(0);
        (bool open,,,) = book.topUp();
        assertTrue(open, "round not settled at a held mark");
        (uint256 shares, uint256 refund) = junior.claimableAllocation(dave);
        assertEq(shares, 0);
        assertEq(refund, 0);

        _markWithPnl(-int256(GAP_LOSS)); // reopen: Junior price 0.8
        (open,,,) = book.topUp();
        assertFalse(open);
        (shares, refund) = junior.claimableAllocation(dave);
        assertEq(shares, 7500e6, "dave buys at the post-gap price, not at the held one");
        assertEq(refund, 0);
    }

    /// @notice A hold longer than MAX_HELD_DEFERRAL never blocks exits: the held mark after the bound
    ///         settles the due buckets (at the held valuation) and later held marks keep settling.
    function test_M1_longHold_settlesAfterMaxDeferral() public {
        vm.prank(carol);
        uint256 rid = junior.requestRedeem(5000e6, carol, carol);
        _heldMarkWithPnl(0);
        uint64 since = book.heldSince();
        assertGt(since, 0);
        // still deferred just before the bound
        vm.warp(since + BookLogic.MAX_HELD_DEFERRAL - INTERVAL);
        uint256 id = _commitMark(uint64(block.timestamp), adapter.value(), book.flowNonce(), true);
        book.applyMark(id);
        assertEq(junior.pendingRedeemRequest(rid, carol), 5000e6);
        // at the bound: settles
        vm.warp(since + BookLogic.MAX_HELD_DEFERRAL);
        id = _commitMark(uint64(block.timestamp), adapter.value(), book.flowNonce(), true);
        vm.expectEmit(true, true, false, true, address(book));
        emit Book.MarkHeld(BOOK_ID, id, since, true);
        book.applyMark(id);
        assertEq(junior.pendingRedeemRequest(rid, carol), 0);
        assertEq(junior.claimableRedeemRequest(rid, carol), 5000e6);
        // a request made later in the same hold settles at the next held mark after its notice
        vm.prank(carol);
        uint256 rid2 = junior.requestRedeem(1000e6, carol, carol);
        for (uint256 i; i < 4; i++) {
            _heldMarkWithPnl(0);
        }
        assertEq(junior.claimableRedeemRequest(rid2, carol), 1000e6);
        assertEq(book.heldSince(), since, "still the same hold run");
    }

    function test_M1_heldSince_resetsAndRestarts() public {
        _heldMarkWithPnl(0);
        uint64 first = book.heldSince();
        assertEq(first, book.lastMarkPeriodEnd());
        _markWithPnl(0);
        assertEq(book.heldSince(), 0);
        _heldMarkWithPnl(0);
        assertEq(book.heldSince(), book.lastMarkPeriodEnd());
        assertGt(book.heldSince(), first);
    }

    /// @notice Fuzz: whatever the gap and the hold length (notice inside it), an exiter during a held
    ///         session bears the same loss ratio as the sponsor who stayed (to rounding).
    function testFuzz_M1_exitDuringHold_sharesGapProRata(uint256 gap, uint8 heldMarks) public {
        gap = bound(gap, 0, 29_000e6);
        uint256 n = bound(heldMarks, 4, 40);
        vm.prank(carol);
        junior.requestRedeem(20_000e6, carol, carol);
        for (uint256 i; i < n; i++) {
            _heldMarkWithPnl(0);
        }
        _recall(30_000e6);
        _markWithPnl(-int256(gap));
        uint256 carolAssets = junior.claimableAssets(carol);
        uint256 sponsorValue = junior.convertToAssets(junior.balanceOf(sponsor));
        // carol holds 2/3 of the Junior: carol == 2 * sponsor (1 unit per share of rounding)
        assertApproxEqAbs(carolAssets, 2 * sponsorValue, 2);
        assertApproxEqAbs(carolAssets + sponsorValue, 30_000e6 - gap, 2);
    }
}
