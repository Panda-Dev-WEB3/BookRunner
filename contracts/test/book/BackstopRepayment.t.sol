// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {UnderwritingVault} from "../../src/UnderwritingVault.sol";
import {BookFixture} from "./utils/BookFixture.sol";

/// @notice A5-01: backstop cover is book debt, repaid from later gains (after Senior impairment, before the
///         Junior residual). A repayment earned while vault idle is short stays owed, netted from NAV and
///         reserved from deployment, until vault cash pays it.
contract BackstopRepaymentTest is BookFixture {
    function setUp() public {
        _setUpBook();
        _goLive(); // S 70k / J 30k, 100k deployed, idle 0
        usdc.mint(address(backstop), 50_000e6);
    }

    function _debt() internal view returns (uint256 debt, uint256 owed) {
        return book.backstopDebt();
    }

    function test_coverBecomesDebt_repaidFromGain() public {
        _markWithPnl(-40_000e6); // Junior wiped, Senior short 10k, covered
        (uint256 debt, uint256 owed) = _debt();
        assertEq(debt, 10_000e6);
        assertEq(owed, 0);

        _markWithPnl(15_000e6); // 10k back to the backstop, 5k to Junior
        (debt, owed) = _debt();
        assertEq(debt, 0);
        assertEq(owed, 0);
        assertEq(usdc.balanceOf(address(backstop)), 50_000e6, "backstop made whole");
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 70_000e6);
        assertEq(j, 5000e6);
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
    }

    function test_partialGain_repaysPartially() public {
        _markWithPnl(-40_000e6);
        _markWithPnl(4000e6);
        (uint256 debt, uint256 owed) = _debt();
        assertEq(debt, 6000e6);
        assertEq(owed, 0);
        (, uint256 j) = book.trancheNav();
        assertEq(j, 0, "Junior gets nothing while the backstop is owed");
        assertEq(usdc.balanceOf(address(backstop)), 44_000e6);
    }

    function test_impairmentRestoredBeforeRepayment() public {
        // backstop can only cover 4k of the 10k Senior shortfall
        usdc.burn(address(backstop), 46_000e6);
        _markWithPnl(-40_000e6);
        assertEq(book.seniorImpairment(), 6000e6);
        (uint256 debt,) = _debt();
        assertEq(debt, 4000e6);
        _markWithPnl(8000e6); // 6k restores Senior, 2k repays the backstop
        assertEq(book.seniorImpairment(), 0);
        (debt,) = _debt();
        assertEq(debt, 2000e6);
        assertEq(usdc.balanceOf(address(backstop)), 2000e6);
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 70_000e6);
        assertEq(j, 0);
    }

    function test_idleShort_repaymentReservedThenPaid() public {
        _markWithPnl(-40_000e6); // vault idle = the 10k cover
        vm.prank(alice);
        senior.requestRedeem(40_000e6, alice, alice);
        _markWithPnl(40_000e6); // 10k repayment earned; idle funds alice's claim first

        (uint256 debt, uint256 owed) = _debt();
        assertEq(debt, 0);
        assertEq(owed, 10_000e6, "repayment owed, waiting for vault cash");
        assertEq(book.unfundedClaims(), 30_000e6 + 10_000e6, "claims + repayment netted from NAV");
        assertEq(vault.deployable(), 0);
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
        (, uint256 j) = book.trancheNav();
        assertEq(j, 30_000e6, "Junior keeps only its residual");

        _recall(50_000e6);
        book.fundClaims(); // claims first, then the backstop
        (debt, owed) = _debt();
        assertEq(owed, 0);
        assertEq(usdc.balanceOf(address(backstop)), 50_000e6, "backstop made whole");
        assertEq(book.unfundedClaims(), 0);
        (lhs, rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
    }

    function test_vaultCannotRepay_neverBlocksMarks_keepsReserved() public {
        vm.mockCallRevert(address(vault), abi.encodeCall(UnderwritingVault.repayBackstop, (10_000e6)), "");
        _markWithPnl(-40_000e6);
        _markWithPnl(40_000e6); // applies although the vault cannot pay
        (, uint256 owed) = _debt();
        assertEq(owed, 10_000e6);
        assertEq(book.unfundedClaims(), 10_000e6);
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
        vm.clearMockedCalls();
        book.fundClaims();
        (, owed) = _debt();
        assertEq(owed, 0);
        assertEq(usdc.balanceOf(address(backstop)), 50_000e6);
    }

    function test_repayBackstop_onlyBook() public {
        vm.expectRevert(UnderwritingVault.NotBook.selector);
        vault.repayBackstop(1);
    }
}
