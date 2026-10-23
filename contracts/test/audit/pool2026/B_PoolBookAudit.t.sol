// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {BRTypes} from "../../../src/interfaces/BRTypes.sol";
import {IBook} from "../../../src/interfaces/IBook.sol";
import {IInsurancePool} from "../../../src/interfaces/IInsurancePool.sol";
import {PoolBookFixture} from "../../pool/utils/PoolBookFixture.sol";

/// @notice Audit 2026-10-23, scope B (how books use the InsurancePool): the PoCs of
///         .superpowers/sdd/2026-10-23-pool-audit/audit-B.md turned into regression tests. Each failed on the audited
///         code (main 3099919, where the PoC assertions held) and passes on the fix: the book's explicit insurance
///         ledger (Book.insuranceLedger: Senior's IF impairment, Junior's IF losses, the Backstop cover held, the IF draw)
///         replaces the per-mark reconstruction from NAV. Real Book / BookLogic / Tranche / UnderwritingVault /
///         RevenueRouter / InsurancePool; venue, backstop, registry and charter are the test mocks (PoolBookFixture).
///         Default book: S 52.5k, J 22.5k raised (MM 75k), IF 25k from the pool.
contract B_PoolBookAuditTest is PoolBookFixture {
    function setUp() public {
        _setUpPoolBook();
    }

    function _ledger() internal view returns (uint256 impIf, uint256 juniorIfLoss, uint256 coverHeld, uint256 draw) {
        return book.insuranceLedger();
    }

    // =========================================================================================================
    // B-H1 (path a): repaying the debt no longer lifts the cover cap: Senior's IF impairment is a ledger entry
    // =========================================================================================================

    /// @notice Was: after the debt was repaid the outstanding draw read 0, the cap was lifted and the Backstop covered
    ///         Senior's 2.5k IF impairment. Now that impairment is booked as insurance debt and is never covered.
    function test_B_H1a_repaidDebt_neverLiftsTheCap() public {
        _goLivePool();
        usdc.mint(address(backstop), 1_000_000e6);
        uint256 bal0 = usdc.balanceOf(address(backstop));
        venue.setIfEquity(0); // traders' bad debt draws the 25k IF: Junior 22.5k gone, Senior impaired 2.5k
        _applyPoolMark();
        assertEq(book.seniorImpairment(), 2_500e6);
        (uint256 impIf, uint256 jIf,, uint256 draw) = _ledger();
        assertEq(impIf, 2_500e6, "Senior's IF impairment, booked");
        assertEq(jIf, 22_500e6, "Junior's IF loss, booked");
        assertEq(draw, 25_000e6);

        charterC.retire(BOOK_ID);
        vm.startPrank(keeper);
        vault.recall(BRTypes.ACCOUNT_IF, 1); // due
        vault.recall(BRTypes.ACCOUNT_MM, 30_000e6); // part of the MM back
        vm.stopPrank();
        book.fundClaims(); // anyone: the pool is repaid its 25k at once
        (uint256 debt,,) = _debt();
        assertEq(debt, 0, "pool repaid in full");

        _applyPoolMark(); // an ordinary wind-down mark (45k of MM still deployed)
        assertEq(usdc.balanceOf(address(backstop)), bal0, "the Backstop pays nothing of the insurance debt");
        assertEq(book.seniorImpairment(), 2_500e6, "Senior keeps its IF impairment");
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 50_000e6);
        assertEq(j, 0);
    }

    // =========================================================================================================
    // B-H1 (path b): a gain repays the Backstop before it restores Senior's IF impairment
    // =========================================================================================================

    /// @notice Reference: the IF draw alone. Junior absorbs 22.5k, Senior keeps a 2.5k impairment, the Backstop pays 0.
    function test_B_H1b_reference_ifDrawAlone_seniorKeepsItsImpairment() public {
        _goLivePool();
        usdc.mint(address(backstop), 1_000_000e6);
        uint256 bal0 = usdc.balanceOf(address(backstop));
        venue.setIfEquity(0);
        _applyPoolMark();
        _applyPoolMark();
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(j, 0);
        assertEq(s, 50_000e6);
        assertEq(book.seniorImpairment(), 2_500e6, "Senior's share of the IF draw: never covered (N-1)");
        assertEq(usdc.balanceOf(address(backstop)), bal0);
    }

    /// @notice Was: the MM dip's recovery restored Senior's whole impairment (its IF part included) before it repaid the
    ///         Backstop, which ended 2.5k short for good. Now the cover is repaid in full first and Senior ends exactly
    ///         as in the reference (50k, its 2.5k IF impairment kept): the Backstop funded nothing of the debt.
    function test_B_H1b_mmRoundTrip_backstopRepaidBeforeSeniorsIfImpairment() public {
        _goLivePool();
        usdc.mint(address(backstop), 1_000_000e6);
        uint256 bal0 = usdc.balanceOf(address(backstop));

        venue.setIfEquity(0); // mark 1: the IF draw (Junior 22.5k, Senior 2.5k, no cover)
        _applyPoolMark();
        venue.setMmValue(30_000e6); // mark 2: the MM is 45k down (non-IF loss): Junior's 22.5k IF loss stands in front
        _applyPoolMark();
        assertEq(bal0 - usdc.balanceOf(address(backstop)), 22_500e6, "cover as if the IF had never been drawn");
        (uint256 impIf,, uint256 cover,) = _ledger();
        assertEq(impIf, 25_000e6, "the 22.5k Junior would have absorbed is Senior's insurance-debt loss");
        assertEq(cover, 22_500e6);

        venue.setMmValue(75_000e6); // mark 3: the MM recovers the 45k: the Backstop's 22.5k first
        _applyPoolMark();
        assertEq(usdc.balanceOf(address(backstop)), bal0, "the Backstop is repaid in full");
        (uint256 bsDebt, uint256 bsPayable) = book.backstopDebt();
        assertEq(bsDebt, 0);
        assertEq(bsPayable, 0);
        assertEq(book.seniorImpairment(), 2_500e6, "Senior keeps its share of the IF draw");
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 50_000e6, "== the reference");
        assertEq(j, 0);

        charterC.retire(BOOK_ID);
        vm.startPrank(keeper);
        vault.recall(BRTypes.ACCOUNT_MM, 75_000e6);
        vault.recall(BRTypes.ACCOUNT_IF, 1); // the IF account is empty; the recall makes the debt due
        vm.stopPrank();
        _applyPoolMark(); // deployed 0
        book.finalizeRetirement();
        IInsurancePool.BookPosition memory pos = pool.bookPosition(BOOK_ID);
        assertEq(pos.allocation, 0, "the pool was repaid in full");
        assertEq(pool.firstLossAssets(), POOL_FIRST_LOSS, "the pool lost nothing");
        (s,) = book.trancheNav();
        assertEq(s, 50_000e6, "Senior bore its 2.5k of the IF draw");
        assertEq(usdc.balanceOf(address(backstop)), bal0, "the Backstop funded none of it");
    }

    // =========================================================================================================
    // B-M1: settled (unfunded) redemption cash and the Backstop cover are never the book's own capital
    // =========================================================================================================

    /// @notice Was: alice's unfunded 30k counted as own capital, the pool kept a 25k claim and was repaid 25k of Backstop
    ///         cover at wind-down (then the Backstop also covered Senior's IF impairment: 75k in all). Now the cover
    ///         follows the Senior shares (22.5k left with bob), the drained IF is the pool's provisional loss, the pool is
    ///         repaid nothing (the book has no own capital), alice is paid in full and bob keeps his cover.
    function test_B_M1_unfundedRedemptionAndCover_neverRepayThePool() public {
        _goLivePool();
        usdc.mint(address(backstop), 1_000_000e6);
        uint256 bal0 = usdc.balanceOf(address(backstop));

        venue.setMmValue(0); // mark 1: the MM lost its 75k; Senior's 52.5k covered
        _applyPoolMark();
        assertEq(bal0 - usdc.balanceOf(address(backstop)), 52_500e6);
        vm.prank(desk); // the desk puts the cash back to work (mandate-checked in production)
        vault.deployToVenue(BRTypes.ACCOUNT_MM, 52_500e6);
        vm.prank(alice);
        senior.requestRedeem(30_000e6, alice, alice); // alice: 30k of the 52.5k Senior shares
        _applyPoolMark(); // mark 2: no P&L; alice settles at 1.0, unfunded (idle 0)
        assertEq(book.unfundedOf(BRTypes.SENIOR), 30_000e6);
        (,, uint256 cover,) = _ledger();
        assertEq(cover, 22_500e6, "alice took her part of the cover with her (B-L3)");

        venue.setIfEquity(0); // mark 3: traders' bad debt drains the 25k IF
        _applyPoolMark();
        (, uint256 value,) = _debt();
        assertEq(value, 0, "no own capital: the drain is the pool's (provisional) loss");
        assertEq(pool.firstLossAssets(), POOL_FIRST_LOSS - 25_000e6, "shown in the pool's share price at once");
        (uint256 s,) = book.trancheNav();
        assertEq(s, 22_500e6, "bob keeps his cover");

        charterC.retire(BOOK_ID);
        vm.startPrank(keeper);
        vault.recall(BRTypes.ACCOUNT_MM, 52_500e6);
        vault.recall(BRTypes.ACCOUNT_IF, 1); // due
        vm.stopPrank();
        (uint256 poolCash0,,,,) = pool.ledger();
        book.fundClaims();
        (uint256 poolCash1,,,,) = pool.ledger();
        assertEq(poolCash1, poolCash0, "the pool is repaid nothing: neither alice's cash nor bob's cover");
        assertEq(book.unfundedOf(BRTypes.SENIOR), 0, "alice is paid in full");
        _applyPoolMark();
        book.finalizeRetirement();
        assertEq(pool.bookPosition(BOOK_ID).allocation, 25_000e6, "written off: the pool's tail loss");
        assertEq(bal0 - usdc.balanceOf(address(backstop)), 52_500e6, "the Backstop paid the MM loss only");
        (s,) = book.trancheNav();
        assertEq(s, 22_500e6);
    }

    // =========================================================================================================
    // B-M2: a pool-funded window needs tranche capital of at least the pool's minimum share of the IF (50%)
    // =========================================================================================================

    /// @notice Was: 1 USDC of Junior drew the full 25k IF. Now the window is cancelled (UNDERCAPITALISED): the raise is
    ///         below 50% of the IF and the tranches cannot fund the IF themselves either.
    function test_B_M2_undercapitalisedPoolBook_cancelled() public {
        _deposit(junior, sponsor, 1e6); // the only commitment: 1 USDC (charter MM target 75k)
        vm.warp(book.subscriptionEnds());
        vm.expectEmit(true, false, false, true, address(book));
        emit IBook.BookCancelled(BOOK_ID, "UNDERCAPITALISED");
        book.closeWindow();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Cancelled), "commitments refundable 1:1");
        assertEq(pool.bookPosition(BOOK_ID).allocation, 0, "the pool lent nothing");
    }

    /// @notice At the minimum (12.5k raised for a 25k IF) the pool funds it; the tranches stand in front of half of it.
    function test_B_M2_atTheMinimumOwnCapital_poolFunds() public {
        _deposit(junior, sponsor, 12_500e6);
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));
        assertEq(pool.bookPosition(BOOK_ID).allocation, 25_000e6);
    }

    /// @notice Same commitments on the same charter funded the old way: the window fails IF_UNFUNDED.
    function test_B_M2_reference_oldWayCancelsIfUnfunded() public {
        _deployPoolBook(_defaultCharter());
        _deposit(junior, sponsor, 1e6);
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Cancelled));
    }

    // =========================================================================================================
    // B-L1: finalizeRetirement keeps the ledger's claim (never a revaluation on live idle the Retired prices count again)
    // =========================================================================================================

    /// @notice Was: a fee landing between the last mark and finalizeRetirement was credited to Senior AND recovered the
    ///         pool's 1k shortfall, so bob's last 1k could never be funded. Now the fee restores the pool's claim first
    ///         (B-L2), finalize repays exactly that, and every Retired redemption is funded.
    function test_B_L1_feeBetweenLastMarkAndFinalize_countedOnce() public {
        _goLivePool();
        venue.setIfEquity(0);
        venue.setMmValue(24_000e6); // own capital 24k for a 25k debt: exhausted, 1k provisional shortfall
        _applyPoolMark();
        charterC.retire(BOOK_ID);
        vm.startPrank(keeper);
        vault.recall(BRTypes.ACCOUNT_MM, 24_000e6);
        vault.recall(BRTypes.ACCOUNT_IF, 1);
        vm.stopPrank();
        _applyPoolMark(); // deployed 0; the pool repaid 24k, 1k still owed (provisional)
        (uint256 debt,,) = _debt();
        assertEq(debt, 1_000e6);

        _distribute(10_000e6, 0); // 7,920 credited: the pool's 1k first, then Senior
        (uint256 s,) = book.trancheNav();
        assertEq(s, 6_920e6, "the fee restored the pool's claim before Senior");
        book.finalizeRetirement();
        (debt,,) = _debt();
        assertEq(debt, 0, "the pool recovered its shortfall from the fee, once");
        assertEq(vault.idle(), 6_920e6, "Senior NAV == the vault");

        vm.prank(alice);
        senior.requestRedeem(30_000e6, alice, alice); // settles immediately at the Retired price
        vm.prank(bob);
        senior.requestRedeem(22_500e6, bob, bob);
        assertEq(book.unfundedOf(BRTypes.SENIOR), 0, "every Retired redemption is funded");
    }

    // =========================================================================================================
    // B-L2: an exhausted book's fee flow restores the pool's claim first, never repays the Backstop from Senior's cover
    // =========================================================================================================

    /// @notice Was: the Junior residual was booked as a Backstop repayment while the next mark gave the whole fee to the
    ///         pool, so Senior's cover repaid the Backstop (3,168). Now the fee goes to the pool's claim at once and
    ///         Senior keeps its whole cover.
    function test_B_L2_exhaustedBook_feeRestoresThePool_seniorKeepsItsCover() public {
        _goLivePool();
        usdc.mint(address(backstop), 1_000_000e6);
        uint256 bal0 = usdc.balanceOf(address(backstop));
        venue.setMmValue(0);
        _applyPoolMark(); // cover 52.5k
        venue.setIfEquity(0);
        _applyPoolMark(); // exhausted: claim 0, Senior keeps its cover
        (, uint256 value,) = _debt();
        assertEq(value, 0);

        _distribute(10_000e6, 0); // premium 1,200, carry 880, 7,920 credited -> the pool's claim
        (, value,) = _debt();
        assertEq(value, 7_920e6, "the pool recovers the whole fee at once");
        _applyPoolMark();
        (, value,) = _debt();
        assertEq(value, 7_920e6);
        (uint256 s,) = book.trancheNav();
        assertEq(s, 52_500e6, "Senior keeps its whole cover");
        assertEq(bal0 - usdc.balanceOf(address(backstop)), 52_500e6, "no repayment out of the cover");
    }

    // =========================================================================================================
    // B-L3: the cover follows the Senior shares; a Senior top-up is never counted as cover
    // =========================================================================================================

    /// @notice (No PoC in the audit.) Half of Senior redeems after the cover: half the cover leaves with it, and on a
    ///         later exhaustion the pool's claim is the book's own capital, not understated by cover that left.
    function test_B_L3_coverScaledOnSeniorBurns() public {
        _goLivePool();
        usdc.mint(address(backstop), 1_000_000e6);
        venue.setMmValue(10_000e6); // MM -65k: Junior 22.5k, Senior 42.5k covered
        _applyPoolMark();
        (,, uint256 cover,) = _ledger();
        assertEq(cover, 42_500e6);
        vm.prank(alice);
        senior.requestRedeem(26_250e6, alice, alice); // half of Senior
        _applyPoolMark();
        (,, cover,) = _ledger();
        assertEq(cover, 21_250e6, "half the cover left with half the shares");
    }
}
