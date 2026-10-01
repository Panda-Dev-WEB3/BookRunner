// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IUnderwritingVault} from "../../src/interfaces/IUnderwritingVault.sol";
import {UnderwritingVault} from "../../src/UnderwritingVault.sol";
import {BookFixture} from "./utils/BookFixture.sol";

contract UnderwritingVaultTest is BookFixture {
    function setUp() public {
        _setUpBook();
        _goLive(); // 100k deployed, idle 0, flowNonce 2
    }

    function test_views() public view {
        assertEq(vault.asset(), address(usdc));
        assertEq(vault.book(), address(book));
        assertEq(vault.bookId(), BOOK_ID);
        assertEq(vault.adapter(), address(adapter));
        assertEq(vault.desk(), desk);
        assertEq(vault.senior(), address(senior));
        assertEq(vault.junior(), address(junior));
        assertEq(vault.idle(), 0);
        assertEq(vault.deployable(), 0);
    }

    function test_initialize_twice_reverts() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(address(cfg), BOOK_ID, address(book));
    }

    function test_recall_roles_and_flowNonce() public {
        vm.prank(eve);
        vm.expectRevert(UnderwritingVault.NotAuthorized.selector);
        vault.recall(BRTypes.ACCOUNT_MM, 1);

        vm.expectEmit(true, true, false, true, address(vault));
        emit IUnderwritingVault.RecallRequested(BRTypes.ACCOUNT_MM, 1000e6, keeper);
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_MM, 1000e6);
        assertEq(book.flowNonce(), 3);
        assertEq(vault.idle(), 1000e6);

        vm.prank(risk);
        vault.recall(BRTypes.ACCOUNT_IF, 1000e6);
        vm.prank(desk);
        vault.recall(BRTypes.ACCOUNT_MM, 1000e6);
        vm.prank(address(book));
        vault.recall(BRTypes.ACCOUNT_MM, 1000e6);
        assertEq(book.flowNonce(), 6);
        assertEq(vault.idle(), 4000e6);

        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingVault.BadAccount.selector, uint8(2)));
        vault.recall(2, 1);
        vm.expectRevert(UnderwritingVault.ZeroAmount.selector);
        vault.recall(BRTypes.ACCOUNT_MM, 0);
        vm.stopPrank();
    }

    function test_deployToVenue_access_reserve_and_approval() public {
        _recall(10_000e6);
        vm.prank(eve);
        vm.expectRevert(UnderwritingVault.NotAuthorized.selector);
        vault.deployToVenue(BRTypes.ACCOUNT_MM, 1);
        vm.prank(keeper);
        vm.expectRevert(UnderwritingVault.NotAuthorized.selector);
        vault.deployToVenue(BRTypes.ACCOUNT_MM, 1);

        vm.startPrank(desk);
        vm.expectRevert(UnderwritingVault.ZeroAmount.selector);
        vault.deployToVenue(BRTypes.ACCOUNT_MM, 0);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingVault.BadAccount.selector, uint8(7)));
        vault.deployToVenue(7, 1);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingVault.InsufficientIdle.selector, 10_001e6, 10_000e6)
        );
        vault.deployToVenue(BRTypes.ACCOUNT_MM, 10_001e6);
        uint64 n = book.flowNonce();
        vault.deployToVenue(BRTypes.ACCOUNT_MM, 4000e6);
        vm.stopPrank();
        assertEq(book.flowNonce(), n + 1);
        assertEq(vault.idle(), 6000e6);
        assertEq(usdc.allowance(address(vault), address(adapter)), 0);
    }

    function test_unfundedClaimCash_isReserved() public {
        vm.prank(alice);
        senior.requestRedeem(10_000e6, alice, alice);
        _markWithPnl(0); // 10k owed, unfunded
        assertEq(book.unfundedClaims(), 10_000e6);
        // a recall that lands after the mark: the cash belongs to the claimants
        _recall(12_000e6);
        assertEq(vault.idle(), 12_000e6);
        assertEq(vault.deployable(), 2000e6);
        vm.startPrank(desk);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingVault.InsufficientIdle.selector, 3000e6, 2000e6));
        vault.deployToVenue(BRTypes.ACCOUNT_MM, 3000e6);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingVault.InsufficientIdle.selector, 3000e6, 2000e6));
        vault.fundDesk(3000e6);
        vm.stopPrank();
    }

    function test_fundDesk_onlyDesk() public {
        _recall(5000e6);
        vm.prank(address(book));
        vm.expectRevert(UnderwritingVault.NotDesk.selector);
        vault.fundDesk(1);
        vm.prank(desk);
        vm.expectRevert(UnderwritingVault.ZeroAmount.selector);
        vault.fundDesk(0);
        uint64 n = book.flowNonce();
        vm.expectEmit(false, false, false, true, address(vault));
        emit IUnderwritingVault.DeskFunded(2000e6);
        vm.prank(desk);
        vault.fundDesk(2000e6);
        assertEq(usdc.balanceOf(desk), 2000e6);
        assertEq(book.flowNonce(), n + 1);
    }

    function test_payTo_onlyBook_onlyTranches() public {
        _recall(5000e6);
        vm.prank(desk);
        vm.expectRevert(UnderwritingVault.NotBook.selector);
        vault.payTo(address(senior), 1);
        vm.startPrank(address(book));
        vm.expectRevert(abi.encodeWithSelector(UnderwritingVault.NotTranche.selector, eve));
        vault.payTo(eve, 1);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingVault.NotTranche.selector, desk));
        vault.payTo(desk, 1);
        vault.payTo(address(junior), 0); // no-op
        uint64 n = book.flowNonce();
        vault.payTo(address(senior), 1000e6);
        vault.payTo(address(junior), 1000e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(senior)), 1000e6);
        assertEq(usdc.balanceOf(address(junior)), 1000e6);
        assertEq(book.flowNonce(), n); // claim funding is not a capital flow
    }

    function test_returnFromDesk() public {
        _recall(5000e6);
        vm.prank(desk);
        vault.fundDesk(2000e6);
        vm.prank(eve);
        vm.expectRevert(UnderwritingVault.NotDesk.selector);
        vault.returnFromDesk(1);
        vm.startPrank(desk);
        vm.expectRevert(UnderwritingVault.ZeroAmount.selector);
        vault.returnFromDesk(0);
        usdc.approve(address(vault), 2000e6);
        uint64 n = book.flowNonce();
        vault.returnFromDesk(2000e6);
        vm.stopPrank();
        assertEq(vault.idle(), 5000e6);
        assertEq(book.flowNonce(), n + 1);
    }

    function test_notifyCapitalFlow_adapterOrDesk() public {
        vm.prank(eve);
        vm.expectRevert(UnderwritingVault.NotAuthorized.selector);
        vault.notifyCapitalFlow();
        uint64 n = book.flowNonce();
        vm.prank(address(adapter));
        vault.notifyCapitalFlow();
        vm.prank(desk);
        vault.notifyCapitalFlow();
        assertEq(book.flowNonce(), n + 2);
    }

    function test_capitalOut_onlyWhileLive() public {
        _recall(10_000e6);
        charterC.retire(BOOK_ID);
        vm.startPrank(desk);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingVault.BookNotLive.selector, BRTypes.BookState.Retiring)
        );
        vault.deployToVenue(BRTypes.ACCOUNT_MM, 1000e6);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingVault.BookNotLive.selector, BRTypes.BookState.Retiring)
        );
        vault.fundDesk(1000e6);
        vm.stopPrank();
        // recalls are always allowed
        _recall(1000e6);
    }
}
