// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoreFixture} from "./utils/CoreFixture.sol";
import {CoreMockBook} from "./utils/CoreMocks.sol";
import {BookrunnerConfig} from "../../src/BookrunnerConfig.sol";
import {Backstop} from "../../src/Backstop.sol";
import {IBackstop} from "../../src/interfaces/IBkrnFeeRouter.sol";

contract BackstopTest is CoreFixture {
    function _fund(uint256 amount) internal {
        usdc.mint(address(backstop), amount);
        backstop.notifyDeposit(amount);
    }

    // ---------------------------------------------------------------- construction

    function test_constructor() public view {
        assertEq(address(backstop.config()), address(config));
        assertEq(address(backstop.usdc()), address(usdc));
        assertEq(backstop.maxCoverBps(), 10_000);
        assertEq(backstop.balance(), 0);
    }

    function test_constructor_reverts() public {
        vm.expectRevert(Backstop.ZeroAddress.selector);
        new Backstop(address(0));
        BookrunnerConfig fresh = new BookrunnerConfig(admin);
        vm.expectRevert(Backstop.ZeroAddress.selector);
        new Backstop(address(fresh));
    }

    // ---------------------------------------------------------------- deposits

    function test_notifyDeposit() public {
        usdc.mint(address(backstop), 500);
        vm.expectEmit(true, false, false, true, address(backstop));
        emit IBackstop.Deposited(alice, 300);
        vm.prank(alice);
        backstop.notifyDeposit(300);
        assertEq(backstop.accountedBalance(), 300);
        assertEq(backstop.totalDeposited(), 300);

        backstop.notifyDeposit(200);
        assertEq(backstop.accountedBalance(), 500);

        vm.expectRevert(abi.encodeWithSelector(Backstop.DepositNotReceived.selector, 1, 0));
        backstop.notifyDeposit(1);
    }

    function test_notifyDeposit_reverts() public {
        vm.expectRevert(Backstop.ZeroAmount.selector);
        backstop.notifyDeposit(0);
        usdc.mint(address(backstop), 5);
        vm.expectRevert(abi.encodeWithSelector(Backstop.DepositNotReceived.selector, 6, 5));
        backstop.notifyDeposit(6);
    }

    // ---------------------------------------------------------------- cover

    function test_cover_paysShortfallToVault() public {
        _fund(1000e6);
        vm.expectEmit(true, false, false, true, address(backstop));
        emit IBackstop.Covered(BOOK_ID, 300e6, 300e6);
        uint256 covered = book.coverFrom(address(backstop), BOOK_ID, 300e6);
        assertEq(covered, 300e6);
        assertEq(usdc.balanceOf(vault), 300e6);
        assertEq(backstop.balance(), 700e6);
        assertEq(backstop.accountedBalance(), 700e6);
        assertEq(backstop.totalCovered(), 300e6);
    }

    function test_cover_upToThePool() public {
        _fund(100e6);
        uint256 covered = book.coverFrom(address(backstop), BOOK_ID, 1000e6);
        assertEq(covered, 100e6);
        assertEq(usdc.balanceOf(vault), 100e6);
        assertEq(backstop.balance(), 0);
        // empty backstop pays nothing but still records the request
        vm.expectEmit(true, false, false, true, address(backstop));
        emit IBackstop.Covered(BOOK_ID, 5e6, 0);
        assertEq(book.coverFrom(address(backstop), BOOK_ID, 5e6), 0);
    }

    function test_cover_includesUnacknowledgedDonations() public {
        _fund(100e6);
        usdc.mint(address(backstop), 50e6); // donation without notify
        assertEq(backstop.balance(), 150e6);
        uint256 covered = book.coverFrom(address(backstop), BOOK_ID, 120e6);
        assertEq(covered, 120e6);
        assertEq(backstop.accountedBalance(), 0); // saturates
        assertEq(backstop.balance(), 30e6);
        backstop.notifyDeposit(30e6); // remaining donation can still be acknowledged
        assertEq(backstop.accountedBalance(), 30e6);
    }

    function test_cover_maxCoverBps() public {
        _fund(1000e6);
        vm.prank(admin);
        backstop.setMaxCoverBps(2500);
        assertEq(backstop.coverable(), 250e6);
        assertEq(book.coverFrom(address(backstop), BOOK_ID, 1000e6), 250e6);
        assertEq(book.coverFrom(address(backstop), BOOK_ID, 10e6), 10e6);
    }

    function test_cover_revertsForNonBook() public {
        _fund(10e6);
        vm.expectRevert(abi.encodeWithSelector(Backstop.NotBook.selector, BOOK_ID, alice));
        vm.prank(alice);
        backstop.cover(BOOK_ID, 1);

        // a registered book cannot draw under another book's id
        (CoreMockBook book2,,,) = _deployBook(2, 6000, makeAddr("vault2"));
        vm.expectRevert(abi.encodeWithSelector(Backstop.NotBook.selector, BOOK_ID, address(book2)));
        book2.coverFrom(address(backstop), BOOK_ID, 1);

        // other components of the book are not the book
        vm.expectRevert(abi.encodeWithSelector(Backstop.NotBook.selector, BOOK_ID, address(router)));
        vm.prank(address(router));
        backstop.cover(BOOK_ID, 1);
    }

    function test_cover_revertsWhenFactoryUnset() public {
        BookrunnerConfig c2 = new BookrunnerConfig(admin);
        vm.prank(admin);
        c2.setAddress("usdc", address(usdc));
        Backstop b2 = new Backstop(address(c2));
        vm.expectRevert(abi.encodeWithSelector(Backstop.NotBook.selector, BOOK_ID, address(book)));
        book.coverFrom(address(b2), BOOK_ID, 1);
    }

    function test_cover_revertsWhenVaultUnset() public {
        _fund(10e6);
        book.setVault(address(0));
        vm.expectRevert(abi.encodeWithSelector(Backstop.NotConfigured.selector, bytes32("vault")));
        book.coverFrom(address(backstop), BOOK_ID, 1);
    }

    // ---------------------------------------------------------------- admin

    function test_setMaxCoverBps() public {
        vm.expectEmit(false, false, false, true, address(backstop));
        emit Backstop.MaxCoverBpsSet(1);
        vm.prank(admin);
        backstop.setMaxCoverBps(1);
        assertEq(backstop.maxCoverBps(), 1);

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(Backstop.InvalidBps.selector, 0));
        backstop.setMaxCoverBps(0);
        vm.expectRevert(abi.encodeWithSelector(Backstop.InvalidBps.selector, 10_001));
        backstop.setMaxCoverBps(10_001);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(Backstop.NotAdmin.selector, guardian));
        vm.prank(guardian);
        backstop.setMaxCoverBps(5000);
    }

    // ---------------------------------------------------------------- fuzz (red-team: backstop up to the pool)

    function testFuzz_cover_neverExceedsPoolOrShortfall(uint256 bal, uint256 shortfall, uint16 capBps)
        public
    {
        bal = bound(bal, 0, 1e18);
        shortfall = bound(shortfall, 0, 1e18);
        capBps = uint16(bound(capBps, 1, 10_000));
        if (bal > 0) _fund(bal);
        vm.prank(admin);
        backstop.setMaxCoverBps(capBps);
        uint256 covered = book.coverFrom(address(backstop), BOOK_ID, shortfall);
        uint256 cap = (bal * capBps) / 10_000;
        assertEq(covered, shortfall < cap ? shortfall : cap);
        assertLe(covered, bal);
        assertLe(covered, shortfall);
        assertEq(usdc.balanceOf(vault), covered);
        assertEq(backstop.balance(), bal - covered);
        assertLe(backstop.accountedBalance(), backstop.balance());
    }
}
