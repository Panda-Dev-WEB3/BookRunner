// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IBook} from "../../src/interfaces/IBook.sol";
import {ITranche} from "../../src/interfaces/ITranche.sol";
import {Book} from "../../src/Book.sol";
import {Tranche} from "../../src/Tranche.sol";
import {UnderwritingVault} from "../../src/UnderwritingVault.sol";
import {Waterfall} from "../../src/libraries/Waterfall.sol";
import {BookFixture} from "./utils/BookFixture.sol";
import {MockBackstop, MockVenueAdapter, MockMandate} from "./utils/BookMocks.sol";

contract BookV2 is Book {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract BookTest is BookFixture {
    function setUp() public {
        _setUpBook();
    }

    // =========================================================================================
    // initialization / upgrades
    // =========================================================================================

    function test_initialize_state() public view {
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Subscription));
        assertEq(book.bookId(), BOOK_ID);
        assertEq(book.config(), address(cfg));
        assertEq(book.sponsor(), sponsor);
        assertEq(book.subscriptionEnds(), uint64(block.timestamp) + WINDOW);
        assertEq(book.markInterval(), INTERVAL);
        assertEq(book.sharePrice(BRTypes.SENIOR), WAD);
        assertEq(book.sharePrice(BRTypes.JUNIOR), WAD);
        (uint256 pi, uint256 hw) = book.perfIndex();
        assertEq(pi, WAD);
        assertEq(hw, WAD);
        BRTypes.BookComponents memory c = book.components();
        assertEq(c.senior, address(senior));
        assertEq(c.junior, address(junior));
        assertEq(c.vault, address(vault));
        BRTypes.Charter memory ch = book.getCharter();
        assertEq(ch.ifTargetUsd, 25_000e6);
        assertEq(ch.symbol, bytes32("PERP_NVDA_USDC"));
        assertEq(ch.mandate.killAtDrawdownBps, -800);
        assertEq(ch.sponsor, sponsor);
    }

    function test_storageSlotConstant() public pure {
        bytes32 expected = keccak256(abi.encode(uint256(keccak256("bookrunner.storage.Book")) - 1))
            & ~bytes32(uint256(0xff));
        assertEq(expected, 0xafd306892a6154f35c973e251e6b4f2659d2ae19802986651fcc8ec3ae5c4c00);
    }

    function test_initialize_twice_reverts() public {
        BRTypes.BookComponents memory c = book.components();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        book.initialize(address(cfg), BOOK_ID, _defaultCharter(), c);
    }

    function test_implementation_locked() public {
        BRTypes.BookComponents memory c = book.components();
        c.book = address(bookImpl);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bookImpl.initialize(address(cfg), BOOK_ID, _defaultCharter(), c);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        trancheImpl.initialize(address(cfg), BOOK_ID, address(book), 0);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vaultImpl.initialize(address(cfg), BOOK_ID, address(book));
    }

    function _expectInitRevert(BRTypes.Charter memory ch, BRTypes.BookComponents memory c, bytes memory err)
        internal
    {
        bytes memory init = abi.encodeCall(Book.initialize, (address(cfg), BOOK_ID, ch, c));
        vm.expectRevert(err);
        new ERC1967Proxy(address(bookImpl), init);
    }

    function test_initialize_reverts() public {
        BRTypes.Charter memory ch = _defaultCharter();
        BRTypes.BookComponents memory c = _components();

        bytes memory init = abi.encodeCall(Book.initialize, (address(0), BOOK_ID, ch, c));
        vm.expectRevert(Book.ZeroAddress.selector);
        new ERC1967Proxy(address(bookImpl), init);

        BRTypes.BookComponents memory bad = _components();
        bad.book = address(book); // another proxy
        _expectInitRevert(ch, bad, abi.encodeWithSelector(Book.ComponentMismatch.selector));

        bad = _components();
        bad.desk = address(0);
        _expectInitRevert(ch, bad, abi.encodeWithSelector(Book.ZeroAddress.selector));

        ch.seniorCapBps = 10_001;
        _expectInitRevert(ch, c, abi.encodeWithSelector(Book.BadCharter.selector));

        ch = _defaultCharter();
        ch.seniorHurdleBps = 10_001;
        _expectInitRevert(ch, c, abi.encodeWithSelector(Book.BadCharter.selector));

        ch = _defaultCharter();
        ch.sponsor = address(0);
        _expectInitRevert(ch, c, abi.encodeWithSelector(Book.ZeroAddress.selector));

        cfg.setMarkInterval(0);
        _expectInitRevert(_defaultCharter(), c, abi.encodeWithSelector(Book.BadConfig.selector));
    }

    function test_initialize_bookComponentIsSelf() public view {
        assertEq(book.components().book, address(book));
    }

    function test_componentInitialize_reverts() public {
        Tranche t = Tranche(Clones.clone(address(trancheImpl)));
        vm.expectRevert(Tranche.ZeroAddress.selector);
        t.initialize(address(0), BOOK_ID, address(book), 0);
        vm.expectRevert(Tranche.BadKind.selector);
        t.initialize(address(cfg), BOOK_ID, address(book), 2);
        vm.expectRevert(Tranche.BookMismatch.selector);
        t.initialize(address(cfg), BOOK_ID + 1, address(book), 0);

        UnderwritingVault v = UnderwritingVault(Clones.clone(address(vaultImpl)));
        vm.expectRevert(UnderwritingVault.BookMismatch.selector);
        v.initialize(address(cfg), BOOK_ID + 1, address(book));
        vm.expectRevert(UnderwritingVault.BookMismatch.selector); // not the book's vault
        v.initialize(address(cfg), BOOK_ID, address(book));
        vm.expectRevert(UnderwritingVault.ZeroAddress.selector);
        v.initialize(address(0), BOOK_ID, address(book));
    }

    function test_upgrade_onlyTimelock() public {
        _goLive();
        BookV2 v2 = new BookV2();
        vm.expectRevert(Book.NotTimelock.selector);
        book.upgradeToAndCall(address(v2), "");

        vm.prank(timelock);
        book.upgradeToAndCall(address(v2), "");
        assertEq(BookV2(address(book)).version(), 2);
        // state preserved across the upgrade
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 70_000e6);
        assertEq(j, 30_000e6);
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));
    }

    function test_views_badKind_revert() public {
        vm.expectRevert(abi.encodeWithSelector(Book.BadKind.selector, uint8(2)));
        book.sharePrice(2);
        vm.expectRevert(abi.encodeWithSelector(Book.BadKind.selector, uint8(2)));
        book.unfundedOf(2);
        vm.expectRevert(abi.encodeWithSelector(Book.BadKind.selector, uint8(2)));
        book.retiredPrice(2);
    }

    // =========================================================================================
    // closeWindow
    // =========================================================================================

    function test_closeWindow_beforeEnd_reverts() public {
        _subscribeDefault();
        vm.expectRevert(abi.encodeWithSelector(Book.WindowStillOpen.selector, book.subscriptionEnds()));
        book.closeWindow();
    }

    function test_closeWindow_success() public {
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        vm.expectEmit(true, false, false, true, address(book));
        emit IBook.WindowClosed(BOOK_ID, 70_000e6, 30_000e6, 70_000e6, 30_000e6);
        vm.expectEmit(true, false, false, true, address(book));
        emit IBook.CapitalDeployed(BOOK_ID, 25_000e6, 75_000e6);
        book.closeWindow();

        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 70_000e6);
        assertEq(j, 30_000e6);
        assertEq(vault.idle(), 0);
        assertEq(adapter.value(), 100_000e6);
        assertEq(adapter.ifEquity(), 25_000e6);
        assertEq(book.flowNonce(), 2);
        assertEq(senior.totalSupply(), 70_000e6);
        assertEq(junior.totalSupply(), 30_000e6);
        assertEq(senior.balanceOf(address(senior)), 70_000e6); // escrowed until claimed
        (uint256 shares, uint256 refund) = senior.claimableAllocation(alice);
        assertEq(shares, 40_000e6);
        assertEq(refund, 0);
        assertEq(usdc.allowance(address(vault), address(adapter)), 0);

        vm.expectRevert(abi.encodeWithSelector(Book.BadState.selector, BRTypes.BookState.Live));
        book.closeWindow();
    }

    function test_closeWindow_proRata_oversubscribed() public {
        _deposit(senior, alice, 100_000e6);
        _deposit(senior, bob, 40_000e6);
        _deposit(junior, sponsor, 20_000e6);
        _deposit(junior, carol, 40_000e6);
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 70_000e6);
        assertEq(j, 30_000e6);

        uint256 aliceBefore = usdc.balanceOf(alice);
        (uint256 shares, uint256 refund) = senior.claimAllocation(alice);
        assertEq(shares, 50_000e6); // 100k * 70k / 140k
        assertEq(refund, 50_000e6);
        assertEq(senior.balanceOf(alice), 50_000e6);
        assertEq(usdc.balanceOf(alice) - aliceBefore, 50_000e6);
        // Junior: the sponsor's 20k is allocated first, carol gets the remaining 10k of the 30k
        (shares, refund) = junior.claimAllocation(sponsor);
        assertEq(shares, 20_000e6);
        assertEq(refund, 0);
        (shares, refund) = junior.claimAllocation(carol);
        assertEq(shares, 10_000e6);
        assertEq(refund, 30_000e6);
        // second claim is a no-op
        (shares, refund) = junior.claimAllocation(carol);
        assertEq(shares + refund, 0);
    }

    function test_closeWindow_seniorCappedByJunior() public {
        _deposit(senior, alice, 70_000e6);
        _deposit(junior, sponsor, 10_000e6);
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(j, 10_000e6);
        assertEq(s, uint256(10_000e6) * 7000 / 3000); // 23,333.333333
        (uint256 shares, uint256 refund) = senior.claimAllocation(alice);
        assertEq(shares, s);
        assertEq(refund, 70_000e6 - s);
        // IF first, then MM
        assertEq(adapter.ifEquity(), 25_000e6);
        assertEq(adapter.value(), s + j);
    }

    function test_closeWindow_partialRaise_idleRemainder() public {
        // raise below IF + MM: IF fully funded, remainder to MM, nothing idle
        _deposit(senior, alice, 20_000e6);
        _deposit(junior, sponsor, 15_000e6);
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        assertEq(adapter.ifEquity(), 25_000e6);
        assertEq(adapter.value(), 35_000e6);
        assertEq(vault.idle(), 0);
    }

    function _expectCancel(bytes32 reason) internal {
        vm.warp(book.subscriptionEnds());
        vm.expectEmit(true, false, false, true, address(book));
        emit IBook.BookCancelled(BOOK_ID, reason);
        book.closeWindow();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Cancelled));
    }

    function test_closeWindow_cancel_noJunior() public {
        _deposit(senior, alice, 50_000e6);
        _expectCancel("NO_JUNIOR");
        uint256 refund = senior.claimCancelledRefund(alice);
        assertEq(refund, 50_000e6);
        assertEq(usdc.balanceOf(alice), 50_000e6);
        assertEq(senior.claimCancelledRefund(alice), 0);
    }

    function test_closeWindow_cancel_sponsorSkin() public {
        _deposit(senior, alice, 50_000e6);
        _deposit(senior, sponsor, 5000e6); // Senior does not count toward the skin
        _deposit(junior, carol, 30_000e6); // the sponsor committed no Junior
        _expectCancel("SPONSOR_SKIN");
        // claimAllocation also refunds in full on a cancelled book (anyone may push)
        vm.prank(eve);
        (uint256 shares, uint256 refund) = junior.claimAllocation(carol);
        assertEq(shares, 0);
        assertEq(refund, 30_000e6);
        assertEq(usdc.balanceOf(carol), 30_000e6);
        assertEq(senior.claimCancelledRefund(sponsor), 5000e6);
        assertEq(senior.claimCancelledRefund(alice), 50_000e6);
        assertEq(usdc.balanceOf(address(junior)), 0);
        assertEq(usdc.balanceOf(address(senior)), 0);
    }

    function test_closeWindow_sponsorBelow10pctCommitted_cappedNotCancelled() public {
        _deposit(senior, alice, 50_000e6);
        _deposit(junior, sponsor, 2999e6);
        _deposit(junior, carol, 27_001e6); // sponsor 9.997% of committed Junior
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));
        (, uint256 j) = book.trancheNav();
        assertEq(j, 29_990e6); // Junior capped at 10x the sponsor; carol's 10 USDC excess is refunded
        (uint256 shares, uint256 refund) = junior.claimAllocation(carol);
        assertEq(shares, 26_991e6);
        assertEq(refund, 10e6);
        (shares, refund) = junior.claimAllocation(sponsor);
        assertEq(shares, 2999e6);
        assertEq(refund, 0);
    }

    function test_closeWindow_sponsorExactly10pct_ok() public {
        _deposit(senior, alice, 50_000e6);
        _deposit(junior, sponsor, 3000e6);
        _deposit(junior, carol, 27_000e6);
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));
    }

    function test_closeWindow_cancel_ifUnfunded() public {
        _deposit(senior, alice, 10_000e6);
        _deposit(junior, sponsor, 10_000e6);
        _expectCancel("IF_UNFUNDED");
        assertEq(junior.claimCancelledRefund(sponsor), 10_000e6);
    }

    function test_cancelled_noFurtherLifecycle() public {
        _deposit(senior, alice, 10_000e6);
        _expectCancel("NO_JUNIOR");
        vm.expectRevert(abi.encodeWithSelector(Book.BadState.selector, BRTypes.BookState.Cancelled));
        book.applyMark(1);
        vm.prank(router);
        vm.expectRevert(abi.encodeWithSelector(Book.BadState.selector, BRTypes.BookState.Cancelled));
        book.creditDistribution(1, 1);
        vm.expectRevert(ITranche.DepositsClosed.selector);
        senior.deposit(1, alice);
    }

    // =========================================================================================
    // applyMark: validation
    // =========================================================================================

    function test_applyMark_beforeLive_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(Book.BadState.selector, BRTypes.BookState.Subscription));
        book.applyMark(1);
    }

    function test_applyMark_validation() public {
        _goLive();
        vm.warp(block.timestamp + INTERVAL);
        uint64 pe = _nextPeriodEnd();

        vm.expectRevert(abi.encodeWithSelector(Book.UnknownMark.selector, 99));
        book.applyMark(99);

        BRTypes.MarkInput memory other = BRTypes.MarkInput({
            bookId: BOOK_ID + 1,
            periodEnd: pe,
            navUsd: 0,
            deployedValueUsd: 0,
            flowNonce: 2,
            inventoryRoot: 0,
            pnlJsonHash: 0,
            receiptsRoot: 0
        });
        uint256 otherId = registry.commit(other, "");
        vm.expectRevert(abi.encodeWithSelector(Book.MarkForOtherBook.selector, otherId, BOOK_ID + 1));
        book.applyMark(otherId);

        uint256 stale = _commitMark(pe, 100_000e6, 1);
        vm.expectRevert(abi.encodeWithSelector(Book.FlowNonceMismatch.selector, uint64(2), uint64(1)));
        book.applyMark(stale);

        uint256 first = _commitMark(pe, 100_000e6, 2);
        uint256 second = _commitMark(pe + INTERVAL, 100_000e6, 2);
        vm.warp(pe + INTERVAL);
        book.applyMark(second);
        assertEq(book.lastMarkId(), second);
        assertEq(book.lastMarkPeriodEnd(), pe + INTERVAL);
        assertTrue(registry.getMark(second).applied);

        vm.expectRevert(abi.encodeWithSelector(Book.MarkAlreadyApplied.selector, second));
        book.applyMark(second);
        vm.expectRevert(abi.encodeWithSelector(Book.MarkOutOfOrder.selector, pe, pe + INTERVAL));
        book.applyMark(first);
    }

    function test_applyMark_staleAfterCapitalFlow_reverts() public {
        _goLive();
        vm.warp(block.timestamp + INTERVAL);
        uint256 id = _commitMark(_nextPeriodEnd(), 100_000e6, book.flowNonce());
        _recall(1000e6); // capital flow after the valuation
        vm.expectRevert(abi.encodeWithSelector(Book.FlowNonceMismatch.selector, uint64(3), uint64(2)));
        book.applyMark(id);
    }

    // =========================================================================================
    // applyMark: waterfall
    // =========================================================================================

    function test_mark_flat() public {
        _goLive();
        _markWithPnl(0);
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 70_000e6);
        assertEq(j, 30_000e6);
        assertEq(book.drawdownBps(), 0);
        Book.LastMark memory lm = book.lastMarkSummary();
        assertEq(lm.navUsd, 100_000e6);
        assertEq(lm.deployedValueUsd, 100_000e6);
    }

    function test_mark_loss_juniorFirst() public {
        _goLive();
        vm.recordLogs();
        _markWithPnl(-5000e6);
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 70_000e6);
        assertEq(j, 25_000e6);
        assertEq(book.seniorImpairment(), 0);
        assertEq(book.sharePrice(BRTypes.SENIOR), WAD);
        assertEq(book.sharePrice(BRTypes.JUNIOR), uint256(25_000e6) * WAD / 30_000e6);
        (uint256 pi,) = book.perfIndex();
        assertEq(pi, 0.95e18);
        assertEq(book.drawdownBps(), -500);
        assertFalse(mandate.killed());
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
    }

    function test_mark_loss_throughJunior_impairsSenior_backstopCovers() public {
        _goLive();
        usdc.mint(address(backstop), 4000e6);
        uint256 id = _prepareMark(-40_000e6);
        vm.expectEmit(true, false, false, true, address(book));
        emit IBook.LossAbsorbed(BOOK_ID, 30_000e6, 10_000e6, 4000e6);
        book.applyMark(id);
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(j, 0);
        assertEq(s, 64_000e6);
        assertEq(book.seniorImpairment(), 6000e6);
        assertEq(vault.idle(), 4000e6);
        Book.LastMark memory lm = book.lastMarkSummary();
        assertEq(lm.backstopCovered, 4000e6);
        assertEq(s + j, lm.navUsd + lm.backstopCovered); // conservation
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
        // drawdown 40% -> killed
        assertTrue(mandate.killed());
        assertEq(mandate.killReason(), bytes32("DRAWDOWN"));
        (bytes32 reason,) = book.lastKill();
        assertEq(reason, bytes32("DRAWDOWN"));
    }

    function test_mark_backstopPaysLessThanModelled_usesReceived() public {
        _goLive();
        usdc.mint(address(backstop), 10_000e6);
        backstop.setMode(MockBackstop.Mode.PayHalf);
        _markWithPnl(-40_000e6); // shortfall 10k, backstop pays 5k
        (uint256 s,) = book.trancheNav();
        assertEq(s, 65_000e6);
        assertEq(book.seniorImpairment(), 5000e6);
        assertEq(book.lastMarkSummary().backstopCovered, 5000e6);
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
    }

    function test_mark_backstopOverReports_usesReceived() public {
        _goLive();
        usdc.mint(address(backstop), 3000e6);
        backstop.setMode(MockBackstop.Mode.OverReport);
        _markWithPnl(-40_000e6);
        (uint256 s,) = book.trancheNav();
        assertEq(s, 63_000e6);
        assertEq(book.seniorImpairment(), 7000e6);
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
    }

    function test_mark_backstopReverts_markStillApplies() public {
        _goLive();
        usdc.mint(address(backstop), 3000e6);
        backstop.setMode(MockBackstop.Mode.Revert);
        vm.warp(((block.timestamp / INTERVAL) + 1) * INTERVAL);
        adapter.setValue(60_000e6);
        uint256 id = _commitMark(_nextPeriodEnd(), 60_000e6, book.flowNonce());
        vm.expectEmit(true, false, false, true, address(book));
        emit Book.BackstopCoverFailed(BOOK_ID, 10_000e6);
        book.applyMark(id);
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 60_000e6);
        assertEq(j, 0);
        assertEq(book.seniorImpairment(), 10_000e6);
    }

    function test_mark_backstopBalanceReverts_noCover() public {
        _goLive();
        usdc.mint(address(backstop), 3000e6);
        backstop.setRevertBalance(true);
        _markWithPnl(-40_000e6);
        assertEq(book.seniorImpairment(), 10_000e6);
        assertEq(backstop.covers(), 0);
    }

    function test_mark_noBackstopConfigured() public {
        _goLive();
        cfg.setBackstop(address(0));
        _markWithPnl(-40_000e6);
        assertEq(book.seniorImpairment(), 10_000e6);
    }

    function test_mark_gain_restoresSeniorFirst_thenJunior() public {
        _goLive();
        _markWithPnl(-40_000e6); // J 0, S 60k, imp 10k
        uint256 id = _prepareMark(15_000e6);
        vm.expectEmit(true, false, false, true, address(book));
        emit IBook.GainAllocated(BOOK_ID, 10_000e6, 5000e6);
        book.applyMark(id);
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 70_000e6);
        assertEq(j, 5000e6);
        assertEq(book.seniorImpairment(), 0);
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
    }

    function test_mark_perfIndexAndHighWater() public {
        _goLive();
        _markWithPnl(10_000e6); // +10%
        (uint256 pi, uint256 hw) = book.perfIndex();
        assertEq(pi, 1.1e18);
        assertEq(hw, 1.1e18);
        _markWithPnl(-5500e6); // 110k -> 104.5k: index 1.045
        (pi, hw) = book.perfIndex();
        assertEq(pi, 1.045e18);
        assertEq(hw, 1.1e18);
        assertEq(book.drawdownBps(), -500);
        assertFalse(mandate.killed());
    }

    function test_mark_drawdownKill_onceOnly() public {
        _goLive();
        _markWithPnl(-9000e6); // -9% <= -8%
        assertTrue(mandate.killed());
        assertEq(mandate.killCount(), 1);
        _markWithPnl(-1000e6);
        assertEq(mandate.killCount(), 1);
    }

    function test_mark_drawdownKill_liveTermsPreferred() public {
        _goLive();
        mandate.setKillAt(-2000);
        _markWithPnl(-9000e6);
        assertFalse(mandate.killed());
    }

    function test_mark_drawdownKill_getMandateReverts_usesCharterTerms() public {
        _goLive();
        mandate.setKillAt(-2000);
        mandate.setRevertGetMandate(true);
        _markWithPnl(-9000e6);
        assertTrue(mandate.killed());
    }

    function test_mark_killReverts_markStillApplies() public {
        _goLive();
        mandate.setRevertKill(true);
        vm.warp(((block.timestamp / INTERVAL) + 1) * INTERVAL);
        adapter.setValue(90_000e6);
        uint256 id = _commitMark(_nextPeriodEnd(), 90_000e6, book.flowNonce());
        vm.expectEmit(true, false, false, true, address(book));
        emit Book.MandateKillFailed(BOOK_ID, bytes32("DRAWDOWN"));
        book.applyMark(id);
        assertEq(book.lastMarkId(), id);
    }

    function test_markedNavPreview_netsUnfundedClaims() public {
        _goLive();
        assertEq(book.markedNavPreview(100_000e6), 100_000e6);
        vm.prank(alice);
        senior.requestRedeem(10_000e6, alice, alice);
        _markWithPnl(0); // 10k owed, idle 0 -> unfunded
        assertEq(book.unfundedClaims(), 10_000e6);
        assertEq(book.unfundedOf(BRTypes.SENIOR), 10_000e6);
        // net NAV: 0 idle + 100k deployed - 10k owed
        assertEq(book.markedNavPreview(100_000e6), 90_000e6);
        _markWithPnl(0);
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s + j, 90_000e6); // no phantom gain from the unfunded liability
    }

    // =========================================================================================
    // redemptions
    // =========================================================================================

    function test_seniorRedemption_settlesAtNextMark() public {
        _goLive();
        uint256 t0 = block.timestamp;
        vm.prank(alice);
        uint256 rid = senior.requestRedeem(10_000e6, alice, alice);
        assertEq(rid, Waterfall.bucketIndex(t0, INTERVAL));
        assertEq(senior.pendingRedeemRequest(rid, alice), 10_000e6);
        assertEq(senior.claimableRedeemRequest(rid, alice), 0);

        _recall(10_000e6);
        _markWithPnl(0);
        assertEq(senior.pendingRedeemRequest(rid, alice), 0);
        assertEq(senior.claimableRedeemRequest(rid, alice), 10_000e6);
        assertEq(senior.claimableAssets(alice), 10_000e6);
        assertEq(book.unfundedClaims(), 0);
        assertEq(senior.totalSupply(), 60_000e6);
        (uint256 s,) = book.trancheNav();
        assertEq(s, 60_000e6);

        vm.prank(alice);
        uint256 got = senior.claimRedemption(alice, alice);
        assertEq(got, 10_000e6);
        assertEq(usdc.balanceOf(alice), 10_000e6);
        assertEq(senior.claimableAssets(alice), 0);
    }

    function test_seniorRedemption_atLossPrice() public {
        _goLive();
        vm.prank(alice);
        senior.requestRedeem(10_000e6, alice, alice);
        _recall(20_000e6);
        _markWithPnl(-40_000e6); // J wiped, S 60k / 70k shares
        uint256 price = book.sharePrice(BRTypes.SENIOR);
        assertEq(price, uint256(60_000e6) * WAD / 70_000e6);
        uint256 owed = 10_000e6 * price / WAD;
        assertEq(senior.claimableAssets(alice), owed);
        vm.prank(alice);
        assertEq(senior.claimRedemption(alice, alice), owed);
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
    }

    function test_juniorRedemption_afterNotice() public {
        _goLive();
        uint256 t0 = block.timestamp;
        vm.prank(carol);
        uint256 rid = junior.requestRedeem(5000e6, carol, carol);
        assertEq(rid, Waterfall.bucketIndex(t0 + NOTICE, INTERVAL));
        assertEq(junior.redeemEligibleAt(uint64(t0)), uint64(t0 + NOTICE));
        _recall(10_000e6);
        uint256 marks;
        while (block.timestamp < rid * INTERVAL) {
            _markWithPnl(0);
            marks++;
            if (book.lastMarkPeriodEnd() < rid * INTERVAL) {
                assertEq(junior.pendingRedeemRequest(rid, carol), 5000e6, "still pending before notice");
            }
        }
        assertGt(marks, 1);
        assertEq(junior.claimableRedeemRequest(rid, carol), 5000e6);
        vm.prank(carol);
        assertEq(junior.claimRedemption(carol, carol), 5000e6);
    }

    function test_request_atSettledBoundary_goesToNextBucket() public {
        _goLive();
        vm.warp(((block.timestamp / INTERVAL) + 1) * INTERVAL);
        uint256 id = _commitMark(uint64(block.timestamp), 100_000e6, book.flowNonce());
        book.applyMark(id); // settles buckets <= now / INTERVAL
        vm.prank(alice);
        uint256 rid = senior.requestRedeem(1000e6, alice, alice);
        assertEq(rid, block.timestamp / INTERVAL + 1);
        assertEq(senior.lastSettledIndex(), block.timestamp / INTERVAL);
    }

    function test_unfundedClaims_thenFundClaims() public {
        _goLive();
        vm.prank(alice);
        senior.requestRedeem(10_000e6, alice, alice);
        vm.prank(carol);
        junior.requestRedeem(3000e6, carol, carol);
        vm.warp(block.timestamp + NOTICE + INTERVAL);
        _markWithPnl(0);
        assertEq(book.unfundedOf(BRTypes.SENIOR), 10_000e6);
        assertEq(book.unfundedOf(BRTypes.JUNIOR), 3000e6);

        // claim reverts only for liquidity
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ITranche.InsufficientLiquidity.selector, 10_000e6, 0));
        senior.claimRedemption(alice, alice);

        _recall(11_000e6);
        vm.expectEmit(true, false, false, true, address(book));
        emit IBook.ClaimsFunded(BOOK_ID, 11_000e6, 2000e6);
        vm.prank(eve);
        assertEq(book.fundClaims(), 11_000e6); // senior first
        assertEq(book.unfundedOf(BRTypes.SENIOR), 0);
        assertEq(book.unfundedOf(BRTypes.JUNIOR), 2000e6);
        vm.prank(alice);
        assertEq(senior.claimRedemption(alice, alice), 10_000e6);

        // the junior claim pulls the remaining funding itself
        _recall(5000e6);
        vm.prank(carol);
        assertEq(junior.claimRedemption(carol, carol), 3000e6);
        assertEq(book.unfundedClaims(), 0);
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
    }

    function test_fundClaims_nothingOwed() public {
        _goLive();
        assertEq(book.fundClaims(), 0);
    }

    // =========================================================================================
    // distributions / flows / kill hooks
    // =========================================================================================

    function test_creditDistribution_onlyRouter() public {
        _goLive();
        vm.expectRevert(Book.NotRouter.selector);
        book.creditDistribution(1, 1);
        usdc.mint(address(vault), 900e6);
        vm.expectEmit(true, false, false, true, address(book));
        emit IBook.DistributionCredited(BOOK_ID, 600e6, 300e6);
        vm.prank(router);
        book.creditDistribution(600e6, 300e6);
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 70_600e6);
        assertEq(j, 30_300e6);
        // credited flow is not P&L at the next mark
        _markWithPnl(0);
        (s, j) = book.trancheNav();
        assertEq(s, 70_600e6);
        assertEq(j, 30_300e6);
        assertEq(book.drawdownBps(), 0);
    }

    function test_creditDistribution_subscription_reverts() public {
        vm.prank(router);
        vm.expectRevert(abi.encodeWithSelector(Book.BadState.selector, BRTypes.BookState.Subscription));
        book.creditDistribution(1, 1);
    }

    function test_onCapitalFlow_onlyVault() public {
        vm.expectRevert(Book.NotVault.selector);
        book.onCapitalFlow();
        vm.prank(address(vault));
        book.onCapitalFlow();
        assertEq(book.flowNonce(), 1);
    }

    function test_onKill_onlyMandate() public {
        vm.expectRevert(Book.NotMandate.selector);
        book.onKill("X");
        vm.expectEmit(true, false, false, true, address(book));
        emit IBook.Killed(BOOK_ID, bytes32("RISK"));
        mandate.kill("RISK");
        (bytes32 reason, uint64 at) = book.lastKill();
        assertEq(reason, bytes32("RISK"));
        assertEq(at, block.timestamp);
    }

    function test_trancheHooks_access() public {
        vm.expectRevert(Book.NotTranche.selector);
        book.onJuniorRedeemRequested(sponsor);
        vm.prank(address(senior));
        vm.expectRevert(Book.NotTranche.selector);
        book.onJuniorRedeemRequested(sponsor);
        vm.expectRevert(Book.NotTranche.selector);
        book.onRetiredRedeem(1, 1);
        vm.prank(address(senior));
        vm.expectRevert(abi.encodeWithSelector(Book.BadState.selector, BRTypes.BookState.Subscription));
        book.onRetiredRedeem(1, 1);
    }

    // =========================================================================================
    // sponsor skin
    // =========================================================================================

    function test_sponsorBelowSkin_onRedeem_neverGated() public {
        _goLive();
        vm.expectEmit(true, false, false, true, address(book));
        emit IBook.SponsorBelowSkin(BOOK_ID, 2000e6, 30_000e6);
        vm.prank(sponsor);
        uint256 rid = junior.requestRedeem(8000e6, sponsor, sponsor); // 2k / 30k < 10%
        assertTrue(book.sponsorAbandoned());
        assertEq(junior.pendingRedeemRequest(rid, sponsor), 8000e6); // the request itself went through
    }

    function test_sponsorAboveSkin_noFlag() public {
        _goLive();
        vm.prank(sponsor);
        junior.requestRedeem(6000e6, sponsor, sponsor); // 4k / 30k
        assertFalse(book.sponsorAbandoned());
    }

    function test_sponsorBelowSkin_viaTransfer() public {
        _goLive();
        vm.prank(sponsor);
        junior.transfer(dave, 9000e6);
        assertTrue(book.sponsorAbandoned());
    }

    function test_sponsorSkin_countsUnclaimedAllocation() public {
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        // sponsor has not claimed its 10k allocation; a 10k gift then outflow of 0 leaves it at skin
        junior.claimAllocation(carol);
        vm.prank(carol);
        junior.transfer(sponsor, 1000e6);
        vm.prank(sponsor);
        junior.transfer(dave, 1000e6); // sponsor: 0 balance + 10k unclaimed = 33%
        assertFalse(book.sponsorAbandoned());
    }

    function test_sponsorSkin_notCheckedAfterLive() public {
        _goLive();
        charterC.retire(BOOK_ID);
        vm.prank(sponsor);
        junior.requestRedeem(10_000e6, sponsor, sponsor);
        assertFalse(book.sponsorAbandoned());
    }

    // =========================================================================================
    // top-ups
    // =========================================================================================

    function test_openTopUp_access_and_validation() public {
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(Book.BadState.selector, BRTypes.BookState.Subscription));
        book.openTopUp(600, 1, 1);
        _goLive();
        vm.expectRevert(Book.NotSponsor.selector);
        book.openTopUp(600, 1, 1);
        vm.startPrank(sponsor);
        vm.expectRevert(Book.BadTopUp.selector);
        book.openTopUp(0, 1, 1);
        vm.expectRevert(Book.BadTopUp.selector);
        book.openTopUp(uint32(30 days + 1), 1, 1);
        vm.expectRevert(Book.BadTopUp.selector);
        book.openTopUp(600, 0, 0);
        vm.stopPrank();

        cfg.setNewBooksPaused(true);
        vm.prank(sponsor);
        vm.expectRevert(Book.NewBooksPaused.selector);
        book.openTopUp(600, 1, 1);
        cfg.setNewBooksPaused(false);

        vm.prank(sponsor);
        book.openTopUp(600, 20_000e6, 10_000e6);
        (bool open, uint64 endsAt, uint128 sc, uint128 jc) = book.topUp();
        assertTrue(open);
        assertEq(endsAt, block.timestamp + 600);
        assertEq(sc, 20_000e6);
        assertEq(jc, 10_000e6);
        assertTrue(senior.depositsOpen());
        assertEq(senior.currentRound(), 1);
        vm.prank(sponsor);
        vm.expectRevert(Book.TopUpActive.selector);
        book.openTopUp(600, 1, 1);
    }

    function test_topUp_settlesAtFirstMarkAfterEnd() public {
        _goLive();
        vm.prank(sponsor);
        book.openTopUp(600, 20_000e6, 10_000e6);
        (, uint64 endsAt,,) = book.topUp();
        _deposit(senior, dave, 30_000e6); // oversubscribed vs 20k capacity
        _deposit(junior, eve, 10_000e6);

        _markWithPnl(0); // period ends before the round end: not settled
        assertTrue(book.lastMarkPeriodEnd() < endsAt);
        (bool open,,,) = book.topUp();
        assertTrue(open);

        vm.warp(endsAt);
        vm.expectRevert(ITranche.DepositsClosed.selector);
        senior.deposit(1, dave);

        while (book.lastMarkPeriodEnd() < endsAt) {
            _markWithPnl(0);
        }
        (open,,,) = book.topUp();
        assertFalse(open);
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(j, 40_000e6);
        assertEq(s, 90_000e6); // room = 40k*7/3 - 70k = 23.3k > 20k capacity
        (uint256 shares, uint256 refund) = senior.claimAllocation(dave);
        assertEq(shares, 20_000e6);
        assertEq(refund, 10_000e6);
        (shares, refund) = junior.claimAllocation(eve);
        assertEq(shares, 10_000e6);
        assertEq(refund, 0);
        assertEq(vault.idle(), 30_000e6);
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
    }

    function test_topUp_seniorCapBinds() public {
        _goLive();
        vm.prank(sponsor);
        book.openTopUp(600, 50_000e6, 1000e6);
        _deposit(senior, dave, 50_000e6);
        vm.warp(block.timestamp + 600);
        _markWithPnl(0);
        _markWithPnl(0);
        (bool open,,,) = book.topUp();
        assertFalse(open);
        (uint256 s,) = book.trancheNav();
        assertEq(s, 70_000e6); // 30k * 7/3 = 70k: no room
        (uint256 shares, uint256 refund) = senior.claimAllocation(dave);
        assertEq(shares, 0);
        assertEq(refund, 50_000e6);
    }

    function test_topUp_atLossPrice_mintsMoreShares() public {
        _goLive();
        vm.prank(sponsor);
        book.openTopUp(600, 0, 10_000e6);
        _deposit(junior, eve, 10_000e6);
        vm.warp(block.timestamp + 600);
        _markWithPnl(-6000e6); // J 24k / 30k shares -> 0.8
        while (junior.roundInfo(1).settled == false) {
            _markWithPnl(0);
        }
        uint256 price = junior.roundInfo(1).sharesMinted;
        assertEq(price, uint256(10_000e6) * WAD / (uint256(24_000e6) * WAD / 30_000e6));
        (uint256 shares,) = junior.claimAllocation(eve);
        assertEq(shares, 12_500e6);
    }

    function test_topUp_wipedTranche_acceptsNothing() public {
        _goLive();
        vm.prank(sponsor);
        book.openTopUp(600, 0, 10_000e6);
        _deposit(junior, eve, 10_000e6);
        vm.warp(block.timestamp + 600);
        _markWithPnl(-35_000e6); // J = 0 with supply 30k -> price 0
        while (!junior.roundInfo(1).settled) {
            _markWithPnl(0);
        }
        (uint256 shares, uint256 refund) = junior.claimAllocation(eve);
        assertEq(shares, 0);
        assertEq(refund, 10_000e6);
    }

    function test_topUp_nextRoundAutoPushesOldAllocation() public {
        _goLive();
        vm.prank(sponsor);
        book.openTopUp(600, 0, 5000e6);
        _deposit(junior, eve, 5000e6);
        vm.warp(block.timestamp + 600);
        _markWithPnl(0);
        _markWithPnl(0);
        assertTrue(junior.roundInfo(1).settled);
        vm.prank(sponsor);
        book.openTopUp(600, 0, 5000e6);
        _deposit(junior, eve, 1000e6); // pushes round-1 shares first
        assertEq(junior.balanceOf(eve), 5000e6);
        assertEq(junior.committedOf(eve), 1000e6);
    }

    // =========================================================================================
    // retirement
    // =========================================================================================

    function test_retire_onlyCharter_and_state() public {
        vm.expectRevert(Book.NotCharter.selector);
        book.retire();
        vm.expectRevert(abi.encodeWithSelector(Book.BadState.selector, BRTypes.BookState.Subscription));
        charterC.retire(BOOK_ID);
        _goLive();
        vm.expectEmit(true, false, false, true, address(book));
        emit IBook.Retiring(BOOK_ID);
        charterC.retire(BOOK_ID);
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Retiring));
        // reduce-only wind-down: keys stay so the desk can flatten (no kill)
        assertTrue(mandate.retiring());
        assertFalse(mandate.killed());
        vm.expectRevert(abi.encodeWithSelector(Book.BadState.selector, BRTypes.BookState.Retiring));
        charterC.retire(BOOK_ID);
    }

    function test_retire_alreadyKilled_noSecondKill() public {
        _goLive();
        mandate.kill("RISK");
        charterC.retire(BOOK_ID);
        assertEq(mandate.killCount(), 1);
    }

    function test_retire_cancelsOpenTopUp() public {
        _goLive();
        vm.prank(sponsor);
        book.openTopUp(600, 10_000e6, 10_000e6);
        _deposit(junior, eve, 4000e6);
        charterC.retire(BOOK_ID);
        (bool open,,,) = book.topUp();
        assertFalse(open);
        assertTrue(junior.roundInfo(1).cancelled);
        assertEq(junior.claimCancelledRefund(eve), 4000e6);
    }

    function test_finalizeRetirement_conditions() public {
        _goLive();
        vm.expectRevert(abi.encodeWithSelector(Book.BadState.selector, BRTypes.BookState.Live));
        book.finalizeRetirement();
        _markWithPnl(0);
        charterC.retire(BOOK_ID);
        // no mark applied while Retiring yet (the Live mark does not count)
        _recall(100_000e6);
        vm.expectRevert(Book.RetirementNotReady.selector);
        book.finalizeRetirement();

        // mark while Retiring with value still deployed
        _markWithPnl(0);
        assertEq(adapter.value(), 0);
        // capital flow after the zero-deployed mark
        vm.prank(address(desk));
        vault.notifyCapitalFlow();
        vm.expectRevert(Book.RetirementNotReady.selector);
        book.finalizeRetirement();

        _markWithPnl(0);
        book.finalizeRetirement();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Retired));
        assertTrue(charterC.retired(BOOK_ID));
        vm.expectRevert(abi.encodeWithSelector(Book.BadState.selector, BRTypes.BookState.Retired));
        book.applyMark(1);
    }

    function test_finalizeRetirement_deployedNonZero_reverts() public {
        _goLive();
        charterC.retire(BOOK_ID);
        _markWithPnl(0); // 100k still deployed
        vm.expectRevert(Book.RetirementNotReady.selector);
        book.finalizeRetirement();
    }

    function _retireFully() internal {
        charterC.retire(BOOK_ID);
        _recall(adapter.value());
        _markWithPnl(0);
        book.finalizeRetirement();
    }

    function test_retired_pendingBucketsSettleAtFinalPrice() public {
        _goLive();
        _markWithPnl(-6000e6); // J 24k / 30k
        vm.prank(carol);
        uint256 rid = junior.requestRedeem(10_000e6, carol, carol); // notice not reached before finalize
        _retireFully();
        uint256 pJ = book.sharePrice(BRTypes.JUNIOR);
        assertEq(pJ, uint256(24_000e6) * WAD / 30_000e6);
        assertEq(junior.claimableRedeemRequest(rid, carol), 10_000e6);
        vm.prank(carol);
        assertEq(junior.claimRedemption(carol, carol), 10_000e6 * pJ / WAD);
    }

    function test_retired_requestSettlesImmediately() public {
        _goLive();
        _markWithPnl(5000e6); // J 35k / 30k shares
        _retireFully();
        uint256 pS = book.sharePrice(BRTypes.SENIOR);
        uint256 pJ = book.sharePrice(BRTypes.JUNIOR);
        assertEq(pS, WAD);
        assertEq(pJ, uint256(35_000e6) * WAD / 30_000e6);

        vm.prank(alice);
        uint256 rid = senior.requestRedeem(40_000e6, alice, alice);
        assertEq(rid, senior.RETIRED_BUCKET_BASE());
        assertEq(senior.claimableAssets(alice), 40_000e6);
        vm.prank(alice);
        assertEq(senior.claimRedemption(alice, alice), 40_000e6);

        vm.prank(carol);
        junior.requestRedeem(20_000e6, carol, carol);
        vm.prank(carol);
        assertEq(junior.claimRedemption(carol, carol), 20_000e6 * pJ / WAD);

        // everyone out: book holds only dust
        vm.prank(bob);
        senior.requestRedeem(30_000e6, bob, bob);
        senior.claimFor(bob);
        vm.prank(sponsor);
        junior.requestRedeem(10_000e6, sponsor, sponsor);
        junior.claimFor(sponsor);
        assertEq(senior.totalSupply(), 0);
        assertEq(junior.totalSupply(), 0);
        assertLe(vault.idle(), 2);
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
    }

    function test_retired_lateCreditRaisesPrice_newEpoch() public {
        _goLive();
        _retireFully();
        (uint256 p0, uint64 e0) = book.retiredPrice(BRTypes.SENIOR);
        assertEq(p0, WAD);
        assertEq(e0, 0);
        vm.prank(alice);
        senior.requestRedeem(35_000e6, alice, alice); // half of senior at 1.0
        _credit(3500e6, 0); // 35k remaining shares -> +0.1
        (uint256 p1, uint64 e1) = book.retiredPrice(BRTypes.SENIOR);
        assertEq(e1, 1);
        assertEq(p1, 1.1e18);
        vm.prank(bob);
        uint256 rid = senior.requestRedeem(30_000e6, bob, bob);
        assertEq(rid, senior.RETIRED_BUCKET_BASE() + 1);
        assertEq(senior.claimableAssets(bob), 33_000e6);
    }

    function test_settleRetiredBacklog_onlyRetired() public {
        vm.expectRevert(abi.encodeWithSelector(Book.BadState.selector, BRTypes.BookState.Subscription));
        book.settleRetiredBacklog();
        _goLive();
        _retireFully();
        book.settleRetiredBacklog();
    }
}
