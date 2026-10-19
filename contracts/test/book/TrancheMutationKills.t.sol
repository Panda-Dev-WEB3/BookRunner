// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {Tranche} from "../../src/Tranche.sol";
import {BookFixture} from "./utils/BookFixture.sol";

/// @title Mutation-testing kills for Tranche (audit 2026-10, Task 7c; docs/MUTATION-2026-10.md)
/// @notice Each test pins behaviour that a surviving mutant of src/Tranche.sol changed without any existing test
///         noticing: the ERC-4626 / ERC-7540 views (maxDeposit, maxWithdraw, redemptionLiquidity, controllerBuckets,
///         setOperator), the claim receiver check, the cancelled-refund path on a live round, a top-up round ending on
///         a mark boundary, a second Retired redemption in the same epoch, and initialize's config and symbol handling.
contract TrancheMutationKillsTest is BookFixture {
    function setUp() public {
        _setUpBook();
    }

    /// @dev Kills `cap - used` -> `cap + used` in maxDeposit.
    function test_mut_maxDeposit_isTheRemainingCap() public {
        _deposit(senior, alice, 100e6);
        assertEq(senior.maxDeposit(alice), 250_000e6 - 100e6);
    }

    /// @dev Kills `bal - commitEscrow` -> `bal + commitEscrow`: commitments in escrow are never redemption liquidity.
    function test_mut_redemptionLiquidity_excludesCommitments() public {
        _goLive();
        _recall(5000e6);
        vm.prank(alice);
        senior.requestRedeem(1000e6, alice, alice);
        _markWithPnl(0);
        book.fundClaims();
        vm.prank(sponsor);
        book.openTopUp(600, 20_000e6, 10_000e6);
        _deposit(senior, dave, 3000e6);
        assertEq(senior.commitEscrow(), 3000e6);
        assertEq(usdc.balanceOf(address(senior)), 4000e6);
        assertEq(senior.redemptionLiquidity(), 1000e6);
    }

    /// @dev Kills `_claimableTotals(controller, true)` -> `false` in maxWithdraw: one withdraw call takes at most
    ///      MAX_CLAIM_BUCKETS buckets, and maxWithdraw says so (claimableAssets counts them all).
    function test_mut_maxWithdraw_cappedToOneClaimCall() public {
        _goLive();
        _recall(1000e6);
        uint256 n = senior.MAX_CLAIM_BUCKETS() + 2;
        for (uint256 i = 0; i < n; i++) {
            vm.prank(alice);
            senior.requestRedeem(1e6, alice, alice);
            _markWithPnl(0);
        }
        assertEq(senior.claimableAssets(alice), n * 1e6);
        assertEq(senior.maxWithdraw(alice), senior.MAX_CLAIM_BUCKETS() * 1e6);
        assertEq(senior.maxRedeem(alice), senior.MAX_CLAIM_BUCKETS() * 1e6);
    }

    /// @dev Kills `out[i - head]` -> `out[i + head]`: after a partial claim the list starts at the next bucket.
    function test_mut_controllerBuckets_afterAPartialClaim() public {
        _goLive();
        _recall(1000e6);
        vm.prank(alice);
        uint256 b1 = senior.requestRedeem(1e6, alice, alice);
        _markWithPnl(0);
        vm.prank(alice);
        uint256 b2 = senior.requestRedeem(1e6, alice, alice);
        _markWithPnl(0);
        assertTrue(b2 != b1);
        vm.prank(alice);
        senior.redeem(1e6, alice, alice); // consumes the first bucket
        uint256[] memory left = senior.controllerBuckets(alice);
        assertEq(left.length, 1);
        assertEq(left[0], b2);
    }

    /// @dev Kills the removal of `receiver == address(0)` in redeem and withdraw.
    function test_mut_claims_refuseTheZeroReceiver() public {
        _goLive();
        _recall(1000e6);
        vm.prank(alice);
        senior.requestRedeem(10e6, alice, alice);
        _markWithPnl(0);
        vm.startPrank(alice);
        vm.expectRevert(Tranche.ZeroAddress.selector);
        senior.redeem(1e6, address(0), alice);
        vm.expectRevert(Tranche.ZeroAddress.selector);
        senior.withdraw(1e6, address(0), alice);
        vm.stopPrank();
    }

    /// @dev Kills `return true` -> `false` in setOperator (ERC-7540).
    function test_mut_setOperator_returnsTrue() public {
        vm.prank(alice);
        assertTrue(senior.setOperator(bob, true));
        assertTrue(senior.isOperator(alice, bob));
    }

    /// @dev Kills `walletCommit == 0 || !cancelled` -> `&&`: on a live (not cancelled) settled round,
    ///      claimCancelledRefund refunds nothing and does not push the allocation.
    function test_mut_cancelledRefund_noopOnALiveRound() public {
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        assertEq(junior.claimCancelledRefund(carol), 0);
        assertEq(junior.balanceOf(carol), 0);
        assertEq(junior.committedOf(carol), 20_000e6);
        (uint256 shares,) = junior.claimAllocation(carol);
        assertEq(shares, 20_000e6);
    }

    /// @dev Kills `upToIndex * markInterval >= endsAt` -> `>`: a top-up round ending exactly on a mark boundary
    ///      settles at that mark, with the capacity the book passes (otherwise the book closes the round and the
    ///      tranche settles it a mark later with no capacity, refunding everyone).
    function test_mut_topUp_endingOnAMarkBoundarySettlesThere() public {
        _goLive();
        vm.warp(((block.timestamp / INTERVAL) + 1) * INTERVAL);
        uint256 aligned = block.timestamp;
        vm.prank(sponsor);
        book.openTopUp(2 * INTERVAL, 20_000e6, 10_000e6);
        (, uint64 endsAt,,) = book.topUp();
        assertEq(endsAt, aligned + 2 * INTERVAL);
        _deposit(junior, eve, 5000e6); // Junior: Senior has no room (S 70k = J 30k x 7/3)
        _markWithPnl(0); // period end = aligned + INTERVAL < endsAt
        assertFalse(junior.roundInfo(1).settled);
        _markWithPnl(0); // period end == endsAt
        assertEq(book.lastMarkPeriodEnd(), endsAt);
        (bool open,,,) = book.topUp();
        assertFalse(open);
        assertTrue(junior.roundInfo(1).settled);
        (uint256 shares, uint256 refund) = junior.claimAllocation(eve);
        assertEq(shares, 5000e6);
        assertEq(refund, 0);
    }

    /// @dev Kills `_ctrlHead >= len` -> `>` in _pushControllerBucket: a second Retired redemption in the same epoch
    ///      (same bucket) after the first was fully claimed is listed again and paid.
    function test_mut_retired_secondRequestInTheSameEpochIsClaimable() public {
        _goLive();
        charterC.retire(BOOK_ID);
        _recall(adapter.value());
        _markWithPnl(0);
        book.finalizeRetirement();
        vm.startPrank(alice);
        uint256 b1 = senior.requestRedeem(10_000e6, alice, alice);
        assertEq(senior.claimRedemption(alice, alice), 10_000e6);
        uint256 b2 = senior.requestRedeem(5000e6, alice, alice);
        assertEq(b2, b1);
        assertEq(senior.claimableAssets(alice), 5000e6);
        assertEq(senior.claimRedemption(alice, alice), 5000e6);
        vm.stopPrank();
    }

    /// @dev Kills the removal of `interval == 0 || usdc == address(0)` (and `||` -> `&&`): no USDC, no tranche.
    function test_mut_initialize_refusesAConfigWithoutUsdc() public {
        Tranche t = Tranche(Clones.clone(address(trancheImpl)));
        cfg.setUsdc(address(0));
        vm.expectRevert(Tranche.BadConfig.selector);
        t.initialize(address(cfg), BOOK_ID, address(book), BRTypes.SENIOR);
    }

    /// @dev Kills `n < 32` -> `<=` in _symbolString: a symbol using all 32 bytes is named in full.
    function test_mut_initialize_fullWidthSymbol() public {
        _deployInfra();
        BRTypes.Charter memory c = _defaultCharter();
        c.symbol = bytes32("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
        _deployBook(c);
        assertEq(senior.symbol(), "BKRN-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345-S");
        assertEq(junior.name(), "BKRN ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 Junior");
    }
}
