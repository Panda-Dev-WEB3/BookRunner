// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {BRTypes} from "../../src/interfaces/BRTypes.sol";
import {IBook} from "../../src/interfaces/IBook.sol";
import {IInsurancePool} from "../../src/interfaces/IInsurancePool.sol";
import {Book} from "../../src/Book.sol";
import {UnderwritingVault} from "../../src/UnderwritingVault.sol";
import {RevenueRouter} from "../../src/RevenueRouter.sol";
import {InsurancePool} from "../../src/InsurancePool.sol";
import {PoolBookFixture} from "./utils/PoolBookFixture.sol";

/// @notice A pool-funded book end to end (POOL-7, POOL-8, CAP-16, docs/INVARIANTS.md): the window raises only the MM
///         inventory, the pool funds the IF, the IF never counts in Senior / Junior, traders' bad debt drawn from it is
///         the pool's, the premium comes off gross fee flow first, retirement returns the IF to the pool first. A
///         book funded the old way is unchanged.
contract PoolBookTest is PoolBookFixture {
    function setUp() public {
        _setUpPoolBook();
    }

    // ------------------------------------------------------------------ window

    function test_closeWindow_raisesOnlyMm_poolFundsIf() public {
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        vm.expectEmit(true, true, false, true, address(book));
        emit Book.InsuranceFunded(BOOK_ID, address(pool), 25_000e6);
        vm.expectEmit(true, false, false, true, address(book));
        emit IBook.CapitalDeployed(BOOK_ID, 25_000e6, 75_000e6);
        book.closeWindow();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Live));
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 52_500e6, "Senior: 70% of the 75k MM raise");
        assertEq(j, 22_500e6);
        assertEq(venue.ifEquity(), 25_000e6, "IF from the pool");
        assertEq(venue.mmValue(), 75_000e6, "MM from the tranches");
        assertEq(vault.idle(), 0);
        (address p, uint256 allocation, uint256 claim, bool due) = book.insuranceClaim();
        assertEq(p, address(pool));
        assertEq(book.insurancePool(), address(pool));
        assertEq(allocation, 25_000e6);
        assertEq(claim, 25_000e6);
        assertFalse(due);
        IInsurancePool.BookPosition memory pos = pool.bookPosition(BOOK_ID);
        assertEq(pos.book, address(book));
        assertEq(pos.vault, address(vault));
        assertEq(pos.router, address(rrouter));
        assertEq(pos.claim, 25_000e6);
        assertEq(book.unfundedClaims(), 0, "a claim not yet due is not reserved cash");
    }

    function test_closeWindow_poolCannotFund_reverts_thenCancelStuck() public {
        vm.prank(timelock);
        pool.setParam("marketCapBps", 100); // 1% of 1.1M = 11k < 25k
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        vm.expectRevert(abi.encodeWithSelector(InsurancePool.OverMarketCap.selector, 25_000e6, 11_000e6));
        book.closeWindow();
        vm.warp(uint256(book.subscriptionEnds()) + book.CLOSE_WINDOW_TIMEOUT());
        book.cancelStuckWindow();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Cancelled), "commitments refundable 1:1");
    }

    function test_closeWindow_poolUnset_reverts() public {
        cfg.setInsurancePool(address(0));
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        vm.expectRevert(Book.InsurancePoolUnset.selector);
        book.closeWindow();
    }

    function test_closeWindow_poolAllocationsPaused_reverts() public {
        vm.prank(guardian);
        pool.setPaused(false, true);
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        vm.expectRevert(InsurancePool.AllocationsPaused.selector);
        book.closeWindow();
    }

    // ------------------------------------------------------------------ NAV and bad debt

    function test_nav_excludesPoolIf() public {
        _goLivePool();
        assertEq(book.markedNavPreview(venue.deployedValueUsd()), 75_000e6, "100k deployed - 25k pool claim");
        _applyPoolMark();
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s + j, 75_000e6, "no phantom gain from the pool's IF");
        _identity();
    }

    function test_badDebt_isThePools_bookUnaffected() public {
        _goLivePool();
        uint256 price = pool.convertToAssets(1e12);
        venue.setIfEquity(20_000e6); // traders' bad debt drew 5k from the IF
        uint256 id = _poolMark();
        vm.expectEmit(true, false, false, true, address(book));
        emit Book.InsuranceClaimSynced(BOOK_ID, 25_000e6, 20_000e6, 20_000e6);
        book.applyMark(id);
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 52_500e6, "Senior untouched");
        assertEq(j, 22_500e6, "Junior untouched");
        (uint256 claim,) = _claim();
        assertEq(claim, 20_000e6);
        assertEq(pool.bookPosition(BOOK_ID).claim, 20_000e6);
        assertEq(pool.firstLossAssets(), POOL_FIRST_LOSS - 5_000e6, "first-loss slice absorbed it");
        assertEq(pool.convertToAssets(1e12), price, "depositors untouched while the slice lasts");
        _identity();
    }

    function test_mmLoss_staysWithTheTranches() public {
        _goLivePool();
        venue.setMmValue(65_000e6); // MM trading loss 10k
        _applyPoolMark();
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(j, 12_500e6, "Junior first");
        assertEq(s, 52_500e6);
        assertEq(pool.bookPosition(BOOK_ID).claim, 25_000e6, "pool untouched");
        assertEq(pool.firstLossAssets(), POOL_FIRST_LOSS);
    }

    function test_syncInsurance_permissionless_reachesPoolBeforeMark() public {
        _goLivePool();
        venue.setIfEquity(15_000e6);
        vm.prank(eve);
        book.syncInsurance();
        assertEq(pool.bookPosition(BOOK_ID).claim, 15_000e6);
        assertEq(pool.firstLossAssets(), POOL_FIRST_LOSS - 10_000e6);
        _applyPoolMark();
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s + j, 75_000e6);
    }

    function test_refill_restoresClaim_surplusIsTheBooks() public {
        _goLivePool();
        venue.setIfEquity(18_000e6);
        _applyPoolMark();
        assertEq(pool.firstLossAssets(), POOL_FIRST_LOSS - 7_000e6);
        venue.setIfEquity(27_000e6); // liquidation fees refilled the IF past its allocation
        _applyPoolMark();
        (uint256 claim,) = _claim();
        assertEq(claim, 25_000e6, "restored up to the allocation");
        assertEq(pool.firstLossAssets(), POOL_FIRST_LOSS, "the slice got its loss back");
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s + j, 77_000e6, "the IF surplus above the allocation is book value");
        _identity();
    }

    function test_unreadableAdapter_neverBlocksMarks() public {
        _goLivePool();
        venue.setRevertInsurance(true);
        _applyPoolMark();
        (uint256 claim,) = _claim();
        assertEq(claim, 25_000e6, "claim kept");
    }

    function test_poolRefusesReport_neverBlocksMarks() public {
        _goLivePool();
        venue.setIfEquity(20_000e6);
        vm.mockCallRevert(address(pool), abi.encodeWithSelector(InsurancePool.reportLoss.selector), "down");
        uint256 id = _poolMark();
        vm.expectEmit(true, false, false, true, address(book));
        emit Book.InsuranceSyncFailed(BOOK_ID, 25_000e6, 20_000e6);
        book.applyMark(id);
        (uint256 claim,) = _claim();
        assertEq(claim, 25_000e6, "unchanged until the pool accepts it");
        vm.clearMockedCalls();
        book.syncInsurance();
        (claim,) = _claim();
        assertEq(claim, 20_000e6);
    }

    // ------------------------------------------------------------------ vault rules for a pool-funded IF

    function test_vault_deskCannotMoveThePoolsIf() public {
        _goLivePool();
        usdc.mint(address(vault), 1_000e6);
        vm.prank(desk);
        vm.expectRevert(UnderwritingVault.PoolFundedInsurance.selector);
        vault.deployToVenue(BRTypes.ACCOUNT_IF, 1_000e6);
        vm.prank(desk);
        vm.expectRevert(UnderwritingVault.PoolFundedInsurance.selector);
        vault.recall(BRTypes.ACCOUNT_IF, 1_000e6);
        vm.prank(keeper);
        vm.expectRevert(UnderwritingVault.PoolFundedInsurance.selector);
        vault.recall(BRTypes.ACCOUNT_IF, 1_000e6);
        // the MM account is the book's as before
        vm.prank(desk);
        vault.deployToVenue(BRTypes.ACCOUNT_MM, 1_000e6);
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_MM, 1_000e6);
    }

    function test_onInsuranceRecall_onlyVault() public {
        _goLivePool();
        vm.prank(eve);
        vm.expectRevert(Book.NotVault.selector);
        book.onInsuranceRecall();
    }

    // ------------------------------------------------------------------ premium

    function test_premium_floorFirst_thenSplit() public {
        _goLivePool();
        uint256 flBefore = pool.firstLossAssets();
        uint256 dBefore = pool.totalAssets();
        (address p, uint256 premium, uint256 bps) = rrouter.previewPremium(10_000e6);
        assertEq(p, address(pool));
        assertEq(bps, 1200, "the pool's floor");
        assertEq(premium, 1_200e6);
        usdc.mint(address(rrouter), 10_000e6);
        rrouter.notifySettlement(BRTypes.SRC_ENGINE_FEES, 10_000e6);
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true, address(rrouter));
        emit RevenueRouter.PremiumPaid(BOOK_ID, 77, address(pool), 1_200e6, 1200);
        rrouter.distribute(77, 2_000e6);
        // rest 8,800: expenses capped at 20% = 1,760; carry 10% of 7,040 = 704; Senior 60% of 6,336, Junior the rest
        assertEq(usdc.balanceOf(expenseSink), 1_760e6);
        assertEq(carrySink.carry(), 704e6);
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s, 52_500e6 + 3_801_600_000);
        assertEq(j, 22_500e6 + 2_534_400_000);
        assertEq(pool.firstLossAssets() + pool.totalAssets(), flBefore + dBefore + 1_200e6, "premium in the pool");
        assertEq(rrouter.premiumTotal(), 1_200e6);
    }

    function test_premium_charterAboveFloor() public {
        BRTypes.Charter memory c = _poolCharter();
        c.premiumBps = 2000;
        _deployPoolBook(c);
        _goLivePool();
        (, uint256 premium, uint256 bps) = rrouter.previewPremium(10_000e6);
        assertEq(bps, 2000);
        assertEq(premium, 2_000e6);
        IRevenueRouterAmounts.Amounts memory a = IRevenueRouterAmounts(address(rrouter)).previewSplit(10_000e6, 0);
        assertEq(a.gross, 10_000e6);
        assertEq(a.carry, 800e6, "carry on the 8,000 left after the premium");
    }

    // ------------------------------------------------------------------ retirement

    function test_retirement_returnsIfToPoolFirst() public {
        _goLivePool();
        venue.setIfEquity(21_000e6); // 4k bad debt during Live: the pool's
        _applyPoolMark();
        charterC.retire(BOOK_ID);
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Retiring));
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_IF, 21_000e6);
        (uint256 claim, bool due) = _claim();
        assertTrue(due);
        assertEq(claim, 21_000e6);
        assertEq(book.unfundedClaims(), 21_000e6, "a due claim is reserved cash");
        uint256 poolCash = pool.freeLiquidity();
        book.fundClaims();
        assertEq(pool.freeLiquidity(), poolCash + 21_000e6, "IF back in the pool");
        assertEq(pool.bookPosition(BOOK_ID).claim, 0);
        assertEq(pool.bookPosition(BOOK_ID).allocation, 4_000e6, "the bad debt stays the pool's loss");
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_MM, 75_000e6);
        _applyPoolMark(); // deployed 0
        book.finalizeRetirement();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Retired));
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s + j, 75_000e6, "tranches keep exactly the MM");
        assertEq(vault.idle(), 75_000e6);
    }

    function test_retirement_poolPaidBeforeTrancheClaims() public {
        _goLivePool();
        charterC.retire(BOOK_ID);
        // MM back first; the IF recall makes the claim due: fundClaims pays the pool before any tranche claim
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_MM, 20_000e6);
        vm.prank(alice);
        senior.requestRedeem(30_000e6, alice, alice); // alice holds 30k of the 52.5k Senior
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_IF, 25_000e6);
        _applyPoolMark(); // settles alice's bucket; fundClaims: pool 25k first, then alice from what is left
        assertEq(pool.bookPosition(BOOK_ID).claim, 0, "pool repaid in full");
        assertEq(book.unfundedOf(BRTypes.SENIOR), 30_000e6 - 20_000e6, "Senior waits for the rest of the MM");
        _identity();
    }

    /// @notice A pool that refuses the repayment never blocks marks, retirement or tranche exits: the due claim stays
    ///         owed and its cash reserved, the tranches are paid from the rest.
    function test_poolRepayFails_neverBlocksMarksOrExits() public {
        _goLivePool();
        charterC.retire(BOOK_ID);
        vm.prank(alice);
        senior.requestRedeem(30_000e6, alice, alice);
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_IF, 25_000e6);
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_MM, 75_000e6);
        vm.mockCallRevert(address(pool), abi.encodeWithSelector(InsurancePool.repay.selector), "down");
        _applyPoolMark();
        (uint256 claim,) = _claim();
        assertEq(claim, 25_000e6, "still owed");
        assertEq(book.unfundedOf(BRTypes.SENIOR), 0, "alice funded from the rest");
        assertEq(vault.idle(), 100_000e6 - 30_000e6, "the pool's 25k stays reserved in the vault");
        vm.prank(alice);
        senior.claimRedemption(alice, alice);
        book.finalizeRetirement();
        assertEq(uint8(book.state()), uint8(BRTypes.BookState.Retired));
        (claim,) = _claim();
        assertEq(claim, 25_000e6, "no write-off while the vault holds it");
        vm.clearMockedCalls();
        book.fundClaims();
        (claim,) = _claim();
        assertEq(claim, 0, "repaid on the next fundClaims");
    }

    function test_finalize_writesOffWhatTheVaultCannotRepay() public {
        _goLivePool();
        charterC.retire(BOOK_ID);
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_IF, 1); // the IF recall starts: claim due (25k)
        venue.setIfEquity(0); // lost on the venue after the recall started: the book's
        venue.setMmValue(0); // and the MM is gone too
        _applyPoolMark();
        vm.expectEmit(true, false, false, true, address(book));
        emit Book.InsuranceWrittenOff(BOOK_ID, 25_000e6 - 1);
        book.finalizeRetirement();
        (uint256 claim,) = _claim();
        assertEq(claim, 0);
        assertEq(pool.bookPosition(BOOK_ID).claim, 0);
        assertEq(pool.bookPosition(BOOK_ID).allocation, 25_000e6 - 1, "written off as the pool's loss");
    }

    function test_finalize_withoutIfRecall_closesClaim() public {
        _goLivePool();
        venue.setIfEquity(0); // the whole IF went to bad debt while Live: claim 0
        _applyPoolMark();
        charterC.retire(BOOK_ID);
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_MM, 75_000e6);
        _applyPoolMark();
        book.finalizeRetirement();
        (uint256 claim, bool due) = _claim();
        assertEq(claim, 0);
        assertTrue(due);
        assertEq(pool.firstLossAssets(), POOL_FIRST_LOSS - 25_000e6);
    }

    // ------------------------------------------------------------------ the old way

    function test_bookFundedTheOldWay_unchanged() public {
        _deployPoolBook(_defaultCharter()); // ifFromPool false
        _subscribeDefault();
        vm.warp(book.subscriptionEnds());
        book.closeWindow();
        (uint256 s, uint256 j) = book.trancheNav();
        assertEq(s + j, 100_000e6, "IF + MM raised from the tranches");
        assertEq(venue.ifEquity(), 25_000e6);
        assertEq(book.insurancePool(), address(0));
        assertEq(pool.bookPosition(BOOK_ID).book, address(0), "no allocation");
        (address p,,) = rrouter.previewPremium(10_000e6);
        assertEq(p, address(0), "no premium");
        _applyPoolMark();
        (s, j) = book.trancheNav();
        assertEq(s + j, 100_000e6, "IF in the NAV as before");
        // the IF stays the book's: recall works while Live
        vm.prank(keeper);
        vault.recall(BRTypes.ACCOUNT_IF, 1_000e6);
    }

    /// @notice The charter's new fields share the slot of takerFeeBps / makerFeeBps: Charter keeps its 11 slots, so
    ///         everything after it in Book's ERC-7201 storage (components, state, ...) stays where it was, and a book
    ///         stored before reads ifFromPool = false, premiumBps = 0 (funded the old way).
    function test_charterStorageSizeUnchanged() public {
        _goLivePool();
        bytes32 loc = 0xafd306892a6154f35c973e251e6b4f2659d2ae19802986651fcc8ec3ae5c4c00;
        // BookStorage: config (0), bookId (1), charter (2..12), components (13..20): book, senior, ...
        assertEq(address(uint160(uint256(vm.load(address(book), bytes32(uint256(loc) + 13))))), address(book));
        assertEq(address(uint160(uint256(vm.load(address(book), bytes32(uint256(loc) + 14))))), address(senior));
        // the last charter slot (12): takerFeeBps | makerFeeBps << 16 | ifFromPool << 32 | premiumBps << 40
        uint256 last = uint256(vm.load(address(book), bytes32(uint256(loc) + 12)));
        assertEq((last >> 32) & 0xff, 1, "ifFromPool packed after the fee fields");
        // clearing the new bytes reads as a book funded the old way
        vm.store(address(book), bytes32(uint256(loc) + 12), bytes32(last & 0xffffffff));
        BRTypes.Charter memory c = book.getCharter();
        assertFalse(c.ifFromPool);
        assertEq(c.premiumBps, 0);
    }

    function test_initialize_rejectsPremiumAbove100pct() public {
        BRTypes.Charter memory c = _poolCharter();
        c.premiumBps = 10_001;
        BRTypes.BookComponents memory comps = book.components();
        comps.book = address(0);
        bytes memory init = abi.encodeCall(Book.initialize, (address(cfg), 2, c, comps));
        vm.expectRevert(Book.BadCharter.selector);
        new ERC1967Proxy(address(bookImpl), init);
    }

    // ------------------------------------------------------------------ helpers

    /// @dev Book identity for a pool-funded book at an applied mark: S + J + unfundedClaims + (claim not yet due)
    ///      == vault idle + deployed (CAP-3 with the pool's claim).
    function _identity() internal view {
        (uint256 s, uint256 j) = book.trancheNav();
        (uint256 claim, bool due) = _claim();
        assertEq(
            s + j + book.unfundedClaims() + (due ? 0 : claim),
            vault.idle() + venue.deployedValueUsd(),
            "identity with the pool's claim"
        );
    }
}

/// @dev IRevenueRouter.Amounts view through the router's previewSplit (avoids importing the frozen interface twice).
interface IRevenueRouterAmounts {
    struct Amounts {
        uint256 gross;
        uint256 expenses;
        uint256 carry;
        uint256 senior;
        uint256 junior;
    }

    function previewSplit(uint256 gross, uint256 expensesRequested) external view returns (Amounts memory);
}
