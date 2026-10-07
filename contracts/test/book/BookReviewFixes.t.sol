// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Vm} from "forge-std/Vm.sol";

import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IBook} from "../../src/interfaces/IBook.sol";
import {Book} from "../../src/Book.sol";
import {Tranche} from "../../src/Tranche.sol";
import {UnderwritingVault} from "../../src/UnderwritingVault.sol";
import {MMMandate} from "../../src/MMMandate.sol";
import {BookFixture} from "./utils/BookFixture.sol";
import {DeskKeySyncStub, MockVenueAdapter} from "./utils/BookMocks.sol";

/// @notice Regression tests for the adversarial-review findings of the A-book cluster. Every test here
///         uses only the public surface shared by the pre-fix and fixed contracts, so each fails on the
///         pre-fix code and passes on the fix.
///   * senior-impairment-not-scaled-on-redemption
///   * retire-winddown-deadlock
///   * sponsor-skin-griefing-cancel

// =============================================================================================
// seniorImpairment follows the remaining Senior shares
// =============================================================================================

contract BookImpairmentScalingTest is BookFixture {
    function setUp() public {
        _setUpBook();
    }

    /// @dev S 70k / J 30k; a -40k mark wipes J and impairs S by 10k (S 60k on 70k shares, backstop empty);
    ///      alice's 40k Senior shares then settle at 6/7 (unfunded: vault idle is 0).
    function _impairThenRedeem40k() internal {
        _goLive();
        _markWithPnl(-40_000e6);
        assertEq(book.seniorImpairment(), 10_000e6);
        vm.prank(alice);
        senior.requestRedeem(40_000e6, alice, alice);
        _markWithPnl(0);
        assertEq(senior.totalSupply(), 30_000e6);
    }

    function test_impairment_scaledProRataOnSeniorRedemptionAtMark() public {
        _impairThenRedeem40k();
        // the 30k remaining shares carry 3/7 of the impairment (floored)
        assertEq(book.seniorImpairment(), uint256(10_000e6) * 30_000e6 / 70_000e6);
        (uint256 s,) = book.trancheNav();
        // remaining shares + their impairment == par
        assertEq(s + book.seniorImpairment(), 30_000e6);
    }

    function test_impairment_backstopOnlyRestoresRemainingSharesToPar() public {
        _impairThenRedeem40k();
        uint256 imp = book.seniorImpairment();
        usdc.mint(address(backstop), 10_000e6); // refilled by other books' carry
        _markWithPnl(0);
        // the shared backstop is asked only for the remaining shares' loss (~4.29k, not 10k)
        assertEq(book.lastMarkSummary().backstopCovered, imp);
        assertEq(usdc.balanceOf(address(backstop)), 10_000e6 - imp);
        assertEq(book.seniorImpairment(), 0);
        assertEq(book.sharePrice(BRTypes.SENIOR), WAD); // back to par, not above it
        (uint256 lhs, uint256 rhs) = _accountingIdentity();
        assertEq(lhs, rhs);
    }

    function test_impairment_gainRestoresRemainingSharesOnly_restToJunior() public {
        _impairThenRedeem40k();
        uint256 imp = book.seniorImpairment();
        _markWithPnl(10_000e6);
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 30_000e6); // par
        assertEq(j, 10_000e6 - imp); // Junior keeps the gain beyond the remaining impairment
        assertEq(book.seniorImpairment(), 0);
        assertEq(book.sharePrice(BRTypes.SENIOR), WAD);
    }

    function test_impairment_zeroWhenAllSeniorRedeemed_backstopNotAsked() public {
        _goLive();
        _markWithPnl(-40_000e6);
        vm.prank(alice);
        senior.requestRedeem(40_000e6, alice, alice);
        vm.prank(bob);
        senior.requestRedeem(30_000e6, bob, bob);
        _markWithPnl(0);
        assertEq(senior.totalSupply(), 0);
        assertEq(book.seniorImpairment(), 0);
        usdc.mint(address(backstop), 10_000e6);
        _markWithPnl(0);
        assertEq(backstop.covers(), 0, "empty Senior tranche never asks the backstop");
        assertEq(usdc.balanceOf(address(backstop)), 10_000e6);
    }

    function test_impairment_scaledOnRetiredBacklogAndImmediateRedemptions() public {
        _goLive();
        _markWithPnl(-40_000e6); // J 0, S 60k / 70k shares, imp 10k
        charterC.retire(BOOK_ID);
        _recall(adapter.value());
        _markWithPnl(0);
        vm.prank(alice);
        senior.requestRedeem(35_000e6, alice, alice); // pending: settles in the Retired backlog
        book.finalizeRetirement();
        assertEq(senior.totalSupply(), 35_000e6);
        assertEq(book.seniorImpairment(), 5000e6);
        vm.prank(bob);
        senior.requestRedeem(30_000e6, bob, bob); // settles immediately at the final price
        assertEq(book.seniorImpairment(), uint256(5000e6) * 5000e6 / 35_000e6);
        vm.prank(alice);
        senior.requestRedeem(5000e6, alice, alice);
        assertEq(senior.totalSupply(), 0);
        assertEq(book.seniorImpairment(), 0);
    }
}

// =============================================================================================
// retire(): reduce-only wind-down, not a kill
// =============================================================================================

contract BookRetireWindDownTest is BookFixture {
    function setUp() public {
        _setUpBook();
    }

    function test_retire_setsRetiring_doesNotKill() public {
        _goLive();
        charterC.retire(BOOK_ID);
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Retiring));
        assertTrue(mandate.retiring());
        assertEq(mandate.retiringCount(), 1);
        assertFalse(mandate.killed(), "retire must not revoke the desk keys");
        (bytes32 reason,) = book.lastKill();
        assertEq(reason, bytes32(0));
    }

    function test_retire_setRetiringReverts_retireStillSucceeds() public {
        _goLive();
        mandate.setRevertSetRetiring(true);
        vm.expectEmit(true, false, false, true, address(book));
        emit Book.MandateKillFailed(BOOK_ID, bytes32("RETIRE"));
        charterC.retire(BOOK_ID);
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Retiring));
        assertFalse(mandate.killed());
    }

    function test_retiring_drawdownKillStillApplies() public {
        _goLive();
        charterC.retire(BOOK_ID);
        _markWithPnl(-9000e6); // -9% <= -8%
        assertTrue(mandate.killed());
        assertEq(mandate.killReason(), bytes32("DRAWDOWN"));
    }

    function test_retire_alreadyKilled_stillWindsDown() public {
        _goLive();
        mandate.kill("RISK");
        charterC.retire(BOOK_ID);
        assertEq(mandate.killCount(), 1);
        assertTrue(mandate.retiring());
    }
}

/// @notice Real MMMandate behind the real Book: after retire the desk key stays usable for the wind-down
///         (recalls), while every risk-adding move is refused.
contract BookRetireRealMandateTest is BookFixture {
    MMMandate internal realMandate;
    address internal deskKey = makeAddr("deskKey");

    function setUp() public {
        _deployInfra();
        BRTypes.Charter memory c = _defaultCharter();
        senior = Tranche(Clones.clone(address(trancheImpl)));
        junior = Tranche(Clones.clone(address(trancheImpl)));
        vault = UnderwritingVault(Clones.clone(address(vaultImpl)));
        realMandate = MMMandate(Clones.clone(address(new MMMandate())));
        adapter = new MockVenueAdapter(usdc);
        BRTypes.BookComponents memory comps = _components();
        comps.mandate = address(realMandate);
        book = Book(
            address(
                new ERC1967Proxy(address(bookImpl), abi.encodeCall(Book.initialize, (address(cfg), BOOK_ID, c, comps)))
            )
        );
        senior.initialize(address(cfg), BOOK_ID, address(book), BRTypes.SENIOR);
        junior.initialize(address(cfg), BOOK_ID, address(book), BRTypes.JUNIOR);
        vault.initialize(address(cfg), BOOK_ID, address(book));
        adapter.initialize(address(cfg), BOOK_ID, address(book));
        adapter.setVault(address(vault));
        registry.setBook(BOOK_ID, address(book));
        backstop.setVault(address(vault));
        charterC.setBook(BOOK_ID, address(book));
        realMandate.initialize(address(cfg), BOOK_ID, address(book));
        vm.etch(desk, address(new DeskKeySyncStub()).code);
        vm.prank(sponsor);
        realMandate.registerKey(deskKey, sponsor, uint64(block.timestamp + 30 days), 50_000e6);
    }

    function test_retire_realMandate_keysStayActive_reduceOnly() public {
        _goLive();
        assertTrue(realMandate.isActiveKey(deskKey));
        charterC.retire(BOOK_ID);

        assertFalse(realMandate.killed(), "not killed");
        assertTrue(realMandate.retiring(), "retiring");
        assertTrue(realMandate.isActiveKey(deskKey), "desk key still usable for the wind-down");
        // wind-down moves stay open to the key ...
        realMandate.checkInventoryMove(deskKey, false, BRTypes.ACCOUNT_MM, 10_000e6);
        realMandate.checkInventoryMove(deskKey, false, BRTypes.ACCOUNT_IF, 10_000e6);
        // ... risk-adding ones are refused
        vm.expectRevert(MMMandate.MandateRetiring.selector);
        realMandate.checkInventoryMove(deskKey, true, BRTypes.ACCOUNT_MM, 1);
        vm.expectRevert(MMMandate.MandateRetiring.selector);
        realMandate.checkFundDesk(deskKey, 1);
        // a new key can still be registered by the sponsor (not killed)
        address k2 = makeAddr("deskKey2");
        vm.prank(sponsor);
        realMandate.registerKey(k2, sponsor, uint64(block.timestamp + 1 days), 50_000e6);
        assertTrue(realMandate.isActiveKey(k2));
    }

    function test_retire_realMandate_drawdownKillStillRevokes() public {
        _goLive();
        charterC.retire(BOOK_ID);
        _markWithPnl(-9000e6);
        assertTrue(realMandate.killed());
        assertEq(realMandate.killReason(), bytes32("DRAWDOWN"));
        assertFalse(realMandate.isActiveKey(deskKey));
        (bytes32 reason,) = book.lastKill();
        assertEq(reason, bytes32("DRAWDOWN"));
    }
}

// =============================================================================================
// sponsor skin: outside Junior over-commitment cannot cancel the book
// =============================================================================================

contract BookSponsorPriorityTest is BookFixture {
    uint256 internal constant BPS = 10_000;

    function setUp() public {
        _setUpBook();
    }

    function _cancelReason() internal returns (bytes32 reason, bool cancelled) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(book) && logs[i].topics[0] == IBook.BookCancelled.selector) {
                return (abi.decode(logs[i].data, (bytes32)), true);
            }
        }
    }

    /// @dev The review scenario: sponsor 10k + carol 20k Junior, alice 70k Senior; eve commits 91k Junior
    ///      in the last block before the window ends (sponsor 10k / 121k < 10% of committed Junior).
    function test_sponsorSkin_lastBlockOverCommit_cannotCancel() public {
        _deposit(senior, alice, 70_000e6);
        _deposit(junior, sponsor, 10_000e6);
        _deposit(junior, carol, 20_000e6);
        vm.warp(book.subscriptionEnds() - 1);
        _deposit(junior, eve, 91_000e6);
        vm.warp(book.subscriptionEnds());
        book.closeWindow();

        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live), "griefing commitment cannot cancel");
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 70_000e6);
        assertEq(j, 30_000e6);

        // sponsor allocated first, the rest pro-rata over the other Junior commitments (carol + eve)
        (uint256 sh, uint256 rf) = junior.claimAllocation(sponsor);
        assertEq(sh, 10_000e6);
        assertEq(rf, 0);
        (uint256 shC, uint256 rfC) = junior.claimAllocation(carol);
        assertEq(shC, uint256(20_000e6) * 20_000e6 / 111_000e6);
        assertEq(rfC, uint256(20_000e6) * 91_000e6 / 111_000e6);
        (uint256 shE, uint256 rfE) = junior.claimAllocation(eve);
        assertEq(shE, uint256(91_000e6) * 20_000e6 / 111_000e6);
        assertEq(rfE, uint256(91_000e6) * 91_000e6 / 111_000e6);

        // conservation: never more than allocated / committed; dust stays in the tranche
        assertLe(sh + shC + shE, j);
        assertGe(sh + shC + shE + 2, j);
        assertLe(rf + rfC + rfE, 121_000e6 - j);
        assertEq(usdc.balanceOf(address(junior)), (121_000e6 - j) - (rf + rfC + rfE));
        // the sponsor holds >= 10% of Junior: no abandonment flag on its first outflow
        assertGe(junior.balanceOf(sponsor) * BPS, junior.totalSupply() * 1000);
        vm.prank(sponsor);
        junior.transfer(dave, 1);
        assertFalse(book.sponsorAbandoned());
    }

    /// @dev Junior eligible for allocation is capped at 10x the sponsor's commitment; the excess is
    ///      refunded instead of cancelling the book, and the Senior cap follows the capped Junior.
    function test_sponsorSkin_capBindsBelowRaise_excessRefunded() public {
        _deposit(senior, alice, 70_000e6);
        _deposit(junior, sponsor, 2000e6);
        _deposit(junior, carol, 50_000e6);
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(j, 20_000e6); // 10x the sponsor
        assertEq(s, uint256(20_000e6) * 7000 / 3000); // Senior <= 70% of capital
        (uint256 sh, uint256 rf) = junior.claimAllocation(sponsor);
        assertEq(sh, 2000e6);
        assertEq(rf, 0);
        (sh, rf) = junior.claimAllocation(carol);
        assertEq(sh, 18_000e6);
        assertEq(rf, 32_000e6);
        assertEq(usdc.balanceOf(address(junior)), 0);
    }

    function testFuzz_juniorWindow_sponsorPriority_neverSkinCancel_conserves(
        uint256 p,
        uint256 c1,
        uint256 c2,
        uint256 c3,
        uint256 sC
    ) public {
        p = bound(p, 1e6, 200_000e6);
        c1 = bound(c1, 0, 250_000e6);
        c2 = bound(c2, 0, 250_000e6);
        c3 = bound(c3, 0, 250_000e6);
        sC = bound(sC, 0, 250_000e6);
        if (sC > 0) _deposit(senior, alice, sC);
        _deposit(junior, sponsor, p);
        if (c1 > 0) _deposit(junior, carol, c1);
        if (c2 > 0) _deposit(junior, dave, c2);
        if (c3 > 0) _deposit(junior, eve, c3);
        uint256 jC = p + c1 + c2 + c3;

        vm.warp(book.subscriptionEnds());
        vm.recordLogs();
        book.closeWindow();
        (bytes32 reason, bool cancelled) = _cancelReason();
        if (cancelled) {
            assertTrue(reason != bytes32("SPONSOR_SKIN"), "a committed sponsor never fails the skin check");
            return;
        }
        _assertJuniorClaims([p, c1, c2, c3], jC);
    }

    function _assertJuniorClaims(uint256[4] memory commit, uint256 jC) internal {
        (, uint256 j) = book.trancheNav();
        uint256 p = commit[0];
        assertLe(j, jC);
        assertLe(j, p * 10);
        address[4] memory who = [sponsor, carol, dave, eve];
        uint256 shares;
        uint256 refunds;
        for (uint256 i = 0; i < 4; i++) {
            (uint256 sh, uint256 rf) = junior.claimAllocation(who[i]);
            assertLe(sh + rf, commit[i], "never more than committed");
            if (i == 0) {
                assertEq(sh, p < j ? p : j, "sponsor allocated first");
                assertGe(sh * BPS, j * 1000, "sponsor holds >= 10% of allocated Junior");
            }
            shares += sh;
            refunds += rf;
        }
        assertLe(shares, j, "shares <= allocated");
        assertGe(shares + 3, j, "<= 1 unit of dust per non-sponsor wallet");
        assertLe(refunds, jC - j, "refunds <= unallocated");
        // A1-05: the round is fully claimed, so its j - shares rounding dust was burned from escrow
        assertEq(junior.balanceOf(address(junior)), 0, "rounding dust burned");
        assertEq(junior.totalSupply(), shares);
        assertEq(usdc.balanceOf(address(junior)), (jC - j) - refunds);
    }
}
