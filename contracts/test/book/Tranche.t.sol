// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {ITranche} from "../../src/interfaces/ITranche.sol";
import {Tranche} from "../../src/Tranche.sol";
import {Waterfall} from "../../src/libraries/Waterfall.sol";
import {BookFixture} from "./utils/BookFixture.sol";

contract TrancheTest is BookFixture {
    function setUp() public {
        _setUpBook();
    }

    // =========================================================================================
    // metadata / views
    // =========================================================================================

    function test_metadata() public view {
        assertEq(senior.name(), "BKRN PERP_NVDA_USDC Senior");
        assertEq(junior.name(), "BKRN PERP_NVDA_USDC Junior");
        assertEq(senior.symbol(), "BKRN-PERP_NVDA_USDC-S");
        assertEq(junior.symbol(), "BKRN-PERP_NVDA_USDC-J");
        assertEq(senior.decimals(), 6);
        assertEq(senior.asset(), address(usdc));
        assertEq(senior.book(), address(book));
        assertEq(senior.bookId(), BOOK_ID);
        assertEq(senior.kind(), BRTypes.SENIOR);
        assertEq(junior.kind(), BRTypes.JUNIOR);
        assertEq(senior.sponsor(), sponsor);
        assertEq(senior.markInterval(), INTERVAL);
        assertEq(junior.juniorNoticeSeconds(), NOTICE);
        assertEq(senior.perWalletCapUsd(), 250_000e6);
        assertEq(senior.roundInfo(0).endsAt, book.subscriptionEnds());
        assertTrue(senior.depositsOpen());
    }

    function test_previews_revert_async() public {
        vm.expectRevert(Tranche.AsyncFlow.selector);
        senior.previewDeposit(1);
        vm.expectRevert(Tranche.AsyncFlow.selector);
        senior.previewMint(1);
        vm.expectRevert(Tranche.AsyncFlow.selector);
        senior.previewRedeem(1);
        vm.expectRevert(Tranche.AsyncFlow.selector);
        senior.previewWithdraw(1);
        assertEq(senior.maxMint(alice), 0);
    }

    function test_redeemEligibleAt() public view {
        assertEq(senior.redeemEligibleAt(1000), 1000);
        assertEq(junior.redeemEligibleAt(1000), 1000 + NOTICE);
    }

    function test_conversionViews() public {
        _goLive();
        assertEq(senior.totalAssets(), 70_000e6);
        assertEq(junior.totalAssets(), 30_000e6);
        assertEq(junior.convertToAssets(3000e6), 3000e6);
        _markWithPnl(-6000e6); // junior 0.8
        assertEq(junior.convertToAssets(10_000e6), 8000e6);
        assertEq(junior.convertToShares(8000e6), 10_000e6);
        _markWithPnl(-30_000e6); // junior wiped
        assertEq(junior.convertToShares(1), 0);
        assertEq(junior.convertToAssets(1e6), 0);
    }

    // =========================================================================================
    // deposits
    // =========================================================================================

    function test_deposit_recordsCommitment() public {
        usdc.mint(bob, 1000e6);
        vm.startPrank(bob);
        usdc.approve(address(senior), 1000e6);
        vm.expectEmit(true, true, false, true, address(senior));
        emit ITranche.Committed(bob, alice, 1000e6, 0);
        assertEq(senior.deposit(1000e6, alice), 0); // on behalf of alice
        vm.stopPrank();
        assertEq(senior.committedOf(alice), 1000e6);
        assertEq(senior.committedOf(bob), 0);
        assertEq(senior.totalCommitted(), 1000e6);
        assertEq(senior.commitEscrow(), 1000e6);
        assertEq(usdc.balanceOf(address(senior)), 1000e6);
        assertEq(senior.redemptionLiquidity(), 0);
    }

    function test_deposit_reverts() public {
        vm.expectRevert(Tranche.ZeroAmount.selector);
        senior.deposit(0, alice);
        vm.expectRevert(Tranche.ZeroAddress.selector);
        senior.deposit(1, address(0));

        vm.prank(guardian);
        senior.pause();
        assertFalse(senior.depositsOpen());
        assertEq(senior.maxDeposit(alice), 0);
        vm.expectRevert(ITranche.DepositsClosed.selector);
        senior.deposit(1, alice);
        vm.prank(guardian);
        senior.unpause();

        cfg.setNewBooksPaused(true);
        vm.expectRevert(ITranche.DepositsClosed.selector);
        senior.deposit(1, alice);
        cfg.setNewBooksPaused(false);

        vm.warp(book.subscriptionEnds());
        vm.expectRevert(ITranche.DepositsClosed.selector);
        senior.deposit(1, alice);
    }

    function test_deposit_walletCap_sponsorExempt() public {
        _deposit(senior, alice, 250_000e6);
        assertEq(senior.maxDeposit(alice), 0);
        usdc.mint(alice, 1);
        vm.startPrank(alice);
        usdc.approve(address(senior), 1);
        vm.expectRevert(abi.encodeWithSelector(ITranche.WalletCapExceeded.selector, 250_000e6, 250_000e6 + 1));
        senior.deposit(1, alice);
        vm.stopPrank();

        assertEq(junior.maxDeposit(sponsor), type(uint256).max);
        _deposit(junior, sponsor, 400_000e6);
        assertEq(junior.committedOf(sponsor), 400_000e6);
        assertEq(senior.maxDeposit(bob), 250_000e6);
    }

    function test_deposit_capCountsReceiverAcrossPayers() public {
        _deposit(senior, alice, 200_000e6);
        usdc.mint(bob, 60_000e6);
        vm.startPrank(bob);
        usdc.approve(address(senior), 60_000e6);
        vm.expectRevert(abi.encodeWithSelector(ITranche.WalletCapExceeded.selector, 250_000e6, 260_000e6));
        senior.deposit(60_000e6, alice);
        vm.stopPrank();
    }

    function test_pause_access() public {
        vm.prank(eve);
        vm.expectRevert(Tranche.NotPauser.selector);
        senior.pause();
        vm.prank(sponsor);
        senior.pause();
        assertTrue(senior.paused());
        vm.prank(eve);
        vm.expectRevert(Tranche.NotPauser.selector);
        senior.unpause();
        vm.prank(address(book));
        senior.unpause();
        assertFalse(senior.paused());
        vm.prank(guardian);
        senior.pause();
        assertTrue(senior.paused());
        assertTrue(senior.guardianPaused());
        // the sponsor cannot lift a guardian pause
        vm.prank(sponsor);
        vm.expectRevert(Tranche.GuardianPaused.selector);
        senior.unpause();
        vm.prank(sponsor);
        senior.pause(); // re-pausing is harmless
        vm.prank(guardian);
        senior.unpause();
        assertFalse(senior.paused());
        assertFalse(senior.guardianPaused());
    }

    function test_selfAsReceiverOrController_reverts() public {
        usdc.mint(alice, 1);
        vm.startPrank(alice);
        usdc.approve(address(senior), 1);
        vm.expectRevert(Tranche.ZeroAddress.selector);
        senior.deposit(1, address(senior));
        vm.stopPrank();
        _goLive();
        vm.prank(alice);
        vm.expectRevert(Tranche.ZeroAddress.selector);
        senior.requestRedeem(1, address(senior), alice);
    }

    function test_claimAllocation_pushByAnyone_and_beforeSettlement() public {
        _subscribeDefault();
        (uint256 shares, uint256 refund) = senior.claimAllocation(alice); // not settled yet
        assertEq(shares + refund, 0);
        assertEq(senior.committedOf(alice), 40_000e6);
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        vm.prank(eve);
        (shares, refund) = senior.claimAllocation(alice);
        assertEq(shares, 40_000e6);
        assertEq(senior.balanceOf(alice), 40_000e6);
        assertEq(senior.claimCancelledRefund(alice), 0); // not cancelled
    }

    function test_claimAllocation_whilePaused() public {
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        vm.prank(guardian);
        senior.pause();
        cfg.setNewBooksPaused(true);
        (uint256 shares,) = senior.claimAllocation(alice);
        assertEq(shares, 40_000e6);
    }

    // =========================================================================================
    // redemption requests
    // =========================================================================================

    function test_requestRedeem_auth() public {
        _goLive();
        vm.prank(eve);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, eve, 0, uint256(1000e6))
        );
        senior.requestRedeem(1000e6, eve, alice);

        vm.prank(alice);
        senior.approve(eve, 1000e6);
        vm.prank(eve);
        uint256 rid = senior.requestRedeem(1000e6, eve, alice); // allowance path, eve is controller
        assertEq(senior.pendingRedeemRequest(rid, eve), 1000e6);
        assertEq(senior.allowance(alice, eve), 0);

        vm.prank(alice);
        senior.setOperator(eve, true);
        assertTrue(senior.isOperator(alice, eve));
        vm.prank(eve);
        senior.requestRedeem(2000e6, alice, alice); // operator path, no allowance needed
        assertEq(senior.pendingRedeemRequest(rid, alice), 2000e6);

        vm.startPrank(alice);
        vm.expectRevert(Tranche.ZeroAmount.selector);
        senior.requestRedeem(0, alice, alice);
        vm.expectRevert(Tranche.ZeroAddress.selector);
        senior.requestRedeem(1, address(0), alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, alice, 37_000e6, uint256(40_000e6)
            )
        );
        senior.requestRedeem(40_000e6, alice, alice);
        vm.stopPrank();
    }

    function test_requestRedeem_emitsAndEscrows() public {
        _goLive();
        uint256 expected = Waterfall.bucketIndex(block.timestamp, INTERVAL);
        vm.expectEmit(true, true, true, true, address(senior));
        emit ITranche.RedeemRequest(alice, alice, expected, alice, 5000e6);
        vm.prank(alice);
        senior.requestRedeem(5000e6, alice, alice);
        assertEq(senior.balanceOf(address(senior)), 5000e6);
        assertEq(senior.balanceOf(alice), 35_000e6);
        assertEq(senior.pendingBucketCount(), 1);
        assertEq(senior.bucketInfo(expected).shares, 5000e6);
        uint256[] memory buckets = senior.controllerBuckets(alice);
        assertEq(buckets.length, 1);
        assertEq(buckets[0], expected);
    }

    /// @dev RED-TEAM: requestRedeem + claims under every pause / state / kill combination.
    function test_redemption_neverPermissionGated() public {
        _goLive();
        _recall(100_000e6); // venue fully recalled: claims always funded

        // tranche pause + guardian pause (newBooksPaused) + kill
        vm.prank(sponsor);
        senior.pause();
        vm.prank(guardian);
        junior.pause();
        cfg.setNewBooksPaused(true);
        mandate.kill("RISK");

        vm.prank(alice);
        senior.requestRedeem(1000e6, alice, alice);
        vm.prank(carol);
        junior.requestRedeem(1000e6, carol, carol);
        vm.warp(block.timestamp + NOTICE + INTERVAL);
        _markWithPnl(0);
        vm.prank(alice);
        assertEq(senior.claimRedemption(alice, alice), 1000e6);
        assertEq(junior.claimFor(carol), 1000e6);

        // Retiring
        charterC.retire(BOOK_ID);
        vm.prank(bob);
        senior.requestRedeem(1000e6, bob, bob);
        _markWithPnl(0);
        assertEq(senior.claimFor(bob), 1000e6);

        // Retired
        book.finalizeRetirement();
        vm.prank(bob);
        senior.requestRedeem(1000e6, bob, bob);
        vm.prank(bob);
        assertEq(senior.claimRedemption(bob, bob), 1000e6);
        vm.prank(carol);
        junior.requestRedeem(1000e6, carol, carol);
        vm.prank(carol);
        assertEq(junior.withdraw(1000e6, carol, carol), 1000e6);
    }

    // =========================================================================================
    // claims
    // =========================================================================================

    function _settledSeniorRequest(address who, uint256 shares) internal returns (uint256 rid) {
        vm.prank(who);
        rid = senior.requestRedeem(shares, who, who);
        _recall(shares);
        _markWithPnl(0);
    }

    function test_claim_auth() public {
        _goLive();
        _settledSeniorRequest(alice, 4000e6);
        vm.prank(eve);
        vm.expectRevert(Tranche.NotAuthorized.selector);
        senior.claimRedemption(alice, eve);
        vm.prank(eve);
        vm.expectRevert(Tranche.NotAuthorized.selector);
        senior.redeem(1, eve, alice);
        vm.prank(eve);
        vm.expectRevert(Tranche.NotAuthorized.selector);
        senior.withdraw(1, eve, alice);
        vm.prank(alice);
        vm.expectRevert(Tranche.ZeroAddress.selector);
        senior.claimRedemption(alice, address(0));

        vm.prank(alice);
        senior.setOperator(dave, true);
        vm.prank(dave);
        assertEq(senior.claimRedemption(alice, dave), 4000e6);
        assertEq(usdc.balanceOf(dave), 4000e6);
    }

    function test_claimFor_pushesToController() public {
        _goLive();
        _settledSeniorRequest(alice, 4000e6);
        vm.expectEmit(true, true, false, true, address(senior));
        emit ITranche.RedemptionClaimed(alice, alice, 4000e6);
        vm.prank(eve);
        assertEq(senior.claimFor(alice), 4000e6);
        assertEq(usdc.balanceOf(alice), 4000e6);
        assertEq(senior.claimFor(alice), 0); // nothing left, no revert
    }

    function test_claim_nothing_returnsZero() public {
        _goLive();
        vm.prank(alice);
        assertEq(senior.claimRedemption(alice, alice), 0);
        vm.prank(alice);
        senior.requestRedeem(1000e6, alice, alice);
        vm.prank(alice);
        assertEq(senior.claimRedemption(alice, alice), 0); // pending, not claimable yet
    }

    function test_claim_insufficientLiquidity_onlyRevertReason() public {
        _goLive();
        vm.prank(alice);
        senior.requestRedeem(4000e6, alice, alice);
        _markWithPnl(0); // settled but unfunded (idle 0)
        assertEq(senior.claimableAssets(alice), 4000e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ITranche.InsufficientLiquidity.selector, 4000e6, 0));
        senior.claimRedemption(alice, alice);
        vm.expectRevert(abi.encodeWithSelector(ITranche.InsufficientLiquidity.selector, 4000e6, 0));
        senior.claimFor(alice);
        // once the keeper recalls, the claim pulls its own funding
        _recall(4000e6);
        assertEq(senior.claimFor(alice), 4000e6);
    }

    function test_redeem_and_withdraw_partial_FIFO() public {
        _goLive();
        _recall(30_000e6);
        vm.prank(carol);
        uint256 r1 = junior.requestRedeem(6000e6, carol, carol);
        vm.warp(block.timestamp + NOTICE + INTERVAL);
        _markWithPnl(-6000e6); // junior price 0.8 for r1
        vm.prank(carol);
        uint256 r2 = junior.requestRedeem(4000e6, carol, carol);
        vm.warp(block.timestamp + NOTICE + INTERVAL);
        _markWithPnl(0);
        uint256 p1 = junior.bucketInfo(r1).priceWad;
        uint256 p2 = junior.bucketInfo(r2).priceWad;
        assertEq(p1, 0.8e18);
        assertEq(junior.maxRedeem(carol), 10_000e6);
        assertEq(junior.maxWithdraw(carol), 6000e6 * p1 / WAD + 4000e6 * p2 / WAD);

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Tranche.ExceedsClaimable.selector, 10_000e6 + 1, 10_000e6));
        junior.redeem(10_000e6 + 1, carol, carol);

        // redeem 7k shares: all of r1 at 0.8 + 1k of r2
        vm.prank(carol);
        uint256 assets = junior.redeem(7000e6, carol, carol);
        assertEq(assets, 6000e6 * p1 / WAD + 1000e6 * p2 / WAD);
        assertEq(junior.claimableRedeemRequest(r1, carol), 0);
        assertEq(junior.claimableRedeemRequest(r2, carol), 3000e6);

        // withdraw exactly 1 USDC of r2
        vm.prank(carol);
        uint256 shares = junior.withdraw(1e6, carol, carol);
        assertEq(shares, (1e6 * WAD + p2 - 1) / p2);
        uint256 maxW = junior.maxWithdraw(carol);
        vm.prank(carol);
        vm.expectRevert();
        junior.withdraw(maxW + 1, carol, carol);
        vm.prank(carol);
        junior.withdraw(maxW, carol, carol);
        assertEq(junior.maxWithdraw(carol), 0);
        assertEq(junior.controllerBuckets(carol).length, 0);
    }

    function test_claim_boundedPerCall_continues() public {
        _goLive();
        _recall(1000e6);
        uint256 n = senior.MAX_CLAIM_BUCKETS() + 6;
        for (uint256 i = 0; i < n; i++) {
            vm.prank(alice);
            senior.requestRedeem(1e6, alice, alice);
            _markWithPnl(0);
        }
        assertEq(senior.controllerBuckets(alice).length, n);
        assertEq(senior.claimableAssets(alice), n * 1e6);
        assertEq(senior.claimFor(alice), senior.MAX_CLAIM_BUCKETS() * 1e6);
        assertEq(senior.claimFor(alice), 6e6);
        assertEq(senior.claimableAssets(alice), 0);
    }

    function test_settle_boundedPerMark_continuesNextMark() public {
        _goLive();
        _recall(1000e6);
        uint256 n = senior.MAX_SETTLE_BUCKETS() + 4;
        for (uint256 i = 0; i < n; i++) {
            vm.prank(alice);
            senior.requestRedeem(1e6, alice, alice);
            vm.warp(block.timestamp + INTERVAL);
        }
        assertEq(senior.pendingBucketCount(), n);
        _markWithPnl(0);
        assertEq(senior.pendingBucketCount(), 4);
        _markWithPnl(0);
        assertEq(senior.pendingBucketCount(), 0);
        assertEq(senior.claimableAssets(alice), n * 1e6);
    }

    function test_bookHooks_onlyBook() public {
        vm.startPrank(eve);
        vm.expectRevert(Tranche.NotBook.selector);
        senior.settleWindow(0, address(vault));
        vm.expectRevert(Tranche.NotBook.selector);
        senior.settleAtMark(0, WAD, 0, address(vault));
        vm.expectRevert(Tranche.NotBook.selector);
        senior.markCancelled();
        vm.expectRevert(Tranche.NotBook.selector);
        senior.openRound(uint64(block.timestamp + 1));
        vm.expectRevert(Tranche.NotBook.selector);
        senior.cancelRound();
        vm.stopPrank();
    }

    function test_bookHooks_validation() public {
        _deposit(senior, alice, 1000e6);
        vm.startPrank(address(book));
        vm.expectRevert(Tranche.RoundNotSettled.selector);
        senior.openRound(uint64(block.timestamp + 100));
        vm.expectRevert(abi.encodeWithSelector(Tranche.AllocationExceedsCommitted.selector, 1001e6, 1000e6));
        senior.settleWindow(1001e6, address(vault));
        senior.cancelRound(); // round 0: no-op
        assertFalse(senior.roundInfo(0).settled);
        senior.settleWindow(1000e6, address(vault));
        vm.expectRevert(Tranche.RoundAlreadySettled.selector);
        senior.settleWindow(1, address(vault));
        vm.expectRevert(Tranche.RoundAlreadySettled.selector);
        senior.markCancelled();
        vm.expectRevert(Tranche.BadRoundEnd.selector);
        senior.openRound(uint64(block.timestamp));
        senior.openRound(uint64(block.timestamp + 100));
        vm.expectRevert(Tranche.RoundAlreadySettled.selector);
        senior.settleWindow(0, address(vault));
        vm.stopPrank();
    }

    // =========================================================================================
    // fuzz: claims never exceed the bucket's settled assets
    // =========================================================================================

    function testFuzz_claimsNeverExceedBucket(uint256 a, uint256 b, uint256 c, int256 pnl) public {
        _goLive();
        // junior holders: sponsor 10k, carol 20k; dave gets some via transfer
        vm.prank(carol);
        junior.transfer(dave, 5000e6);
        a = bound(a, 1, 10_000e6);
        b = bound(b, 1, 15_000e6);
        c = bound(c, 1, 5000e6);
        pnl = bound(pnl, -29_000e6, 50_000e6);
        _recall(100_000e6);

        vm.prank(sponsor);
        uint256 rid = junior.requestRedeem(a, sponsor, sponsor);
        vm.prank(carol);
        junior.requestRedeem(b, carol, carol);
        vm.prank(dave);
        junior.requestRedeem(c, dave, dave);
        vm.warp(block.timestamp + NOTICE + INTERVAL);
        // pnl lands on the (fully recalled) vault: model it on the adapter's zero balance via donation/burn
        if (pnl >= 0) usdc.mint(address(vault), uint256(pnl));
        else usdc.burn(address(vault), uint256(-pnl));
        _markWithPnl(0);

        Tranche.Bucket memory bk = junior.bucketInfo(rid);
        assertTrue(bk.settled);
        uint256 bucketOwed = Waterfall.sharesToAssets(bk.shares, bk.priceWad);
        uint256 paid = junior.claimFor(sponsor) + junior.claimFor(carol) + junior.claimFor(dave);
        assertLe(paid, bucketOwed);
        assertGe(paid + 3, bucketOwed);
        assertGe(junior.redemptionLiquidity(), 0);
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
    }
}
