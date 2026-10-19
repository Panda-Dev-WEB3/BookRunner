// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {IBook} from "../../../src/interfaces/IBook.sol";
import {Book} from "../../../src/Book.sol";
import {BookFixture} from "../../book/utils/BookFixture.sol";

/// @title External audit 2026-10, lead "unconfirmed deposits": commitments stuck in Subscription.
/// @notice Finding: `closeWindow` deploys the IF and MM inventory through the vault to the venue adapter in the same
///         transaction. When that deposit keeps reverting (venue paused, adapter misconfigured), closeWindow always
///         reverts, the book never leaves Subscription and the commitments (only refundable once Cancelled) are locked
///         for good. Fix: `Book.cancelStuckWindow`, anyone, CLOSE_WINDOW_TIMEOUT (7 days) after `subscriptionEnds`:
///         Subscription -> Cancelled, every commitment refundable 1:1.
contract LeadStuckSubscriptionTest is BookFixture {
    function setUp() public {
        _setUpBook();
        _subscribeDefault();
        adapter.setRevertDeposit(true); // the venue deposit keeps reverting
    }

    /// @notice PoC: closeWindow reverts forever; after the timeout the window is cancelled and everybody is refunded
    ///         in full (on the audited code there is no way out: the commitments stay locked).
    function test_lead_stuckWindow_poc_cancelledAfterTimeoutAndRefunded() public {
        vm.warp(book.subscriptionEnds());
        vm.expectRevert(bytes("MockVenueAdapter: deposit disabled"));
        book.closeWindow();
        vm.warp(uint256(book.subscriptionEnds()) + 30 days);
        vm.expectRevert(bytes("MockVenueAdapter: deposit disabled"));
        book.closeWindow();

        vm.expectEmit(true, false, false, true, address(book));
        emit IBook.BookCancelled(BOOK_ID, "CLOSE_TIMEOUT");
        vm.prank(eve); // anyone
        book.cancelStuckWindow();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Cancelled));

        assertEq(senior.claimCancelledRefund(alice), 40_000e6);
        assertEq(senior.claimCancelledRefund(bob), 30_000e6);
        assertEq(junior.claimCancelledRefund(sponsor), 10_000e6);
        assertEq(junior.claimCancelledRefund(carol), 20_000e6);
        assertEq(usdc.balanceOf(alice), 40_000e6);
        assertEq(usdc.balanceOf(carol), 20_000e6);
        assertEq(usdc.balanceOf(address(senior)) + usdc.balanceOf(address(junior)), 0);
    }

    function test_lead_stuckWindow_notBeforeTimeout() public {
        uint64 at = uint64(uint256(book.subscriptionEnds()) + book.CLOSE_WINDOW_TIMEOUT());
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(Book.WindowNotStuck.selector, at));
        book.cancelStuckWindow();
        vm.warp(at);
        book.cancelStuckWindow();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Cancelled));
    }

    function test_lead_stuckWindow_onlyInSubscription() public {
        adapter.setRevertDeposit(false);
        vm.warp(book.subscriptionEnds());
        book.closeWindow(); // Live
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(abi.encodeWithSelector(Book.BadState.selector, BRTypes.BookState.Live));
        book.cancelStuckWindow();
    }

    function test_lead_stuckWindow_alreadyCancelled() public {
        vm.warp(uint256(book.subscriptionEnds()) + book.CLOSE_WINDOW_TIMEOUT());
        book.cancelStuckWindow();
        vm.expectRevert(abi.encodeWithSelector(Book.BadState.selector, BRTypes.BookState.Cancelled));
        book.cancelStuckWindow();
        vm.expectRevert(abi.encodeWithSelector(Book.BadState.selector, BRTypes.BookState.Cancelled));
        book.closeWindow();
    }

    /// @notice A window that can close still closes normally after the timeout (closeWindow is not gated by it).
    function test_lead_stuckWindow_closeWindowStillWorksLate() public {
        adapter.setRevertDeposit(false);
        vm.warp(uint256(book.subscriptionEnds()) + 30 days);
        book.closeWindow();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));
    }
}
